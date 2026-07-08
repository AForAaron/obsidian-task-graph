export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'canceled' | 'custom';
export type TaskPriority = 'highest' | 'high' | 'medium' | 'low' | 'lowest';
export type TaskReadiness = 'ready' | 'blocked' | 'active' | 'finished';
export type TaskWarning = 'missing-id' | 'duplicate-id' | 'missing-reference' | 'cycle';

export interface TaskNode {
	/** Internal node identity. Never use this value in Markdown relationships. */
	id: string;
	/** Stable Markdown Tasks ID from the 🆔 field. */
	taskId?: string;
	stableId: boolean;
	text: string;
	rawBody: string;
	status: TaskStatus;
	statusMarker: string;
	path: string;
	line: number;
	headingPath: string[];
	tags: string[];
	blockedByIds: string[];
	priority?: TaskPriority;
	createdDate?: string;
	startDate?: string;
	scheduledDate?: string;
	dueDate?: string;
	completionDate?: string;
	starred: boolean;
	documentLinks: string[];
}

export interface TaskEdge {
	id: string;
	sourceId: string;
	targetId: string;
	missing: boolean;
}

export interface DerivedTaskNode extends TaskNode {
	readiness: TaskReadiness;
	unresolvedDependencyIds: string[];
	dependentIds: string[];
	warnings: TaskWarning[];
}

export interface TaskGraphData {
	nodes: DerivedTaskNode[];
	edges: TaskEdge[];
}

export interface PositionedTaskNode extends DerivedTaskNode {
	x: number;
	y: number;
	width: number;
	height: number;
	layer: number;
	/** Weakly connected task component used to keep independent trees in separate lanes. */
	layoutGroup: number;
}

export interface DocumentNode {
	id: string;
	nodeType: 'document';
	path: string;
	title: string;
	excerpt: string;
	wordCount: number;
	checklistDone: number;
	checklistTotal: number;
	mtime: number;
	linkedTaskIds: string[];
	missing: boolean;
}

export interface PositionedDocumentNode extends DocumentNode {
	x: number;
	y: number;
	width: number;
	height: number;
	layer: number;
}

export type PositionedGraphNode = PositionedTaskNode | PositionedDocumentNode;

export interface DocumentEdge {
	id: string;
	taskNodeId: string;
	documentNodeId: string;
}

export interface NodePosition {
	x: number;
	y: number;
}

export interface ViewportState {
	x: number;
	y: number;
	scale: number;
}

export type MapSource =
	| { type: 'file'; path: string }
	| { type: 'folder'; path: string; recursive: true };

export interface MapDocumentConfig {
	path: string;
	expanded: boolean;
}

export interface TaskMapConfig {
	id: string;
	name: string;
	sources: MapSource[];
	nodePositions: Record<string, NodePosition>;
	viewport: ViewportState;
	documents: MapDocumentConfig[];
}

export interface TaskGraphPluginData {
	version: 3;
	maps: TaskMapConfig[];
	activeMapId: string;
	showCompleted: boolean;
	sourcePanelCollapsed: boolean;
}

export const DEFAULT_VIEWPORT: ViewportState = { x: 24, y: 24, scale: 1 };

export function createTaskMap(name = '我的任务地图', sources: MapSource[] = []): TaskMapConfig {
	return {
		id: `map-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		name,
		sources,
		nodePositions: {},
		viewport: { ...DEFAULT_VIEWPORT },
		documents: [],
	};
}

const initialMap = createTaskMap();

export const DEFAULT_PLUGIN_DATA: TaskGraphPluginData = {
	version: 3,
	maps: [initialMap],
	activeMapId: initialMap.id,
	showCompleted: true,
	sourcePanelCollapsed: false,
};
