import { DerivedTaskNode, PositionedTaskNode, TaskEdge } from '../model/TaskGraphModel';

const NODE_WIDTH = 224;
const NODE_HEIGHT = 116;
const COLUMN_GAP = 104;
const ROW_GAP = 34;
const PADDING = 72;
const ISOLATED_COLUMNS = 3;
const COMPONENT_GAP = 120;

export interface LayoutResult {
	nodes: PositionedTaskNode[];
	width: number;
	height: number;
}

function compareTaskOrder(a: DerivedTaskNode, b: DerivedTaskNode): number {
	if (a.createdDate && b.createdDate && a.createdDate !== b.createdDate) {
		return a.createdDate.localeCompare(b.createdDate);
	}
	if (a.createdDate !== b.createdDate) return a.createdDate ? -1 : 1;
	return a.path.localeCompare(b.path, 'zh-CN') || a.line - b.line;
}

export function layoutGraph(nodes: DerivedTaskNode[], edges: TaskEdge[]): LayoutResult {
	if (nodes.length === 0) return { nodes: [], width: 800, height: 600 };
	const visibleIds = new Set(nodes.map((node) => node.id));
	const validEdges = edges.filter((edge) => (
		!edge.missing && visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId)
	));
	const relatedIds = new Set<string>();
	validEdges.forEach((edge) => {
		relatedIds.add(edge.sourceId);
		relatedIds.add(edge.targetId);
	});
	const connected = nodes.filter((node) => relatedIds.has(node.id));
	const isolated = nodes
		.filter((node) => !relatedIds.has(node.id))
		.sort(compareTaskOrder);
	const cycleIds = new Set(nodes.filter((node) => node.warnings.includes('cycle')).map((node) => node.id));

	const positioned: PositionedTaskNode[] = [];
	const nodeById = new Map(connected.map((node) => [node.id, node]));
	const neighbors = new Map(connected.map((node) => [node.id, [] as string[]]));
	validEdges.forEach((edge) => {
		neighbors.get(edge.sourceId)?.push(edge.targetId);
		neighbors.get(edge.targetId)?.push(edge.sourceId);
	});
	const remaining = new Set(connected.map((node) => node.id));
	const components: DerivedTaskNode[][] = [];
	while (remaining.size > 0) {
		const start = remaining.values().next().value as string;
		const pending = [start];
		const component: DerivedTaskNode[] = [];
		while (pending.length > 0) {
			const id = pending.pop()!;
			if (!remaining.delete(id)) continue;
			const node = nodeById.get(id);
			if (node) component.push(node);
			pending.push(...(neighbors.get(id) ?? []));
		}
		component.sort(compareTaskOrder);
		components.push(component);
	}
	components.sort((a, b) => compareTaskOrder(a[0], b[0]));

	let componentTop = PADDING;
	components.forEach((component, layoutGroup) => {
		const componentIds = new Set(component.map((node) => node.id));
		const componentEdges = validEdges.filter((edge) => (
			componentIds.has(edge.sourceId) && componentIds.has(edge.targetId)
		));
		const incoming = new Map(component.map((node) => [node.id, [] as string[]]));
		componentEdges
			.filter((edge) => !cycleIds.has(edge.sourceId) && !cycleIds.has(edge.targetId))
			.forEach((edge) => incoming.get(edge.targetId)?.push(edge.sourceId));

		const layerById = new Map<string, number>();
		const resolveLayer = (id: string): number => {
			const existing = layerById.get(id);
			if (existing !== undefined) return existing;
			const dependencies = incoming.get(id) ?? [];
			const layer = dependencies.length === 0
				? 0
				: Math.max(...dependencies.map((dependencyId) => resolveLayer(dependencyId))) + 1;
			layerById.set(id, layer);
			return layer;
		};
		component.filter((node) => !cycleIds.has(node.id)).forEach((node) => resolveLayer(node.id));
		const maxNormalLayer = Math.max(0, ...Array.from(layerById.values()));
		component.filter((node) => cycleIds.has(node.id)).forEach((node) => {
			layerById.set(node.id, maxNormalLayer + 1);
		});

		const layers = new Map<number, DerivedTaskNode[]>();
		component.forEach((node) => {
			const layer = layerById.get(node.id) ?? 0;
			const values = layers.get(layer) ?? [];
			values.push(node);
			layers.set(layer, values);
		});
		const branchOrderById = new Map<string, number>();
		Array.from(layers.keys()).sort((a, b) => a - b).forEach((layer) => {
			const values = layers.get(layer)!;
			values.sort((a, b) => {
				const parentOrder = (node: DerivedTaskNode): number => {
					const orders = (incoming.get(node.id) ?? [])
						.map((parentId) => branchOrderById.get(parentId))
						.filter((order): order is number => order !== undefined);
					return orders.length > 0
						? orders.reduce((sum, order) => sum + order, 0) / orders.length
						: Number.MAX_SAFE_INTEGER;
				};
				return parentOrder(a) - parentOrder(b) || compareTaskOrder(a, b);
			});
			values.forEach((node, index) => branchOrderById.set(node.id, index));
		});

		const maxRows = Math.max(1, ...Array.from(layers.values(), (values) => values.length));
		const componentHeight = maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
		layers.forEach((values, layer) => {
			const layerHeight = values.length * NODE_HEIGHT + Math.max(0, values.length - 1) * ROW_GAP;
			const startY = componentTop + (componentHeight - layerHeight) / 2;
			values.forEach((node, index) => positioned.push({
				...node,
				x: PADDING + layer * (NODE_WIDTH + COLUMN_GAP),
				y: startY + index * (NODE_HEIGHT + ROW_GAP),
				width: NODE_WIDTH,
				height: NODE_HEIGHT,
				layer,
				layoutGroup,
			}));
		});
		componentTop += componentHeight + COMPONENT_GAP;
	});

	const connectedBottom = components.length > 0 ? componentTop - COMPONENT_GAP : PADDING;
	const isolatedStartY = connectedBottom + (components.length > 0 && isolated.length > 0 ? 96 : 0);
	isolated.forEach((node, index) => {
		const column = index % ISOLATED_COLUMNS;
		const row = Math.floor(index / ISOLATED_COLUMNS);
		positioned.push({
			...node,
			x: PADDING + column * (NODE_WIDTH + COLUMN_GAP),
			y: isolatedStartY + row * (NODE_HEIGHT + ROW_GAP),
			width: NODE_WIDTH,
			height: NODE_HEIGHT,
			layer: -1,
			layoutGroup: components.length,
		});
	});

	const maxX = Math.max(...positioned.map((node) => node.x + node.width));
	const maxY = Math.max(...positioned.map((node) => node.y + node.height));
	return {
		nodes: positioned,
		width: Math.max(800, maxX + PADDING),
		height: Math.max(600, maxY + PADDING),
	};
}
