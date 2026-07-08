import {
	DocumentNode,
	PositionedDocumentNode,
	PositionedTaskNode,
} from '../model/TaskGraphModel';
import { LayoutResult } from './LayeredLayout';

const DOCUMENT_WIDTH = 224;
const DOCUMENT_HEIGHT = 112;
const DOCUMENT_GAP = 24;
const CONTENT_OFFSET = 52;
const TASK_UNIT_GAP = 46;
const COLLISION_GAP = 24;
const PADDING = 72;
const COMPONENT_CONTENT_GAP = 120;

export interface TaskDocumentLayout {
	tasks: PositionedTaskNode[];
	documents: PositionedDocumentNode[];
	width: number;
	height: number;
}

function overlaps(
	position: { x: number; y: number },
	nodes: Array<{ x: number; y: number; width: number; height: number }>,
): boolean {
	return nodes.some((node) => (
		position.x < node.x + node.width + COLLISION_GAP
		&& position.x + DOCUMENT_WIDTH + COLLISION_GAP > node.x
		&& position.y < node.y + node.height + COLLISION_GAP
		&& position.y + DOCUMENT_HEIGHT + COLLISION_GAP > node.y
	));
}

/**
 * Treats each task and its private documents as one vertical layout unit.
 * This keeps content directly beneath its owner instead of collecting all
 * content cards in an ambiguous lane below the entire graph.
 */
export function layoutTaskDocuments(
	taskLayout: LayoutResult,
	allDocuments: DocumentNode[],
	expandedPaths: Set<string>,
	reserveTaskSpace = true,
): TaskDocumentLayout {
	const visibleDocuments = allDocuments
		.filter((document) => expandedPaths.has(document.path))
		.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
	const visibleTaskIds = new Set(taskLayout.nodes.map((node) => node.id));
	const privateDocuments = new Map<string, DocumentNode[]>();
	const sharedDocuments: DocumentNode[] = [];
	const standaloneDocuments: DocumentNode[] = [];

	visibleDocuments.forEach((document) => {
		const linkedIds = document.linkedTaskIds.filter((id) => visibleTaskIds.has(id));
		if (linkedIds.length === 1) {
			const documents = privateDocuments.get(linkedIds[0]) ?? [];
			documents.push(document);
			privateDocuments.set(linkedIds[0], documents);
		} else if (linkedIds.length > 1) {
			sharedDocuments.push(document);
		} else {
			standaloneDocuments.push(document);
		}
	});

	const tasks = taskLayout.nodes.map((node) => ({ ...node }));
	if (reserveTaskSpace) {
		const layers = new Map<string, PositionedTaskNode[]>();
		tasks.forEach((task) => {
			const key = `${task.layoutGroup}:${task.layer}`;
			const layer = layers.get(key) ?? [];
			layer.push(task);
			layers.set(key, layer);
		});
		layers.forEach((layer) => {
			layer.sort((a, b) => a.y - b.y);
			let cursor = layer[0]?.y ?? PADDING;
			layer.forEach((task) => {
				task.y = Math.max(task.y, cursor);
				const documentCount = privateDocuments.get(task.id)?.length ?? 0;
				const contentHeight = documentCount > 0
					? CONTENT_OFFSET + documentCount * DOCUMENT_HEIGHT
						+ Math.max(0, documentCount - 1) * DOCUMENT_GAP
					: 0;
				cursor = task.y + task.height + contentHeight + TASK_UNIT_GAP;
			});
		});

		const componentBounds = new Map<number, { minY: number; maxY: number }>();
		tasks.forEach((task) => {
			const documentCount = privateDocuments.get(task.id)?.length ?? 0;
			const contentBottom = documentCount > 0
				? task.y + task.height + CONTENT_OFFSET
					+ documentCount * DOCUMENT_HEIGHT
					+ Math.max(0, documentCount - 1) * DOCUMENT_GAP
				: task.y + task.height;
			const bounds = componentBounds.get(task.layoutGroup);
			componentBounds.set(task.layoutGroup, {
				minY: Math.min(bounds?.minY ?? task.y, task.y),
				maxY: Math.max(bounds?.maxY ?? contentBottom, contentBottom),
			});
		});
		let cursor = PADDING;
		Array.from(componentBounds.entries())
			.sort((a, b) => a[1].minY - b[1].minY)
			.forEach(([layoutGroup, bounds]) => {
				const shift = Math.max(0, cursor - bounds.minY);
				if (shift > 0) {
					tasks
						.filter((task) => task.layoutGroup === layoutGroup)
						.forEach((task) => { task.y += shift; });
				}
				cursor = bounds.maxY + shift + COMPONENT_CONTENT_GAP;
			});
	}

	const taskById = new Map(tasks.map((task) => [task.id, task]));
	const documents: PositionedDocumentNode[] = [];
	const taskUnitBottom = new Map(tasks.map((task) => [task.id, task.y + task.height]));

	privateDocuments.forEach((linkedDocuments, taskId) => {
		const task = taskById.get(taskId);
		if (!task) return;
		linkedDocuments.forEach((document, index) => {
			const y = task.y + task.height + CONTENT_OFFSET
				+ index * (DOCUMENT_HEIGHT + DOCUMENT_GAP);
			documents.push({
				...document,
				x: task.x,
				y,
				width: DOCUMENT_WIDTH,
				height: DOCUMENT_HEIGHT,
				layer: task.layer,
			});
			taskUnitBottom.set(task.id, y + DOCUMENT_HEIGHT);
		});
	});

	const occupied: Array<{ x: number; y: number; width: number; height: number }> = [
		...tasks,
		...documents,
	];
	sharedDocuments.forEach((document) => {
		const linked = document.linkedTaskIds
			.map((id) => taskById.get(id))
			.filter((node): node is PositionedTaskNode => Boolean(node));
		const centerX = linked.reduce((sum, node) => sum + node.x + node.width / 2, 0) / linked.length;
		const anchorBottom = Math.max(...linked.map((node) => taskUnitBottom.get(node.id) ?? node.y + node.height));
		let position = {
			x: centerX - DOCUMENT_WIDTH / 2,
			y: anchorBottom + CONTENT_OFFSET,
		};
		for (let attempt = 0; attempt < 60 && overlaps(position, occupied); attempt += 1) {
			position = { ...position, y: position.y + DOCUMENT_HEIGHT + DOCUMENT_GAP };
		}
		const positioned = {
			...document,
			x: Math.max(24, position.x),
			y: Math.max(24, position.y),
			width: DOCUMENT_WIDTH,
			height: DOCUMENT_HEIGHT,
			layer: -2,
		};
		documents.push(positioned);
		occupied.push(positioned);
	});

	const graphBottom = Math.max(
		taskLayout.height,
		...occupied.map((node) => node.y + node.height),
	) + CONTENT_OFFSET;
	standaloneDocuments.forEach((document, index) => {
		const positioned = {
			...document,
			x: PADDING + (index % 3) * (DOCUMENT_WIDTH + 104),
			y: graphBottom + Math.floor(index / 3) * (DOCUMENT_HEIGHT + DOCUMENT_GAP),
			width: DOCUMENT_WIDTH,
			height: DOCUMENT_HEIGHT,
			layer: -3,
		};
		documents.push(positioned);
		occupied.push(positioned);
	});

	const maxX = Math.max(800 - PADDING, ...occupied.map((node) => node.x + node.width));
	const maxY = Math.max(600 - PADDING, ...occupied.map((node) => node.y + node.height));
	return {
		tasks,
		documents,
		width: maxX + PADDING,
		height: maxY + PADDING,
	};
}
