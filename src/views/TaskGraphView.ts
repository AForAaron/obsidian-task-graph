import {
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	Notice,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
	setIcon,
} from 'obsidian';
import TaskGraphPlugin from '../main';
import { GraphCanvas } from '../components/GraphCanvas';
import { CanvasLayout } from '../components/GraphCanvas';
import {
	chooseMarkdownFile,
	chooseTaskTarget,
	confirmAction,
	openSourcePicker,
	renderSourceTree,
	requestMapName,
	requestTextValue,
	TaskTarget,
} from '../components/TaskGraphModals';
import {
	DerivedTaskNode,
	DocumentEdge,
	DocumentNode,
	MapSource,
	NodePosition,
	PositionedTaskNode,
	PositionedDocumentNode,
	PositionedGraphNode,
	TaskGraphData,
	TaskMapConfig,
	TaskNode,
	TaskStatus,
	ViewportState,
	createTaskMap,
} from '../model/TaskGraphModel';
import { parseTaskFile, taskPositionKey } from '../services/TaskParser';
import { buildTaskGraph } from '../services/GraphBuilder';
import { LayoutResult, layoutGraph } from '../layout/LayeredLayout';
import { layoutTaskDocuments } from '../layout/DocumentLayout';
import {
	mapContainsPath,
	resolveMapSources,
	toggleSource,
} from '../services/MapSourceResolver';
import { getTasksApi } from '../services/TasksApi';
import { renamePathValue } from '../services/PluginData';
import { ensureTaskId, replaceTaskId } from '../services/TaskLineMetadata';
import {
	appendTaskLine,
	assignTaskId,
	changeTaskTag,
	changeTaskDocumentLink,
	changeTaskDocumentLinks,
	connectTasks,
	createPredecessorTask,
	createSuccessorTask,
	createTaskId,
	deleteTaskAndReferences,
	findTaskLine,
	markTaskInProgress,
	normalizeTaskLine,
	prepareNewTaskLine,
	removeTaskRelationship,
	repairTaskIds,
	replaceTaskLine,
	renameTaskDocumentLinks,
	setTaskStar,
} from '../services/TaskWriter';
import {
	buildDocumentEdges,
	calculateDocumentStats,
	collectDocumentPaths,
	contentFolderForFile,
	createContentDocument,
	documentPositionKey,
	loadDocumentNodes,
	moveContentDocumentBesideTask,
	registerDocument,
	removeRegisteredDocument,
	replaceRegisteredDocumentPath,
	resolveDocumentPath,
	sanitizeDocumentTitle,
	uniqueDocumentPath,
} from '../services/ContentDocuments';
import {
	HistoryConflictError,
	HistoryEntry,
	HistoryManager,
	HistoryMapState,
	HistorySnapshot,
} from '../services/HistoryManager';

export const TASK_GRAPH_VIEW = 'task-graph-view';

const STATUS_LABELS: Record<TaskStatus, string> = {
	todo: '待办',
	in_progress: '进行中',
	done: '已完成',
	canceled: '已取消',
	custom: '自定义',
};

interface PendingHistory {
	mapId: string;
	label: string;
	before: HistorySnapshot;
	mapIds: string[];
	autoPaths: boolean;
	vaultWide: boolean;
	coalesceKey?: string;
}

export class TaskGraphView extends ItemView {
	private readonly plugin: TaskGraphPlugin;
	private graphCanvas: GraphCanvas | null = null;
	private toolbarEl: HTMLElement;
	private sourcePanelEl: HTMLElement;
	private sourceSummaryEl: HTMLElement;
	private sourceTreeEl: HTMLElement;
	private currentFileEl: HTMLElement;
	private inspectorEl: HTMLElement;
	private statusBarEl: HTMLElement;
	private mapSelectEl: HTMLSelectElement;
	private searchInputEl: HTMLInputElement;
	private sourceSearchEl: HTMLInputElement;
	private collapseButton: HTMLButtonElement;
	private taskCache = new Map<string, TaskNode[]>();
	private graphData: TaskGraphData = { nodes: [], edges: [] };
	private documentNodes: DocumentNode[] = [];
	private documentEdges: DocumentEdge[] = [];
	private documentLinkAliases = new Map<string, Map<string, string[]>>();
	private currentFilePath = '';
	private selectedId: string | null = null;
	private searchQuery = '';
	private sourceQuery = '';
	private enabledStatuses = new Set<TaskStatus>(['todo', 'in_progress', 'done', 'canceled', 'custom']);
	private refreshTimer: number | null = null;
	private saveTimer: number | null = null;
	private shouldFitAfterRender = false;
	private expandedSourceFolders = new Set<string>();
	private documentSaveTimer: number | null = null;
	private editorDocumentPath = '';
	private editorLoadedMtime = 0;
	private editorDirty = false;
	private editorValue = '';
	private editorBaseContent = '';
	private ignoreDocumentModifyUntil = 0;
	private editorLoadGeneration = 0;
	private documentSavePromise: Promise<void> | null = null;
	private reloadGeneration = 0;
	private readonly history = new HistoryManager(50);
	private undoButton: HTMLButtonElement;
	private redoButton: HTMLButtonElement;

	constructor(leaf: WorkspaceLeaf, plugin: TaskGraphPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return TASK_GRAPH_VIEW;
	}

	getDisplayText(): string {
		return 'Task Graph';
	}

	getIcon(): string {
		return 'git-fork';
	}

	private get activeMap(): TaskMapConfig {
		return this.plugin.getActiveMap();
	}

	async onOpen(): Promise<void> {
		if (!this.plugin.data.showCompleted) {
			this.enabledStatuses.delete('done');
		}
		this.contentEl.empty();
		this.contentEl.addClass('tgf-container');
		this.toolbarEl = this.contentEl.createDiv('tgf-toolbar');
		const body = this.contentEl.createDiv('tgf-body');
		this.sourcePanelEl = body.createEl('aside', { cls: 'tgf-source-panel' });
		const canvasHost = body.createDiv('tgf-canvas-host');
		this.inspectorEl = body.createEl('aside', { cls: 'tgf-inspector' });
		this.statusBarEl = this.contentEl.createDiv('tgf-statusbar');

		this.buildToolbar();
		this.buildSourcePanel();
		this.graphCanvas = new GraphCanvas(canvasHost, {
				onSelect: (node) => void this.selectGraphNode(node),
			onOpen: (node) => void this.openTask(node),
			onToggle: (node) => void this.toggleTask(node),
			onEdit: (node) => void this.editTask(node),
			onCreateSuccessor: (node, position) => void this.createSuccessor(node, position),
			onCreatePredecessor: (node, position) => void this.createPredecessor(node, position),
			onConnect: (parent, child) => void this.connectNodes(parent, child),
			onRemoveRelationship: (parent, child) => void this.removeRelationship(parent, child),
			onDelete: (node) => void this.deleteTask(node),
			onToggleStar: (node) => void this.toggleStar(node),
			onNodeMove: (node, position) => this.saveNodePosition(node, position),
			onViewportChange: (viewport) => this.saveViewport(viewport),
			onCreateAt: (position) => void this.createTask(undefined, position),
			onCreateDocumentAt: (position) => void this.createStandaloneDocument(position),
			onCreateDocumentForTask: (node, position) => void this.createDocumentForTask(node, position),
			onLinkDocument: (node, document) => void this.linkDocumentToTask(node, document),
			onOpenDocument: (document) => void this.openDocument(document),
			onEditDocument: (document) => this.selectDocument(document),
			onRemoveDocument: (document) => void this.removeDocumentFromCanvas(document),
		});

		this.registerEvent(this.app.vault.on('modify', (file) => {
			const isDocument = file instanceof TFile
				&& this.activeMap.documents.some((document) => document.path === file.path);
			if (isDocument && Date.now() < this.ignoreDocumentModifyUntil) return;
			if (
				isDocument
				&& file.path === this.editorDocumentPath
				&& this.editorDirty
				&& file.stat.mtime > this.editorLoadedMtime
			) {
				void this.handleEditorDocumentModified(file);
				return;
			}
			if (isDocument) {
				this.scheduleReload();
				return;
			}
			if (file instanceof TFile && file.extension === 'md' && mapContainsPath(this.activeMap, file.path)) {
				this.scheduleReload();
			}
		}));
		this.registerEvent(this.app.vault.on('delete', () => this.scheduleReload()));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			this.handleRenamedPath(oldPath, file.path);
			void this.syncRenamedDocumentReferences(oldPath, file.path).finally(() => {
				this.scheduleReload();
			});
		}));
		this.registerEvent(this.app.vault.on('create', (file) => {
			if (file instanceof TFile && file.extension === 'md' && mapContainsPath(this.activeMap, file.path)) {
				this.scheduleReload();
			}
		}));
		this.registerDomEvent(this.contentEl, 'keydown', (event: KeyboardEvent) => {
			if (this.isTextEditingTarget(event.target)) return;
			const key = event.key.toLocaleLowerCase();
			const modifier = event.metaKey || event.ctrlKey;
			const redo = modifier && (key === 'y' || (key === 'z' && event.shiftKey));
			const undo = modifier && key === 'z' && !event.shiftKey;
			if (!undo && !redo) return;
			event.preventDefault();
			if (redo) void this.redo();
			else void this.undo();
		});

		await this.reloadMap();
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			await this.plugin.persistData();
		}
		if (!await this.flushDocumentEditor()) {
			await this.preserveUnsavedDocumentDraft();
		}
		this.graphCanvas?.destroy();
	}

	private buildToolbar(): void {
		const primary = this.toolbarEl.createDiv('tgf-toolbar-row tgf-toolbar-primary');
		const secondary = this.toolbarEl.createDiv('tgf-toolbar-row tgf-toolbar-secondary');
		const brand = primary.createDiv('tgf-brand');
		const brandIcon = brand.createSpan('tgf-brand-icon');
		setIcon(brandIcon, 'git-fork');
		const brandText = brand.createDiv();
		brandText.createDiv({ cls: 'tgf-brand-title', text: 'Task Graph' });
		brandText.createDiv({ cls: 'tgf-brand-subtitle', text: '可编辑任务地图' });

		const mapField = primary.createDiv('tgf-map-field');
		this.mapSelectEl = mapField.createEl('select', { cls: 'dropdown' });
		this.mapSelectEl.addEventListener('change', () => void this.switchMap(this.mapSelectEl.value));
		this.createIconButton(mapField, 'plus', '新建地图', () => void this.createMap());
		this.createIconButton(mapField, 'pencil', '重命名地图', () => void this.renameMap());
		this.createIconButton(mapField, 'trash-2', '删除地图', () => void this.deleteMap());

		const primaryActions = primary.createDiv('tgf-primary-actions');
		this.createTextButton(primaryActions, 'folder-cog', '来源', () => void this.manageSources());
		this.createTextButton(primaryActions, 'plus', '新建任务', () => void this.createTask());
		this.createTextButton(primaryActions, 'file-plus-2', '新建内容', () => void this.createStandaloneDocument());
		this.createTextButton(primaryActions, 'layout-dashboard', '规整', () => void this.organizeGraph());

		const searchField = secondary.createDiv('tgf-search');
		const searchIcon = searchField.createSpan('tgf-search-icon');
		setIcon(searchIcon, 'search');
		this.searchInputEl = searchField.createEl('input', {
			type: 'search',
			placeholder: '搜索任务、内容、标签或 ID',
		});
		this.searchInputEl.addEventListener('input', () => {
			this.searchQuery = this.searchInputEl.value.trim().toLocaleLowerCase();
			this.renderGraph();
		});

		const statusGroup = secondary.createDiv('tgf-status-filter');
			(['todo', 'in_progress', 'done', 'canceled', 'custom'] as TaskStatus[]).forEach((status) => {
				const button = statusGroup.createEl('button', {
					cls: `tgf-filter-chip${this.enabledStatuses.has(status) ? ' is-active' : ''}`,
					text: STATUS_LABELS[status],
				});
			button.addEventListener('click', () => {
				if (this.enabledStatuses.has(status)) {
					this.enabledStatuses.delete(status);
					button.removeClass('is-active');
				} else {
					this.enabledStatuses.add(status);
					button.addClass('is-active');
					}
					if (status === 'done') {
						this.plugin.data.showCompleted = this.enabledStatuses.has('done');
						this.queueSave();
					}
					this.renderGraph();
				});
		});

		const actions = secondary.createDiv('tgf-toolbar-actions');
		this.undoButton = this.createIconButton(actions, 'undo-2', '撤销', () => void this.undo());
		this.redoButton = this.createIconButton(actions, 'redo-2', '重做', () => void this.redo());
		this.createIconButton(actions, 'minus', '缩小', () => this.graphCanvas?.zoomBy(0.85));
		this.createIconButton(actions, 'plus', '放大', () => this.graphCanvas?.zoomBy(1.15));
		this.createIconButton(actions, 'scan', '适应画布', () => this.graphCanvas?.fitView());
		this.createIconButton(actions, 'refresh-cw', '重新读取任务', () => void this.reloadMap());
		this.updateHistoryButtons();
		this.populateMapOptions();
	}

	private buildSourcePanel(): void {
		const header = this.sourcePanelEl.createDiv('tgf-panel-header');
		const title = header.createDiv();
		title.createDiv({ cls: 'tgf-panel-title', text: '来源与任务' });
		title.createDiv({ cls: 'tgf-panel-subtitle', text: '勾选地图内容，点击文件设为当前文件' });
		this.collapseButton = this.createIconButton(header, 'panel-left-close', '折叠来源面板', () => {
			this.plugin.data.sourcePanelCollapsed = !this.plugin.data.sourcePanelCollapsed;
			this.applyPanelCollapsed();
			this.queueSave();
		});

		const searchWrap = this.sourcePanelEl.createDiv('tgf-source-search');
		setIcon(searchWrap.createSpan(), 'search');
		this.sourceSearchEl = searchWrap.createEl('input', {
			type: 'search',
			placeholder: '搜索 Vault 文件树',
		});
		this.sourceSearchEl.addEventListener('input', () => {
			this.sourceQuery = this.sourceSearchEl.value;
			this.renderSourcePanel();
		});
		this.sourceSummaryEl = this.sourcePanelEl.createDiv('tgf-source-summary');
		const treeHeading = this.sourcePanelEl.createDiv('tgf-source-tree-heading');
		treeHeading.createSpan({ text: 'Vault 文件树' });
		treeHeading.createSpan({ text: '勾选来源 · 点击文件切换' });
		this.sourceTreeEl = this.sourcePanelEl.createDiv('tgf-source-tree');
		this.currentFileEl = this.sourcePanelEl.createDiv('tgf-current-file');
		this.applyPanelCollapsed();
	}

	private createIconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLButtonElement {
		const button = parent.createEl('button', {
			cls: 'tgf-icon-button',
			attr: { 'aria-label': label, title: label },
		});
		setIcon(button, icon);
		button.addEventListener('click', onClick);
		return button;
	}

	private createTextButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLButtonElement {
		const button = parent.createEl('button', { cls: 'tgf-text-button' });
		setIcon(button.createSpan(), icon);
		button.createSpan({ text: label });
		button.addEventListener('click', onClick);
		return button;
	}

	private applyPanelCollapsed(): void {
		const collapsed = this.plugin.data.sourcePanelCollapsed;
		this.sourcePanelEl.toggleClass('is-collapsed', collapsed);
		this.collapseButton?.empty();
		if (this.collapseButton) setIcon(this.collapseButton, collapsed ? 'panel-left-open' : 'panel-left-close');
	}

	private handleRenamedPath(oldPath: string, newPath: string): void {
		this.currentFilePath = renamePathValue(this.currentFilePath, oldPath, newPath);
		this.editorDocumentPath = renamePathValue(this.editorDocumentPath, oldPath, newPath);
		this.expandedSourceFolders = new Set(Array.from(this.expandedSourceFolders, (path) => (
			renamePathValue(path, oldPath, newPath)
		)));
	}

	private async syncRenamedDocumentReferences(oldPath: string, newPath: string): Promise<void> {
		for (const [documentPath, aliasesByTaskId] of this.documentLinkAliases) {
			const nextPath = renamePathValue(documentPath, oldPath, newPath);
			if (nextPath === documentPath) continue;
			const tasks = Array.from(aliasesByTaskId.keys())
				.map((taskId) => this.graphData.nodes.find((task) => task.id === taskId))
				.filter((task): task is DerivedTaskNode => Boolean(task));
			try {
				await renameTaskDocumentLinks(
					this.app,
					tasks,
					documentPath,
					nextPath,
					undefined,
					aliasesByTaskId,
				);
			} catch {
				// Obsidian may already have updated a non-ID task link. Reloading below
				// will resolve the current source of truth without blocking the rename.
			}
		}
	}

	private populateMapOptions(): void {
		if (!this.mapSelectEl) return;
		this.mapSelectEl.empty();
		this.plugin.data.maps.forEach((map) => {
			this.mapSelectEl.createEl('option', { value: map.id, text: map.name });
		});
		this.mapSelectEl.value = this.plugin.data.activeMapId;
	}

	private async createMap(): Promise<void> {
		if (!await this.flushDocumentEditor()) return;
		const name = await requestMapName(this.app, '新建任务地图');
		if (!name) return;
		const map = createTaskMap(name);
		this.plugin.data.maps.push(map);
		this.plugin.data.activeMapId = map.id;
		await this.plugin.persistData();
		this.populateMapOptions();
		await this.switchMap(map.id);
	}

	private async renameMap(): Promise<void> {
		const name = await requestMapName(this.app, '重命名任务地图', this.activeMap.name);
		if (!name) return;
		this.activeMap.name = name;
		await this.plugin.persistData();
		this.populateMapOptions();
	}

	private async deleteMap(): Promise<void> {
		if (!await this.flushDocumentEditor()) return;
		if (this.plugin.data.maps.length === 1) {
			new Notice('至少需要保留一张任务地图');
			return;
		}
		const map = this.activeMap;
		const confirmed = await confirmAction(
			this.app,
			`删除“${map.name}”？`,
			'只会删除地图来源、布局和视口，不会删除任何笔记或任务。',
		);
		if (!confirmed) return;
		this.plugin.data.maps = this.plugin.data.maps.filter((item) => item.id !== map.id);
		this.plugin.data.activeMapId = this.plugin.data.maps[0].id;
		await this.plugin.persistData();
		this.populateMapOptions();
		await this.reloadMap();
	}

	private async switchMap(mapId: string): Promise<void> {
		if (!this.plugin.data.maps.some((map) => map.id === mapId)) return;
		if (!await this.flushDocumentEditor()) {
			this.mapSelectEl.value = this.plugin.data.activeMapId;
			return;
		}
		this.resetDocumentEditorState();
		this.plugin.data.activeMapId = mapId;
		this.selectedId = null;
		this.currentFilePath = '';
		await this.plugin.persistData();
		await this.reloadMap();
		this.updateHistoryButtons();
	}

	private async manageSources(): Promise<void> {
		const sources = await openSourcePicker(this.app, this.activeMap);
		if (!sources) return;
		this.activeMap.sources = sources;
		await this.plugin.persistData();
		await this.reloadMap();
	}

	private async reloadMap(): Promise<void> {
		const generation = ++this.reloadGeneration;
		this.populateMapOptions();
		const map = this.activeMap;
		const mapId = map.id;
		const hadSavedPositions = Object.keys(map.nodePositions).length > 0;
		const resolved = resolveMapSources(this.app, map);
		const results = await Promise.all(resolved.files.map(async (file) => {
			try {
				const content = await this.app.vault.cachedRead(file);
				return { path: file.path, tasks: parseTaskFile(file.path, content), error: null };
			} catch (error) {
				return { path: file.path, tasks: [] as TaskNode[], error };
			}
		}));
		if (generation !== this.reloadGeneration || this.activeMap.id !== mapId) return;
		const failedPaths = results.filter((result) => result.error).map((result) => result.path);
		if (failedPaths.length > 0) {
			new Notice(
				`读取 ${failedPaths.length} 个任务文件失败，已保留错误提示：${failedPaths.slice(0, 3).join('、')}`,
			);
		}

		const preliminaryTasks = results.flatMap((result) => result.tasks);
		const contentPaths = new Set(collectDocumentPaths(this.app, map, preliminaryTasks).keys());
		this.taskCache.clear();
		results.forEach(({ path, tasks }) => {
			if (!contentPaths.has(path)) this.taskCache.set(path, tasks);
		});
		const taskSourceFiles = resolved.files.filter((file) => !contentPaths.has(file.path));
		if (!this.currentFilePath || !taskSourceFiles.some((file) => file.path === this.currentFilePath)) {
			const preferred = this.plugin.pendingScopePath;
			this.currentFilePath = taskSourceFiles.some((file) => file.path === preferred)
				? preferred
				: taskSourceFiles[0]?.path ?? '';
			this.plugin.pendingScopePath = '';
		}
		this.graphData = buildTaskGraph(Array.from(this.taskCache.values()).flat());
		this.documentLinkAliases.clear();
		this.graphData.nodes.forEach((task) => {
			task.documentLinks.forEach((link) => {
				const path = resolveDocumentPath(this.app, link, task.path);
				const byTask = this.documentLinkAliases.get(path) ?? new Map<string, string[]>();
				const aliases = byTask.get(task.id) ?? [];
				if (!aliases.includes(link)) aliases.push(link);
				byTask.set(task.id, aliases);
				this.documentLinkAliases.set(path, byTask);
			});
		});
		collectDocumentPaths(this.app, map, this.graphData.nodes).forEach((_, path) => {
			if (!map.documents.some((document) => document.path === path)) {
				map.documents.push({ path, expanded: false });
			}
		});
		const documentNodes = await loadDocumentNodes(this.app, map, this.graphData.nodes);
		if (generation !== this.reloadGeneration || this.activeMap.id !== mapId) return;
		this.documentNodes = documentNodes;
		this.documentEdges = buildDocumentEdges(this.documentNodes);
		this.seedMissingPositions();
		if (!hadSavedPositions && this.graphData.nodes.length > 0) this.shouldFitAfterRender = true;
		this.graphCanvas?.setViewport(map.viewport);
		this.renderSourcePanel();
		this.renderGraph();
		this.updateHistoryButtons();
		if (this.shouldFitAfterRender) {
			this.shouldFitAfterRender = false;
			window.setTimeout(() => this.graphCanvas?.fitView(), 0);
		}
	}

	private seedMissingPositions(): void {
		const map = this.activeMap;
		const layout = layoutGraph(this.graphData.nodes, this.graphData.edges);
		const expandedPaths = this.expandedDocumentPaths();
		const hasTaskPositions = this.graphData.nodes.some((node) => Boolean(map.nodePositions[taskPositionKey(node)]));
		const taskNodes = layout.nodes.map((node) => {
			const saved = map.nodePositions[taskPositionKey(node)];
			return saved ? { ...node, ...saved } : node;
		});
		const organized = layoutTaskDocuments(
			{ ...layout, nodes: taskNodes },
			this.documentNodes,
			expandedPaths,
			!hasTaskPositions,
		);
		let changed = false;
		organized.tasks.forEach((node) => {
			const key = taskPositionKey(node);
			if (!map.nodePositions[key]) {
				map.nodePositions[key] = { x: node.x, y: node.y };
				changed = true;
			}
		});
		organized.documents.forEach((node) => {
			const key = documentPositionKey(node.path);
			if (!map.nodePositions[key]) {
				map.nodePositions[key] = { x: node.x, y: node.y };
				changed = true;
			}
		});
		if (changed) this.queueSave();
	}

	private renderSourcePanel(): void {
		if (!this.sourceTreeEl) return;
		const map = this.activeMap;
		this.renderSourceSummary();
		renderSourceTree(
			this.app,
			this.sourceTreeEl,
			map.sources,
			this.sourceQuery,
			(next) => {
				map.sources = next;
				this.queueSave();
				void this.reloadMap();
			},
			(file) => {
				if (!mapContainsPath(map, file.path)) {
					new Notice('请先勾选这个文件或它所在的文件夹');
					return;
				}
				if (map.documents.some((document) => document.path === file.path)) {
					new Notice('这个文件在当前地图中作为内容文件使用，不会作为任务来源');
					return;
				}
				this.currentFilePath = file.path;
				this.renderSourcePanel();
			},
			this.expandedSourceFolders,
			this.currentFilePath,
		);

		const missing = resolveMapSources(this.app, map).missing;
		if (missing.length > 0) {
			const section = this.sourceTreeEl.createDiv('tgf-missing-sources');
			section.createDiv({ cls: 'tgf-section-title', text: '来源缺失' });
			missing.forEach((source) => section.createDiv({
				cls: 'tgf-missing-source',
				text: `${source.type === 'folder' ? '文件夹' : '文件'} · ${source.path}`,
			}));
		}
		this.renderCurrentFile();
	}

	private renderSourceSummary(): void {
		this.sourceSummaryEl.empty();
		const header = this.sourceSummaryEl.createDiv('tgf-source-summary-header');
		header.createSpan({ text: `已选来源 · ${this.activeMap.sources.length}` });
		header.createEl('button', { text: '管理' }).addEventListener('click', () => void this.manageSources());
		if (this.activeMap.sources.length === 0) {
			this.sourceSummaryEl.createDiv({ cls: 'tgf-source-summary-empty', text: '还没有选择文件或文件夹' });
			return;
		}
		const chips = this.sourceSummaryEl.createDiv('tgf-source-chips');
		this.activeMap.sources.slice(0, 4).forEach((source) => {
			const chip = chips.createDiv('tgf-source-chip');
			chip.setAttribute('aria-label', source.path);
			setIcon(chip.createSpan(), source.type === 'folder' ? 'folder' : 'file-text');
			chip.createSpan({ cls: 'tgf-source-chip-path', text: source.path });
			const remove = chip.createEl('button', {
				cls: 'tgf-source-chip-remove',
				attr: { 'aria-label': `移除来源 ${source.path}`, title: '从地图移除来源' },
			});
			setIcon(remove, 'x');
			remove.addEventListener('click', () => {
				this.activeMap.sources = toggleSource(this.activeMap.sources, source, false);
				this.queueSave();
				void this.reloadMap();
			});
		});
		if (this.activeMap.sources.length > 4) {
			chips.createSpan({ cls: 'tgf-source-more', text: `+${this.activeMap.sources.length - 4}` });
		}
		if (this.activeMap.documents.length > 0) {
			const documents = this.sourceSummaryEl.createDiv('tgf-source-documents');
			documents.createDiv({
				cls: 'tgf-section-title',
				text: `内容文件 · ${this.activeMap.documents.length}`,
			});
			this.activeMap.documents.slice(0, 4).forEach((config) => {
				const node = this.documentNodes.find((document) => document.path === config.path);
				const button = documents.createEl('button', {
					cls: 'tgf-source-document',
					text: node?.title ?? config.path.split('/').pop() ?? config.path,
					attr: { title: config.path },
				});
				button.addEventListener('click', () => {
					if (node) this.expandAndSelectDocument(node);
				});
			});
			if (this.activeMap.documents.length > 4) {
				documents.createSpan({
					cls: 'tgf-source-more',
					text: `另有 ${this.activeMap.documents.length - 4} 个`,
				});
			}
		}
	}

	private renderCurrentFile(): void {
		this.currentFileEl.empty();
		const header = this.currentFileEl.createDiv('tgf-current-file-header');
		header.createDiv({ cls: 'tgf-section-title', text: '当前文件' });
		if (!this.currentFilePath) {
			this.currentFileEl.createDiv({
				cls: 'tgf-current-file-empty',
				text: '从上方文件树勾选并点击一个 Markdown 文件。',
			});
			return;
		}
		header.createDiv({
			cls: 'tgf-current-file-path',
			text: this.currentFilePath,
			attr: { 'aria-label': this.currentFilePath },
		});
		const createButton = this.currentFileEl.createEl('button', {
			cls: 'mod-cta tgf-current-create',
			text: '在当前文件中新建任务',
		});
		createButton.addEventListener('click', () => void this.createTask(this.currentFilePath));
		const tasks = this.taskCache.get(this.currentFilePath) ?? [];
		const list = this.currentFileEl.createDiv('tgf-file-task-list');
		if (tasks.length === 0) list.createDiv({ cls: 'tgf-muted', text: '这个文件中还没有任务。' });
		tasks.forEach((task) => {
			const row = list.createEl('button', {
				cls: 'tgf-file-task',
				attr: { 'aria-label': task.text },
			});
			row.createSpan({ cls: `tgf-mini-status is-${task.status}` });
			row.createSpan({ cls: 'tgf-file-task-text', text: task.text });
			row.addEventListener('click', () => {
				this.selectedId = task.id;
				this.renderGraph();
			});
		});
	}

	private createPositionedLayout(): CanvasLayout {
		const automatic = layoutGraph(this.graphData.nodes, this.graphData.edges);
		let width = automatic.width;
		let height = automatic.height;
		const taskNodes = automatic.nodes.map((node) => {
			const saved = this.activeMap.nodePositions[taskPositionKey(node)];
			const positioned = saved ? { ...node, x: saved.x, y: saved.y } : node;
			width = Math.max(width, positioned.x + positioned.width + 72);
			height = Math.max(height, positioned.y + positioned.height + 72);
			return positioned;
		});
		const documentNodes = this.positionDocumentNodes({ ...automatic, nodes: taskNodes }, true);
		documentNodes.forEach((node) => {
			width = Math.max(width, node.x + node.width + 72);
			height = Math.max(height, node.y + node.height + 72);
		});
		const nodes: PositionedGraphNode[] = [...taskNodes, ...documentNodes];
		return { nodes, width, height };
	}

	private positionDocumentNodes(
		taskLayout: LayoutResult,
		useSaved: boolean,
	): PositionedDocumentNode[] {
		const result = layoutTaskDocuments(
			taskLayout,
			this.documentNodes,
			this.expandedDocumentPaths(),
			false,
		).documents;
		return result.map((node) => {
			const saved = useSaved
				? this.activeMap.nodePositions[documentPositionKey(node.path)]
				: null;
			return saved ? { ...node, ...saved } : node;
		});
	}

	private expandedDocumentPaths(): Set<string> {
		return new Set(
			this.activeMap.documents
				.filter((document) => document.expanded)
				.map((document) => document.path),
		);
	}

	private renderGraph(): void {
		const allLayout = this.createPositionedLayout();
		const queryMatches = new Set<string>();
		if (this.searchQuery) {
			this.graphData.nodes.forEach((node) => {
				const haystack = `${node.text} ${node.taskId ?? ''} ${node.tags.join(' ')} ${node.path}`.toLocaleLowerCase();
				if (haystack.includes(this.searchQuery)) queryMatches.add(node.id);
			});
		}
		const relatedIds = this.searchQuery ? this.collectRelatedIds(queryMatches) : null;
			const nodes = allLayout.nodes.filter((node) => {
				if ('nodeType' in node) {
					if (node.id === this.selectedId && this.editorDirty) return true;
					if (!this.searchQuery) return true;
				const haystack = `${node.title} ${node.excerpt} ${node.path}`.toLocaleLowerCase();
				return haystack.includes(this.searchQuery)
					|| node.linkedTaskIds.some((id) => relatedIds?.has(id));
			}
			if (!this.enabledStatuses.has(node.status)) return false;
			return relatedIds ? relatedIds.has(node.id) : true;
		});
		const visibleIds = new Set(nodes.map((node) => node.id));
		const edges = this.graphData.edges.filter((edge) => (
			visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId)
		));
		const documentEdges = this.documentEdges.filter((edge) => (
			visibleIds.has(edge.taskNodeId) && visibleIds.has(edge.documentNodeId)
		));
		if (this.selectedId && !visibleIds.has(this.selectedId)) this.selectedId = null;
		this.graphCanvas?.render({ ...allLayout, nodes }, edges, documentEdges, this.selectedId);
		const selectedTask = this.selectedId
			? this.graphData.nodes.find((node) => node.id === this.selectedId) ?? null
			: null;
		const selectedDocument = this.selectedId
			? this.documentNodes.find((node) => node.id === this.selectedId) ?? null
			: null;
			if (selectedDocument) {
				if (this.inspectorEl.dataset.documentPath !== selectedDocument.path) {
					this.renderDocumentInspector(selectedDocument);
				}
			} else {
				this.renderInspector(selectedTask);
			}
		this.renderStatusBar(nodes.filter(
			(node): node is PositionedTaskNode => !('nodeType' in node),
		));
	}

	private collectRelatedIds(seedIds: Set<string>): Set<string> {
		const result = new Set(seedIds);
		let changed = true;
		while (changed) {
			changed = false;
			this.graphData.edges.forEach((edge) => {
				if (edge.missing) return;
				if (result.has(edge.sourceId) || result.has(edge.targetId)) {
					if (!result.has(edge.sourceId)) {
						result.add(edge.sourceId);
						changed = true;
					}
					if (!result.has(edge.targetId)) {
						result.add(edge.targetId);
						changed = true;
					}
				}
			});
		}
		return result;
	}

	private async organizeGraph(): Promise<void> {
		const historyBefore = this.mapHistoryState(this.activeMap);
		const layout = layoutGraph(this.graphData.nodes, this.graphData.edges);
		const organized = layoutTaskDocuments(
			layout,
			this.documentNodes,
			this.expandedDocumentPaths(),
			true,
		);
		const positions: Record<string, NodePosition> = {};
		organized.tasks.forEach((node) => {
			positions[taskPositionKey(node)] = { x: node.x, y: node.y };
		});
		organized.documents.forEach((node) => {
			positions[documentPositionKey(node.path)] = { x: node.x, y: node.y };
		});
		this.activeMap.nodePositions = positions;
		await this.plugin.persistData();
		this.recordConfigHistory('规整地图', historyBefore);
		this.renderGraph();
		window.setTimeout(() => this.graphCanvas?.fitView(), 0);
		new Notice('已按任务关系和内容归属重新规整地图');
	}

	private saveNodePosition(node: PositionedGraphNode, position: NodePosition): void {
		const historyBefore = this.mapHistoryState(this.activeMap);
		const key = 'nodeType' in node
			? documentPositionKey(node.path)
			: taskPositionKey(node);
		this.activeMap.nodePositions[key] = position;
		this.recordConfigHistory('移动节点', historyBefore);
		this.queueSave();
	}

	private saveViewport(viewport: ViewportState): void {
		this.activeMap.viewport = viewport;
		this.queueSave();
	}

	private isTextEditingTarget(target: EventTarget | null): boolean {
		return target instanceof HTMLElement && Boolean(
			target.closest('input, textarea, [contenteditable="true"]'),
		);
	}

	private mapHistoryState(map: TaskMapConfig): HistoryMapState {
		return {
			nodePositions: Object.fromEntries(
				Object.entries(map.nodePositions).map(([key, position]) => [key, { ...position }]),
			),
			documents: map.documents.map((document) => ({ ...document })),
		};
	}

	private historyPaths(mapIds: string[]): string[] {
		const paths = new Set<string>();
		this.plugin.data.maps
			.filter((map) => mapIds.includes(map.id))
			.forEach((map) => {
				resolveMapSources(this.app, map).files.forEach((file) => paths.add(file.path));
				map.documents.forEach((document) => paths.add(document.path));
			});
		return Array.from(paths);
	}

	private async captureHistorySnapshot(paths: string[], mapIds: string[]): Promise<HistorySnapshot> {
		const files: Record<string, string | null> = {};
		const orderedPaths = Array.from(new Set(paths)).sort((a, b) => a.localeCompare(b));
		const captured = await Promise.all(orderedPaths.map(async (path) => {
			const file = this.app.vault.getAbstractFileByPath(path);
			return [path, file instanceof TFile ? await this.app.vault.read(file) : null] as const;
		}));
		captured.forEach(([path, content]) => { files[path] = content; });
		const maps: Record<string, HistoryMapState> = {};
		mapIds.forEach((mapId) => {
			const map = this.plugin.data.maps.find((candidate) => candidate.id === mapId);
			if (map) maps[mapId] = this.mapHistoryState(map);
		});
		return { files, maps };
	}

	private async beginHistory(
		label: string,
		options: {
			allMaps?: boolean;
			paths?: string[];
			coalesceKey?: string;
		} = {},
	): Promise<PendingHistory> {
		if (label !== '编辑内容' && this.editorDirty) {
			await this.flushDocumentEditor();
		}
		const mapIds = options.allMaps
			? this.plugin.data.maps.map((map) => map.id)
			: [this.activeMap.id];
		const autoPaths = !options.paths;
		const vaultWide = Boolean(options.allMaps && autoPaths);
		const paths = options.paths ?? (
			vaultWide
				? this.app.vault.getMarkdownFiles().map((file) => file.path)
				: this.historyPaths(mapIds)
		);
		return {
			mapId: this.activeMap.id,
			label,
			before: await this.captureHistorySnapshot(paths, mapIds),
			mapIds,
			autoPaths,
			vaultWide,
			coalesceKey: options.coalesceKey,
		};
	}

	private compactHistoryEntry(pending: PendingHistory, after: HistorySnapshot): HistoryEntry | null {
		const beforeFiles: Record<string, string | null> = {};
		const afterFiles: Record<string, string | null> = {};
		const filePaths = new Set([
			...Object.keys(pending.before.files),
			...Object.keys(after.files),
		]);
		filePaths.forEach((path) => {
			const before = pending.before.files[path] ?? null;
			const next = after.files[path] ?? null;
			if (before !== next) {
				beforeFiles[path] = before;
				afterFiles[path] = next;
			}
		});
		const beforeMaps: Record<string, HistoryMapState> = {};
		const afterMaps: Record<string, HistoryMapState> = {};
		pending.mapIds.forEach((mapId) => {
			const before = pending.before.maps[mapId];
			const next = after.maps[mapId];
			if (before && next && JSON.stringify(before) !== JSON.stringify(next)) {
				beforeMaps[mapId] = before;
				afterMaps[mapId] = next;
			}
		});
		if (Object.keys(beforeFiles).length === 0 && Object.keys(beforeMaps).length === 0) return null;
		return {
			label: pending.label,
			before: { files: beforeFiles, maps: beforeMaps },
			after: { files: afterFiles, maps: afterMaps },
			coalesceKey: pending.coalesceKey,
		};
	}

	private async commitHistory(pending: PendingHistory): Promise<void> {
		const currentPaths = pending.autoPaths
			? pending.vaultWide
				? this.app.vault.getMarkdownFiles().map((file) => file.path)
				: this.historyPaths(pending.mapIds)
			: [];
		const paths = Array.from(new Set([
			...Object.keys(pending.before.files),
			...currentPaths,
		]));
		const after = await this.captureHistorySnapshot(paths, pending.mapIds);
		paths.forEach((path) => {
			if (!(path in pending.before.files)) pending.before.files[path] = null;
		});
		const entry = this.compactHistoryEntry(pending, after);
		if (!entry) return;
		this.history.record(pending.mapId, entry);
		this.updateHistoryButtons();
	}

	private recordConfigHistory(
		label: string,
		before: HistoryMapState,
		coalesceKey?: string,
	): void {
		const after = this.mapHistoryState(this.activeMap);
		if (JSON.stringify(before) === JSON.stringify(after)) return;
		this.history.record(this.activeMap.id, {
			label,
			before: { files: {}, maps: { [this.activeMap.id]: before } },
			after: { files: {}, maps: { [this.activeMap.id]: after } },
			coalesceKey,
		});
		this.updateHistoryButtons();
	}

	private snapshotsEqual(a: HistorySnapshot, b: HistorySnapshot): boolean {
		return JSON.stringify(a) === JSON.stringify(b);
	}

	private async writeHistoryFiles(files: Record<string, string | null>): Promise<void> {
		const deletions = Object.entries(files).filter(([, content]) => content === null);
		const writes = Object.entries(files).filter(([, content]) => content !== null);
		for (const [path] of deletions) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await this.app.vault.delete(file);
		}
		for (const [path, content] of writes) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await this.app.vault.modify(file, content!);
			else if (!file) await this.app.vault.create(path, content!);
			else throw new Error(`无法恢复文件，路径被文件夹占用：${path}`);
		}
	}

	private applyHistoryMaps(maps: Record<string, HistoryMapState>): void {
		Object.entries(maps).forEach(([mapId, state]) => {
			const map = this.plugin.data.maps.find((candidate) => candidate.id === mapId);
			if (!map) throw new Error(`找不到历史记录所属地图：${mapId}`);
			map.nodePositions = Object.fromEntries(
				Object.entries(state.nodePositions).map(([key, position]) => [key, { ...position }]),
			);
			map.documents = state.documents.map((document) => ({ ...document }));
		});
	}

	private async applyHistorySnapshot(
		expected: HistorySnapshot,
		target: HistorySnapshot,
	): Promise<void> {
		const paths = Object.keys(expected.files);
		const mapIds = Object.keys(expected.maps);
		const current = await this.captureHistorySnapshot(paths, mapIds);
		if (!this.snapshotsEqual(current, expected)) {
			throw new HistoryConflictError('文件或地图布局已被其他操作修改，未执行撤销以避免覆盖新内容');
		}
		try {
			await this.writeHistoryFiles(target.files);
			this.applyHistoryMaps(target.maps);
			await this.plugin.persistData();
		} catch (error) {
			try {
				await this.writeHistoryFiles(current.files);
				this.applyHistoryMaps(current.maps);
				await this.plugin.persistData();
			} catch (rollbackError) {
				const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
				throw new Error(`恢复操作失败，且自动回滚未完成：${message}`);
			}
			throw error;
		}
	}

	private updateHistoryButtons(): void {
		if (!this.undoButton || !this.redoButton) return;
		const mapId = this.activeMap.id;
		const undoLabel = this.history.undoLabel(mapId);
		const redoLabel = this.history.redoLabel(mapId);
		this.undoButton.disabled = !undoLabel;
		this.redoButton.disabled = !redoLabel;
		this.undoButton.setAttribute('aria-label', undoLabel ? `撤销：${undoLabel}` : '没有可撤销的操作');
		this.undoButton.setAttribute('title', undoLabel ? `撤销：${undoLabel} (⌘/Ctrl+Z)` : '没有可撤销的操作');
		this.redoButton.setAttribute('aria-label', redoLabel ? `重做：${redoLabel}` : '没有可重做的操作');
		this.redoButton.setAttribute('title', redoLabel ? `重做：${redoLabel} (⌘/Ctrl+Shift+Z)` : '没有可重做的操作');
	}

	public canUndo(): boolean {
		return this.history.canUndo(this.activeMap.id);
	}

	public canRedo(): boolean {
		return this.history.canRedo(this.activeMap.id);
	}

	public async undo(): Promise<void> {
		if (!await this.flushDocumentEditor()) return;
		try {
			const entry = await this.history.undo(
				this.activeMap.id,
				(expected, target) => this.applyHistorySnapshot(expected, target),
			);
			if (!entry) return;
			await this.reloadMap();
			new Notice(`已撤销：${entry.label}`);
		} catch (error) {
			this.showError(error, '撤销失败');
		} finally {
			this.updateHistoryButtons();
		}
	}

	public async redo(): Promise<void> {
		if (!await this.flushDocumentEditor()) return;
		try {
			const entry = await this.history.redo(
				this.activeMap.id,
				(expected, target) => this.applyHistorySnapshot(expected, target),
			);
			if (!entry) return;
			await this.reloadMap();
			new Notice(`已重做：${entry.label}`);
		} catch (error) {
			this.showError(error, '重做失败');
		} finally {
			this.updateHistoryButtons();
		}
	}

	private queueSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.plugin.persistData();
		}, 300);
	}

	private async selectNode(node: PositionedTaskNode): Promise<void> {
		if (!await this.flushDocumentEditor()) return;
		this.resetDocumentEditorState();
		this.selectedId = node.id;
		this.graphCanvas?.setSelected(node.id);
		this.renderInspector(node);
	}

	private async selectGraphNode(node: PositionedGraphNode): Promise<void> {
		if ('nodeType' in node) await this.selectDocument(node);
		else await this.selectNode(node);
	}

	private async selectDocument(node: DocumentNode): Promise<void> {
		if (
			this.editorDocumentPath !== node.path
			&& !await this.flushDocumentEditor()
		) return;
		this.selectedId = node.id;
		this.graphCanvas?.setSelected(node.id);
		if (this.inspectorEl.dataset.documentPath !== node.path) {
			this.renderDocumentInspector(node);
		}
	}

	private renderInspector(node: DerivedTaskNode | null): void {
		this.inspectorEl.empty();
		delete this.inspectorEl.dataset.documentPath;
		if (!node) {
			this.inspectorEl.addClass('is-empty');
			const icon = this.inspectorEl.createDiv('tgf-empty-icon');
			setIcon(icon, 'mouse-pointer-click');
			this.inspectorEl.createDiv({ cls: 'tgf-empty-title', text: '选择一个任务' });
			this.inspectorEl.createDiv({
				cls: 'tgf-empty-description',
				text: '查看、编辑或从这里创建后续任务',
			});
			return;
		}
		this.inspectorEl.removeClass('is-empty');
		const header = this.inspectorEl.createDiv('tgf-inspector-header');
		header.createDiv({ cls: `tgf-inspector-kicker is-${node.readiness}`, text: this.readinessLabel(node) });
		const close = this.createIconButton(header, 'x', '关闭详情', () => {
			this.selectedId = null;
			this.graphCanvas?.setSelected(null);
			this.renderInspector(null);
		});
		close.addClass('tgf-inspector-close');
		this.inspectorEl.createEl('h2', {
			cls: 'tgf-inspector-title',
			text: node.text,
			attr: { 'aria-label': node.text },
		});
		const source = this.inspectorEl.createDiv('tgf-inspector-source');
		setIcon(source.createSpan(), 'file-text');
		source.createSpan({ text: `${node.path} · 第 ${node.line + 1} 行` });
		if (node.headingPath.length > 0) {
			this.inspectorEl.createDiv({ cls: 'tgf-heading-path', text: node.headingPath.join(' / ') });
		}
		const facts = this.inspectorEl.createDiv('tgf-facts');
		this.addFact(facts, '状态', STATUS_LABELS[node.status]);
		this.addFact(facts, '任务 ID', node.taskId ?? '未分配（独立任务可不需要）');
		if (node.priority) this.addFact(facts, '优先级', node.priority);
		if (node.startDate) this.addFact(facts, '开始', node.startDate);
		if (node.dueDate) this.addFact(facts, '截止', node.dueDate);
		if (node.tags.length > 0) {
			const tags = this.inspectorEl.createDiv('tgf-inspector-section');
			tags.createDiv({ cls: 'tgf-section-title', text: '标签' });
			const tagRow = tags.createDiv('tgf-inspector-tags');
			node.tags.forEach((tag) => {
				const chip = tagRow.createEl('button', { text: `#${tag} ×` });
				chip.addEventListener('click', () => void this.removeTag(node, tag));
			});
		}
		const contentSection = this.inspectorEl.createDiv('tgf-inspector-section');
		const contentHeader = contentSection.createDiv('tgf-section-heading');
		contentHeader.createDiv({ cls: 'tgf-section-title', text: '任务内容' });
		const contentActions = contentHeader.createDiv('tgf-section-actions');
		contentActions.createEl('button', { text: '新建' })
			.addEventListener('click', () => void this.createDocumentForTask(node));
		contentActions.createEl('button', { text: '关联笔记' })
			.addEventListener('click', () => void this.chooseDocumentForTask(node));
		const linkedDocuments = this.documentNodes.filter((document) => (
			document.linkedTaskIds.includes(node.id)
		));
		if (linkedDocuments.length === 0) {
			contentSection.createDiv({ cls: 'tgf-muted', text: '还没有关联内容文件' });
		} else {
			const list = contentSection.createDiv('tgf-linked-document-list');
			linkedDocuments.forEach((document) => {
				const row = list.createDiv('tgf-linked-document');
				const main = row.createEl('button', { cls: 'tgf-linked-document-main' });
				setIcon(main.createSpan(), document.missing ? 'file-warning' : 'file-text');
				main.createSpan({ text: document.title });
				main.addEventListener('click', () => this.expandAndSelectDocument(document));
				const unlink = row.createEl('button', {
					cls: 'tgf-linked-document-unlink',
					attr: { title: '解除内容关联', 'aria-label': `解除 ${document.title} 的关联` },
				});
				setIcon(unlink, 'unlink');
				unlink.addEventListener('click', () => void this.unlinkDocumentFromTask(node, document));
			});
		}
		const relationships = this.inspectorEl.createDiv('tgf-inspector-section');
		relationships.createDiv({ cls: 'tgf-section-title', text: '任务关系' });
		if (node.blockedByIds.length === 0 && node.dependentIds.length === 0) {
			relationships.createDiv({ cls: 'tgf-muted', text: '当前没有依赖关系' });
		} else {
			if (node.blockedByIds.length > 0) this.addRelationshipList(relationships, '前置', node.blockedByIds);
			if (node.dependentIds.length > 0) this.addRelationshipList(relationships, '后续', node.dependentIds);
		}
		if (node.warnings.length > 0) {
			const warning = this.inspectorEl.createDiv('tgf-inspector-warning');
			setIcon(warning.createSpan(), 'triangle-alert');
			warning.createSpan({ text: this.warningLabel(node) });
		}
		const actions = this.inspectorEl.createDiv('tgf-inspector-actions');
		const successor = actions.createEl('button', { cls: 'mod-cta', text: '创建后续任务' });
		successor.addEventListener('click', () => void this.createSuccessor(node));
		const predecessor = actions.createEl('button', { text: '创建前置任务' });
		predecessor.addEventListener('click', () => void this.createPredecessor(node));
		const edit = actions.createEl('button', { text: '编辑任务' });
		edit.addEventListener('click', () => void this.editTask(node));
		if (!node.taskId || node.warnings.includes('duplicate-id')) {
			const assignId = actions.createEl('button', {
				text: node.taskId ? '重新生成 ID' : '生成任务 ID',
			});
			assignId.addEventListener('click', () => void this.generateTaskId(node));
		}
		const star = actions.createEl('button', { text: node.starred ? '取消星标' : '添加星标' });
		star.addEventListener('click', () => void this.toggleStar(node));
		const addTag = actions.createEl('button', { text: '添加标签' });
		addTag.addEventListener('click', () => void this.addTag(node));
		const open = actions.createEl('button', { text: '打开原文' });
		open.addEventListener('click', () => void this.openTask(node));
		const toggle = actions.createEl('button', {
			text: node.status === 'todo'
				? '开始任务'
				: node.status === 'in_progress'
					? '标记完成'
					: node.status === 'custom'
						? '切换完成状态'
						: '恢复待办',
		});
		toggle.addEventListener('click', () => void this.toggleTask(node));
		const remove = actions.createEl('button', { cls: 'mod-warning', text: '删除任务' });
		remove.addEventListener('click', () => void this.deleteTask(node));
	}

	private renderDocumentInspector(document: DocumentNode): void {
		this.inspectorEl.empty();
		this.inspectorEl.dataset.documentPath = document.path;
		this.inspectorEl.removeClass('is-empty');
		const header = this.inspectorEl.createDiv('tgf-inspector-header');
		header.createDiv({
			cls: `tgf-inspector-kicker${document.missing ? ' is-blocked' : ' is-ready'}`,
			text: document.missing ? '内容文件缺失' : '任务内容',
		});
		const close = this.createIconButton(header, 'x', '关闭详情', () => {
			void this.closeDocumentInspector();
		});
		close.addClass('tgf-inspector-close');
		this.inspectorEl.createEl('h2', {
			cls: 'tgf-inspector-title',
			text: document.title,
			attr: { 'aria-label': document.title },
		});
		const source = this.inspectorEl.createDiv('tgf-inspector-source');
		setIcon(source.createSpan(), document.missing ? 'file-warning' : 'file-text');
		source.createSpan({ text: document.path });
		const facts = this.inspectorEl.createDiv('tgf-facts');
		this.addFact(facts, '字数', String(document.wordCount));
		this.addFact(
			facts,
			'清单进度',
			document.checklistTotal > 0
				? `${document.checklistDone} / ${document.checklistTotal}（${Math.round(document.checklistDone / document.checklistTotal * 100)}%）`
				: '暂无清单',
		);
		this.addFact(facts, '关联任务', String(document.linkedTaskIds.length));
		this.addFact(
			facts,
			'最后修改',
			document.mtime ? new Date(document.mtime).toLocaleString('zh-CN') : '未知',
		);

		if (document.missing) {
			const warning = this.inspectorEl.createDiv('tgf-inspector-warning');
			setIcon(warning.createSpan(), 'triangle-alert');
			warning.createSpan({ text: '原路径仍被保留，可以重新绑定到 Vault 中的其他 Markdown 文件。' });
			const rebind = this.inspectorEl.createEl('button', { cls: 'mod-cta', text: '重新绑定文件' });
			rebind.addEventListener('click', () => void this.rebindMissingDocument(document));
		} else {
			this.renderDocumentEditor(document);
		}

		this.renderDocumentTaskLinks(document);
		const actions = this.inspectorEl.createDiv('tgf-inspector-actions');
		if (!document.missing) {
			actions.createEl('button', { cls: 'mod-cta', text: '打开完整笔记' })
				.addEventListener('click', () => void this.openDocument(document));
			actions.createEl('button', { text: '重命名文件' })
				.addEventListener('click', () => void this.renameDocument(document));
		}
		actions.createEl('button', { text: '从画布移除' })
			.addEventListener('click', () => void this.removeDocumentFromCanvas(document));
		if (!document.missing) {
			actions.createEl('button', { cls: 'mod-warning', text: '删除内容文件' })
				.addEventListener('click', () => void this.deleteDocumentFile(document));
		}
	}

	private renderDocumentEditor(document: DocumentNode): void {
		const section = this.inspectorEl.createDiv('tgf-inspector-section tgf-document-editor-section');
		const header = section.createDiv('tgf-section-heading');
		header.createDiv({ cls: 'tgf-section-title', text: '快速编辑' });
		const tabs = header.createDiv('tgf-section-actions');
		const editButton = tabs.createEl('button', { cls: 'is-active', text: '编辑' });
		const previewButton = tabs.createEl('button', { text: '预览' });
		const status = section.createDiv({ cls: 'tgf-editor-status', text: '正在读取…' });
		const textarea = section.createEl('textarea', {
			cls: 'tgf-document-editor',
			attr: { placeholder: '在这里快速编辑 Markdown 内容…' },
		});
		const preview = section.createDiv('tgf-document-preview');
		preview.hide();
		const file = this.app.vault.getAbstractFileByPath(document.path);
		if (!(file instanceof TFile)) return;
		const loadGeneration = ++this.editorLoadGeneration;
		this.editorDocumentPath = document.path;
		this.editorLoadedMtime = file.stat.mtime;
		this.editorDirty = false;
		textarea.disabled = true;
		void this.app.vault.read(file).then((content) => {
			if (
				loadGeneration !== this.editorLoadGeneration
				|| this.selectedId !== document.id
				|| this.editorDocumentPath !== document.path
				|| this.editorDirty
				) return;
				this.editorValue = content;
				this.editorBaseContent = content;
				textarea.value = content;
				textarea.disabled = false;
				status.setText('已保存');
			}).catch((error) => {
			if (loadGeneration !== this.editorLoadGeneration) return;
			textarea.disabled = true;
			status.setText('读取失败');
			this.showError(error, '读取内容失败');
		});
		textarea.addEventListener('input', () => {
			this.editorValue = textarea.value;
			this.editorDirty = true;
			status.setText('未保存');
			if (this.documentSaveTimer !== null) window.clearTimeout(this.documentSaveTimer);
			this.documentSaveTimer = window.setTimeout(() => {
				this.documentSaveTimer = null;
				void this.saveDocumentEditor(status);
			}, 600);
		});
		textarea.addEventListener('keydown', (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 's') {
				event.preventDefault();
				void this.saveDocumentEditor(status);
			}
		});
		editButton.addEventListener('click', () => {
			editButton.addClass('is-active');
			previewButton.removeClass('is-active');
			preview.hide();
			textarea.show();
			textarea.focus();
		});
		previewButton.addEventListener('click', () => {
			editButton.removeClass('is-active');
			previewButton.addClass('is-active');
			textarea.hide();
			preview.show();
			preview.empty();
			void MarkdownRenderer.render(this.app, textarea.value, preview, document.path, this);
		});
	}

	private renderDocumentTaskLinks(document: DocumentNode): void {
		const section = this.inspectorEl.createDiv('tgf-inspector-section');
		section.createDiv({ cls: 'tgf-section-title', text: '关联任务' });
		const search = section.createEl('input', {
			type: 'search',
			cls: 'tgf-document-task-search',
			placeholder: '搜索并勾选任务',
		});
		const list = section.createDiv('tgf-document-task-list');
		const draw = () => {
			list.empty();
			const query = search.value.trim().toLocaleLowerCase();
			this.graphData.nodes
				.filter((task) => !query || `${task.text} ${task.path}`.toLocaleLowerCase().includes(query))
				.forEach((task) => {
					const row = list.createEl('label', { cls: 'tgf-document-task-row' });
					const checkbox = row.createEl('input', { type: 'checkbox' });
					checkbox.checked = document.linkedTaskIds.includes(task.id);
					row.createSpan({ text: task.text, attr: { title: task.path } });
					checkbox.addEventListener('change', () => {
						if (checkbox.checked) void this.linkDocumentToTask(task, document);
						else void this.unlinkDocumentFromTask(task, document);
					});
				});
		};
		search.addEventListener('input', draw);
		draw();
	}

	private async saveDocumentEditor(status?: HTMLElement): Promise<void> {
		if (this.documentSavePromise) await this.documentSavePromise;
		if (!this.editorDirty || !this.editorDocumentPath) return;
		const path = this.editorDocumentPath;
		const loadedMtime = this.editorLoadedMtime;
		const value = this.editorValue;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			status?.setText('文件不存在');
			return;
		}
		if (file.stat.mtime > loadedMtime) {
			const currentContent = await this.app.vault.read(file);
			if (currentContent === value) {
				this.markEditorSaved(file, value, status);
				return;
			}
			if (currentContent !== this.editorBaseContent) {
				status?.setText('检测到外部修改，未覆盖');
				new Notice('内容文件已被外部修改，请重新载入或打开完整笔记处理冲突');
				return;
			}
			this.editorLoadedMtime = file.stat.mtime;
		}
		const history = await this.beginHistory('编辑内容', {
			paths: [path],
			coalesceKey: `document-editor:${path}:${this.editorLoadGeneration}`,
		});
		this.editorDirty = false;
		status?.setText('正在保存…');
		const savePromise = (async () => {
			try {
				this.ignoreDocumentModifyUntil = Date.now() + 1200;
				await this.app.vault.modify(file, value);
				const stats = calculateDocumentStats(value);
				const node = this.documentNodes.find((item) => item.path === file.path);
				if (node) Object.assign(node, stats, { mtime: file.stat.mtime });
				if (this.editorDocumentPath === path) {
					this.editorBaseContent = value;
					this.editorLoadedMtime = file.stat.mtime;
					status?.setText(this.editorDirty ? '未保存' : '已保存');
				}
				await this.commitHistory(history);
			} catch (error) {
				if (this.editorDocumentPath === path) this.editorDirty = true;
				status?.setText('保存失败');
				this.showError(error, '保存内容失败');
			}
		})();
		this.documentSavePromise = savePromise;
		try {
			await savePromise;
		} finally {
			if (this.documentSavePromise === savePromise) this.documentSavePromise = null;
		}
	}

	private async handleEditorDocumentModified(file: TFile): Promise<void> {
		try {
			const currentContent = await this.app.vault.read(file);
			if (file.path !== this.editorDocumentPath || !this.editorDirty) return;
			if (currentContent === this.editorValue) {
				this.markEditorSaved(file, currentContent);
				return;
			}
			if (currentContent === this.editorBaseContent) {
				this.editorLoadedMtime = file.stat.mtime;
				return;
			}
			new Notice('内容文件已在外部修改；当前快速编辑内容尚未覆盖，请重新载入或打开完整笔记');
		} catch (error) {
			this.showError(error, '检查内容文件修改失败');
		}
	}

	private markEditorSaved(file: TFile, content: string, status?: HTMLElement): void {
		this.editorDirty = false;
		this.editorValue = content;
		this.editorBaseContent = content;
		this.editorLoadedMtime = file.stat.mtime;
		const stats = calculateDocumentStats(content);
		const node = this.documentNodes.find((item) => item.path === file.path);
		if (node) Object.assign(node, stats, { mtime: file.stat.mtime });
		status?.setText('已保存');
	}
	
		private async flushDocumentEditor(): Promise<boolean> {
			if (this.documentSaveTimer !== null) {
				window.clearTimeout(this.documentSaveTimer);
			this.documentSaveTimer = null;
		}
		await this.saveDocumentEditor();
		if (this.documentSavePromise) await this.documentSavePromise;
		if (this.editorDirty) await this.saveDocumentEditor();
		return !this.editorDirty;
	}

	private resetDocumentEditorState(): void {
		this.editorLoadGeneration += 1;
		this.editorDocumentPath = '';
		this.editorLoadedMtime = 0;
		this.editorDirty = false;
		this.editorValue = '';
		this.editorBaseContent = '';
	}

	private async closeDocumentInspector(): Promise<void> {
		if (!await this.flushDocumentEditor()) return;
		this.resetDocumentEditorState();
		this.selectedId = null;
		this.graphCanvas?.setSelected(null);
		this.renderInspector(null);
	}

	private async preserveUnsavedDocumentDraft(): Promise<void> {
		if (!this.editorDocumentPath || !this.editorDirty) return;
		const slash = this.editorDocumentPath.lastIndexOf('/');
		const folder = slash >= 0 ? this.editorDocumentPath.slice(0, slash) : '';
		const baseName = (slash >= 0
			? this.editorDocumentPath.slice(slash + 1)
			: this.editorDocumentPath
		).replace(/\.md$/i, '');
		const recoveryPath = uniqueDocumentPath(
			this.app,
			folder,
			sanitizeDocumentTitle(`${baseName}-TaskGraph-恢复`),
		);
		try {
			await this.app.vault.create(recoveryPath, this.editorValue);
			new Notice(`快速编辑内容未能安全覆盖，已保存恢复副本：${recoveryPath}`);
			this.editorDirty = false;
		} catch (error) {
			this.showError(error, '保存快速编辑恢复副本失败');
		}
	}

	private addFact(parent: HTMLElement, label: string, value: string): void {
		const row = parent.createDiv('tgf-fact');
		row.createSpan({ cls: 'tgf-fact-label', text: label });
		row.createSpan({ cls: 'tgf-fact-value', text: value });
	}

	private addRelationshipList(parent: HTMLElement, label: string, ids: string[]): void {
		const row = parent.createDiv('tgf-relationship');
		row.createSpan({ cls: 'tgf-relationship-label', text: label });
		const values = row.createDiv('tgf-relationship-values');
		ids.forEach((id) => {
			const node = this.graphData.nodes.find((item) => item.id === id);
			values.createSpan({ text: node?.taskId ?? id });
		});
	}

	private readinessLabel(node: DerivedTaskNode): string {
		if (node.readiness === 'ready') return '现在可以开始';
		if (node.readiness === 'blocked') return `被 ${node.unresolvedDependencyIds.length} 项任务阻塞`;
		if (node.readiness === 'active') return '正在进行';
		return node.status === 'canceled' ? '已取消' : '已经完成';
	}

	private warningLabel(node: DerivedTaskNode): string {
		const labels: string[] = [];
		if (node.warnings.includes('missing-id')) labels.push('参与关系但缺少任务 ID');
		if (node.warnings.includes('duplicate-id')) labels.push('任务 ID 与地图中其他任务重复');
		if (node.warnings.includes('missing-reference')) labels.push('引用的前置任务不存在于当前地图');
		if (node.warnings.includes('cycle')) labels.push('检测到循环依赖');
		return labels.join('；');
	}

	private renderStatusBar(visibleNodes: DerivedTaskNode[]): void {
		this.statusBarEl.empty();
		const total = this.graphData.nodes.length;
		const done = this.graphData.nodes.filter((node) => node.status === 'done').length;
		const active = this.graphData.nodes.filter((node) => node.readiness === 'active').length;
		const ready = this.graphData.nodes.filter((node) => node.readiness === 'ready').length;
		const blocked = this.graphData.nodes.filter((node) => node.readiness === 'blocked').length;
		const warnings = this.graphData.nodes.filter((node) => node.warnings.length > 0).length;
		const missing = resolveMapSources(this.app, this.activeMap).missing.length;
		this.statusBarEl.createSpan({ cls: 'tgf-status-primary', text: `${visibleNodes.length} / ${total} 个任务` });
		this.statusBarEl.createSpan({
			text: `${this.activeMap.documents.filter((document) => document.expanded).length} 个内容节点`,
		});
		this.statusBarEl.createSpan({ text: `${done} 已完成` });
		this.statusBarEl.createSpan({ text: `${active} 进行中` });
		this.statusBarEl.createSpan({ cls: 'is-ready', text: `${ready} 可开始` });
		this.statusBarEl.createSpan({ cls: blocked > 0 ? 'is-blocked' : '', text: `${blocked} 被阻塞` });
		if (warnings > 0) this.statusBarEl.createSpan({ cls: 'is-warning', text: `${warnings} 项需检查` });
		const repairable = this.graphData.nodes.filter((node) => node.warnings.includes('missing-id'));
		if (repairable.length > 0) {
			const repair = this.statusBarEl.createEl('button', {
				cls: 'tgf-status-repair',
				text: `修复 ${repairable.length} 个关系任务 ID`,
			});
			repair.addEventListener('click', () => void this.repairRelationshipIds(repairable));
		}
		if (missing > 0) this.statusBarEl.createSpan({ cls: 'is-warning', text: `${missing} 个来源缺失` });
		if (!getTasksApi(this.app)) {
			this.statusBarEl.createSpan({ cls: 'is-warning', text: 'Tasks 未启用：创建与编辑不可用' });
		}
	}

	private async createTask(defaultPath?: string, position?: NodePosition): Promise<void> {
		const api = getTasksApi(this.app);
		if (!api) {
			new Notice('需要安装并启用 Tasks 插件后才能创建任务');
			return;
		}
		if (this.activeMap.sources.length === 0) {
			new Notice('请先为当前地图选择文件或文件夹来源');
			return;
		}
		const target = await chooseTaskTarget(this.app, this.activeMap, defaultPath ?? this.currentFilePath);
		if (!target) return;
		const taskLine = await api.createTaskLineModal();
		if (!taskLine) return;
		const prepared = prepareNewTaskLine(taskLine, this.nextTaskId());
		const history = await this.beginHistory('创建任务');
		try {
			const file = await this.writeNewTask(target, prepared.line);
			const parsed = parseTaskFile(file.path, prepared.line)[0];
			if (parsed) {
				const suggested = position ?? this.graphCanvas?.getViewportCenter() ?? { x: 72, y: 72 };
				this.activeMap.nodePositions[taskPositionKey(parsed)] = suggested;
			}
			this.currentFilePath = file.path;
			await this.plugin.persistData();
			await this.reloadMap();
			await this.commitHistory(history);
			new Notice('任务已添加到地图');
		} catch (error) {
			this.showError(error, '创建任务失败');
		}
	}

	private async createStandaloneDocument(position?: NodePosition): Promise<void> {
		if (!this.currentFilePath) {
			new Notice('请先在来源面板中选择一个当前文件，作为内容文件的默认目录');
			return;
		}
		const title = await requestTextValue(this.app, '新建内容文件', '文件标题', '例如：第二步方案');
		if (!title) return;
		let createdFile: TFile | null = null;
		const history = await this.beginHistory('创建内容文件');
		try {
			const file = await createContentDocument(this.app, this.currentFilePath, title);
			createdFile = file;
			registerDocument(this.activeMap, file.path, true);
			this.activeMap.nodePositions[documentPositionKey(file.path)] = position
				?? this.graphCanvas?.getViewportCenter()
				?? { x: 72, y: 72 };
			await this.plugin.persistData();
			await this.reloadMap();
			const document = this.documentNodes.find((item) => item.path === file.path);
			if (document) this.selectDocument(document);
			await this.commitHistory(history);
			new Notice('内容文件已创建');
		} catch (error) {
			if (createdFile) {
				removeRegisteredDocument(this.activeMap, createdFile.path);
				try {
					await this.app.vault.delete(createdFile);
				} catch {
					// Keep the original operation error.
				}
			}
			this.showError(error, '创建内容文件失败');
		}
	}

	private async createDocumentForTask(
		task: TaskNode,
		position?: NodePosition,
	): Promise<void> {
		let createdFile: TFile | null = null;
		let linkedTask: TaskNode | null = null;
		const history = await this.beginHistory('创建并关联任务内容');
		try {
			let currentTask = task;
			if (!currentTask.taskId) {
				const candidate = this.nextTaskId();
				const oldKey = taskPositionKey(currentTask);
				const oldPosition = this.activeMap.nodePositions[oldKey];
				await assignTaskId(this.app, currentTask, candidate);
				if (oldPosition) {
					delete this.activeMap.nodePositions[oldKey];
					this.activeMap.nodePositions[`id:${candidate}`] = oldPosition;
				}
				await this.reloadMap();
				currentTask = this.graphData.nodes.find((node) => node.taskId === candidate) ?? currentTask;
			}
			const file = await createContentDocument(
				this.app,
				currentTask.path,
				currentTask.text,
				currentTask.taskId,
			);
			createdFile = file;
			registerDocument(this.activeMap, file.path, true);
			await changeTaskDocumentLink(this.app, currentTask, file.path, true);
			linkedTask = currentTask;
			const taskLayout = this.createPositionedLayout().nodes.find((node) => node.id === currentTask.id);
			const suggested = position ?? (
				taskLayout && !('nodeType' in taskLayout)
					? { x: taskLayout.x, y: taskLayout.y + taskLayout.height + 92 }
					: this.graphCanvas?.getViewportCenter() ?? { x: 72, y: 72 }
			);
			this.activeMap.nodePositions[documentPositionKey(file.path)] = this.findFreePosition(suggested);
			await this.plugin.persistData();
			await this.reloadMap();
			const document = this.documentNodes.find((item) => item.path === file.path);
			if (document) this.selectDocument(document);
			await this.commitHistory(history);
			new Notice('任务内容已创建并关联');
		} catch (error) {
			if (linkedTask && createdFile) {
				try {
					await changeTaskDocumentLink(this.app, linkedTask, createdFile.path, false);
				} catch {
					// Keep the original operation error; the remaining link is still visible in Markdown.
				}
			}
			if (createdFile) {
				removeRegisteredDocument(this.activeMap, createdFile.path);
				try {
					await this.app.vault.delete(createdFile);
				} catch {
					// Keep the original operation error.
				}
			}
			this.showError(error, '创建任务内容失败');
		}
	}

	private async chooseDocumentForTask(task: TaskNode): Promise<void> {
		const excluded = new Set(this.taskCache.keys());
		const file = await chooseMarkdownFile(this.app, '关联已有内容文件', excluded);
		if (!file) return;
		const existing = this.documentNodes.find((document) => document.path === file.path) ?? {
			id: `doc:${file.path}`,
			nodeType: 'document' as const,
			path: file.path,
			title: file.basename,
			excerpt: '',
			wordCount: 0,
			checklistDone: 0,
			checklistTotal: 0,
			mtime: file.stat.mtime,
			linkedTaskIds: [],
			missing: false,
		};
		await this.linkDocumentToTask(task, existing);
	}

	private async linkDocumentToTask(task: TaskNode, document: DocumentNode): Promise<void> {
		if (document.linkedTaskIds.includes(task.id)) {
			new Notice('这个内容文件已经关联该任务');
			return;
		}
		let path = document.path;
		const oldTaskKey = taskPositionKey(task);
		const oldTaskPosition = this.activeMap.nodePositions[oldTaskKey];
		let oldPath = path;
		let moved = false;
		let linkWritten = false;
		const mapSnapshots = this.plugin.data.maps.map((map) => ({
			map,
			documents: map.documents.map((item) => ({ ...item })),
			nodePositions: { ...map.nodePositions },
		}));
		const history = await this.beginHistory('建立内容关联', { allMaps: true });
		try {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) throw new Error(`找不到内容文件：${path}`);
			if (document.linkedTaskIds.length === 0) {
				const targetFolder = contentFolderForFile(task.path);
				const currentFolder = file.parent?.path ?? '';
				if (currentFolder !== targetFolder) {
					const shouldMove = await confirmAction(
						this.app,
						'移动内容文件？',
						`这是该内容首次关联任务。是否移动到“${targetFolder}”目录？选择取消将保留原位置并继续关联。`,
						'移动并关联',
						false,
					);
					if (shouldMove) {
						oldPath = path;
						path = await moveContentDocumentBesideTask(this.app, file, task.path);
						moved = true;
						this.plugin.data.maps.forEach((map) => {
							replaceRegisteredDocumentPath(map, oldPath, path);
						});
					}
				}
			}
			registerDocument(this.activeMap, path, true);
			await changeTaskDocumentLink(this.app, task, path, true);
			linkWritten = true;
			if (!this.activeMap.nodePositions[documentPositionKey(path)]) {
				const taskNode = this.createPositionedLayout().nodes.find((node) => node.id === task.id);
				const position = taskNode && !('nodeType' in taskNode)
					? { x: taskNode.x, y: taskNode.y + taskNode.height + 92 }
					: this.graphCanvas?.getViewportCenter() ?? { x: 72, y: 72 };
				this.activeMap.nodePositions[documentPositionKey(path)] = this.findFreePosition(position);
			}
			await this.plugin.persistData();
			await this.reloadMap();
			await this.restoreTaskPosition(task, oldTaskKey, oldTaskPosition);
			const updated = this.documentNodes.find((item) => item.path === path);
			if (updated) this.selectDocument(updated);
			await this.commitHistory(history);
			new Notice('内容关联已建立');
		} catch (error) {
			if (linkWritten) {
				try {
					await changeTaskDocumentLink(this.app, task, path, false);
				} catch {
					// Preserve the original failure.
				}
			}
			if (moved) {
				const movedFile = this.app.vault.getAbstractFileByPath(path);
				if (movedFile instanceof TFile) {
					try {
						await this.app.fileManager.renameFile(movedFile, oldPath);
					} catch {
						// Preserve the original failure.
					}
				}
			}
			mapSnapshots.forEach(({ map, documents, nodePositions }) => {
				map.documents = documents;
				map.nodePositions = nodePositions;
			});
			try {
				await this.plugin.persistData();
			} catch {
				// Preserve the original failure.
			}
			this.showError(error, '建立内容关联失败');
		}
	}

	private async unlinkDocumentFromTask(task: TaskNode, document: DocumentNode): Promise<void> {
		const oldKey = taskPositionKey(task);
		const oldPosition = this.activeMap.nodePositions[oldKey];
		const history = await this.beginHistory('解除内容关联');
		try {
			await changeTaskDocumentLink(this.app, task, document.path, false);
			await this.reloadMap();
			await this.restoreTaskPosition(task, oldKey, oldPosition);
			const updated = this.documentNodes.find((item) => item.path === document.path);
			if (updated) this.selectDocument(updated);
			await this.commitHistory(history);
			new Notice('内容关联已解除，文件仍然保留');
		} catch (error) {
			this.showError(error, '解除内容关联失败');
		}
	}

	private expandAndSelectDocument(document: DocumentNode): void {
		const historyBefore = this.mapHistoryState(this.activeMap);
		registerDocument(this.activeMap, document.path, true);
		this.recordConfigHistory('展开内容卡', historyBefore);
		this.queueSave();
		this.renderGraph();
		const updated = this.documentNodes.find((item) => item.path === document.path);
		if (updated) this.selectDocument(updated);
	}

	private async removeDocumentFromCanvas(document: DocumentNode): Promise<void> {
		if (!await this.flushDocumentEditor()) return;
		const historyBefore = this.mapHistoryState(this.activeMap);
		const config = this.activeMap.documents.find((item) => item.path === document.path);
		if (config) config.expanded = false;
		delete this.activeMap.nodePositions[documentPositionKey(document.path)];
		this.selectedId = null;
		this.resetDocumentEditorState();
		await this.plugin.persistData();
		this.recordConfigHistory('收起内容卡', historyBefore);
		this.renderGraph();
		new Notice('内容卡已从画布收起，文件和任务关联均未删除');
	}

	private async openDocument(document: DocumentNode): Promise<void> {
		if (!await this.flushDocumentEditor()) return;
		const file = this.app.vault.getAbstractFileByPath(document.path);
		if (!(file instanceof TFile)) {
			new Notice(`找不到内容文件：${document.path}`);
			return;
		}
		await this.app.workspace.getLeaf('tab').openFile(file);
	}

	private async renameDocument(document: DocumentNode): Promise<void> {
		const title = await requestTextValue(
			this.app,
			'重命名内容文件',
			'新文件名',
			document.title,
		);
		if (!title) return;
		const file = this.app.vault.getAbstractFileByPath(document.path);
		if (!(file instanceof TFile)) return;
		const folder = file.parent?.path ?? '';
		const safeTitle = sanitizeDocumentTitle(title);
		if (safeTitle === file.basename) return;
		const target = uniqueDocumentPath(this.app, folder, safeTitle);
		const mapSnapshots = this.plugin.data.maps.map((map) => ({
			map,
			documents: map.documents.map((item) => ({ ...item })),
			nodePositions: { ...map.nodePositions },
		}));
		const history = await this.beginHistory('重命名内容文件', { allMaps: true });
		try {
			if (!await this.flushDocumentEditor()) return;
			const linkedTasks = document.linkedTaskIds
				.map((taskId) => this.graphData.nodes.find((node) => node.id === taskId))
				.filter((task): task is DerivedTaskNode => Boolean(task));
			await renameTaskDocumentLinks(
				this.app,
				linkedTasks,
				document.path,
				target,
				async () => {
					await this.app.fileManager.renameFile(file, target);
					this.plugin.data.maps.forEach((map) => {
						replaceRegisteredDocumentPath(map, document.path, target);
					});
					await this.plugin.persistData();
				},
			);
			await this.reloadMap();
			const updated = this.documentNodes.find((item) => item.path === target);
			if (updated) this.selectDocument(updated);
			await this.commitHistory(history);
		} catch (error) {
			const renamedFile = this.app.vault.getAbstractFileByPath(target);
			if (
				renamedFile instanceof TFile
				&& !this.app.vault.getAbstractFileByPath(document.path)
			) {
				try {
					await this.app.fileManager.renameFile(renamedFile, document.path);
				} catch {
					// Keep the original failure.
				}
			}
			mapSnapshots.forEach(({ map, documents, nodePositions }) => {
				map.documents = documents;
				map.nodePositions = nodePositions;
			});
			try {
				await this.plugin.persistData();
			} catch {
				// Keep the original failure.
			}
			this.showError(error, '重命名内容文件失败');
		}
	}

	private async deleteDocumentFile(document: DocumentNode): Promise<void> {
		const confirmed = await confirmAction(
			this.app,
			'删除内容文件？',
			`将删除“${document.title}”并从 ${document.linkedTaskIds.length} 个任务中清理关联。此操作可在当前会话中撤销。`,
			'删除文件',
			true,
		);
		if (!confirmed) return;
		const file = this.app.vault.getAbstractFileByPath(document.path);
		if (!(file instanceof TFile)) return;
		const mapSnapshots = this.plugin.data.maps.map((map) => ({
			map,
			documents: map.documents.map((item) => ({ ...item })),
			nodePositions: { ...map.nodePositions },
		}));
		const history = await this.beginHistory('删除内容文件', { allMaps: true });
		try {
			if (!await this.flushDocumentEditor()) return;
			const changes = document.linkedTaskIds
				.map((taskId) => this.graphData.nodes.find((node) => node.id === taskId))
				.filter((task): task is DerivedTaskNode => Boolean(task))
				.map((task) => ({ task, path: document.path, add: false }));
			await changeTaskDocumentLinks(
				this.app,
				changes,
				async () => {
					this.plugin.data.maps.forEach((map) => removeRegisteredDocument(map, document.path));
					await this.plugin.persistData();
					await this.app.fileManager.trashFile(file);
				},
			);
			this.selectedId = null;
			this.resetDocumentEditorState();
			await this.reloadMap();
			await this.commitHistory(history);
			new Notice('内容文件已删除');
		} catch (error) {
			mapSnapshots.forEach(({ map, documents, nodePositions }) => {
				map.documents = documents;
				map.nodePositions = nodePositions;
			});
			try {
				await this.plugin.persistData();
			} catch {
				// Keep the original failure.
			}
			this.showError(error, '删除内容文件失败');
		}
	}

	private async rebindMissingDocument(document: DocumentNode): Promise<void> {
		const file = await chooseMarkdownFile(
			this.app,
			'重新绑定内容文件',
			new Set(this.taskCache.keys()),
		);
		if (!file) return;
		const mapSnapshots = this.plugin.data.maps.map((map) => ({
			map,
			documents: map.documents.map((item) => ({ ...item })),
			nodePositions: { ...map.nodePositions },
		}));
		const history = await this.beginHistory('重新绑定内容文件', { allMaps: true });
		try {
			const linkedTasks = document.linkedTaskIds
				.map((taskId) => this.graphData.nodes.find((node) => node.id === taskId))
				.filter((task): task is DerivedTaskNode => Boolean(task));
			await renameTaskDocumentLinks(
				this.app,
				linkedTasks,
				document.path,
				file.path,
				async () => {
					this.plugin.data.maps.forEach((map) => {
						replaceRegisteredDocumentPath(map, document.path, file.path);
					});
					await this.plugin.persistData();
				},
			);
			await this.reloadMap();
			const updated = this.documentNodes.find((item) => item.path === file.path);
			if (updated) this.selectDocument(updated);
			await this.commitHistory(history);
		} catch (error) {
			mapSnapshots.forEach(({ map, documents, nodePositions }) => {
				map.documents = documents;
				map.nodePositions = nodePositions;
			});
			try {
				await this.plugin.persistData();
			} catch {
				// Keep the original failure.
			}
			this.showError(error, '重新绑定内容文件失败');
		}
	}

	private async writeNewTask(target: TaskTarget, line: string): Promise<TFile> {
		if (target.file) {
			await appendTaskLine(this.app, target.file, line);
			return target.file;
		}
		if (!target.newPath) throw new Error('没有有效的目标文件');
		return this.app.vault.create(target.newPath, `${normalizeTaskLine(line)}\n`);
	}

	private nextTaskId(): string {
		return createTaskId(
			this.graphData.nodes
				.map((node) => node.taskId)
				.filter((id): id is string => Boolean(id)),
		);
	}

	private async createSuccessor(parent: DerivedTaskNode, preferredPosition?: NodePosition): Promise<void> {
		if (parent.warnings.includes('duplicate-id')) {
			new Notice('请先在详情面板为这个任务重新生成唯一 ID');
			return;
		}
		const api = getTasksApi(this.app);
		if (!api) {
			new Notice('需要安装并启用 Tasks 插件后才能创建后续任务');
			return;
		}
		const target = await chooseTaskTarget(this.app, this.activeMap, parent.path);
		if (!target) return;
		const candidateId = parent.taskId ?? this.nextTaskId();
		const usedIds = new Set(this.graphData.nodes.flatMap((node) => node.taskId ? [node.taskId] : []));
		usedIds.add(candidateId);
		const candidateChildId = createTaskId(usedIds);
		const taskLine = await api.editTaskLineModal(`- [ ] 🆔 ${candidateChildId} ⛔ ${candidateId}`);
		if (!taskLine) return;
		const oldParentKey = taskPositionKey(parent);
		const parentPosition = this.activeMap.nodePositions[oldParentKey];
		let targetFile = target.file;
		let createdFile: TFile | null = null;
		const history = await this.beginHistory('创建后续任务');
		try {
			if (!targetFile && target.newPath) {
				createdFile = await this.app.vault.create(target.newPath, '');
				targetFile = createdFile;
			}
			if (!targetFile) throw new Error('没有有效的目标文件');
			const result = await createSuccessorTask(
				this.app,
				parent,
				targetFile,
				taskLine,
				candidateId,
				candidateChildId,
			);
			if (result.parentWasUpdated && parentPosition) {
				delete this.activeMap.nodePositions[oldParentKey];
				this.activeMap.nodePositions[`id:${result.parentId}`] = parentPosition;
			}
			await this.reloadMap();
			const child = (this.taskCache.get(targetFile.path) ?? [])
				.filter((task) => task.taskId === result.childId)
				.sort((a, b) => b.line - a.line)[0];
			if (child) {
				this.activeMap.nodePositions[taskPositionKey(child)] = this.findBranchAppendPosition(
					result.parentId,
					child,
					'successor',
					preferredPosition,
				);
				this.selectedId = child.id;
			}
			this.currentFilePath = targetFile.path;
			await this.plugin.persistData();
			this.renderSourcePanel();
			this.renderGraph();
			await this.commitHistory(history);
			new Notice('后续任务已创建');
		} catch (error) {
			if (createdFile) {
				try {
					await this.app.vault.delete(createdFile);
				} catch {
					// The write error is more useful than a cleanup error.
				}
			}
			this.showError(error, '创建后续任务失败');
		}
	}

	private async createPredecessor(child: DerivedTaskNode, preferredPosition?: NodePosition): Promise<void> {
		if (child.warnings.includes('duplicate-id')) {
			new Notice('请先在详情面板为这个任务重新生成唯一 ID');
			return;
		}
		const api = getTasksApi(this.app);
		if (!api) {
			new Notice('需要安装并启用 Tasks 插件后才能创建前置任务');
			return;
		}
		const target = await chooseTaskTarget(this.app, this.activeMap, child.path);
		if (!target) return;
		const candidateParentId = this.nextTaskId();
		const usedIds = new Set(this.graphData.nodes.flatMap((node) => node.taskId ? [node.taskId] : []));
		usedIds.add(candidateParentId);
		const candidateChildId = child.taskId ?? createTaskId(usedIds);
		const taskLine = await api.editTaskLineModal(`- [ ] 🆔 ${candidateParentId}`);
		if (!taskLine) return;
		const oldChildKey = taskPositionKey(child);
		const childPosition = this.activeMap.nodePositions[oldChildKey];
		let targetFile = target.file;
		let createdFile: TFile | null = null;
		const history = await this.beginHistory('创建前置任务');
		try {
			if (!targetFile && target.newPath) {
				createdFile = await this.app.vault.create(target.newPath, '');
				targetFile = createdFile;
			}
			if (!targetFile) throw new Error('没有有效的目标文件');
			const result = await createPredecessorTask(
				this.app,
				child,
				targetFile,
				taskLine,
				candidateParentId,
				candidateChildId,
			);
			if (result.childWasUpdated && childPosition) {
				delete this.activeMap.nodePositions[oldChildKey];
				this.activeMap.nodePositions[`id:${result.childId}`] = childPosition;
			}
			await this.reloadMap();
			const parent = (this.taskCache.get(targetFile.path) ?? []).find(
				(task) => task.taskId === result.parentId,
			);
			if (parent) {
				this.activeMap.nodePositions[taskPositionKey(parent)] = this.findBranchAppendPosition(
					result.childId,
					parent,
					'predecessor',
					preferredPosition,
				);
				this.selectedId = parent.id;
			}
			this.currentFilePath = targetFile.path;
			await this.plugin.persistData();
			this.renderSourcePanel();
			this.renderGraph();
			await this.commitHistory(history);
			new Notice('前置任务已创建');
		} catch (error) {
			if (createdFile) {
				try {
					await this.app.vault.delete(createdFile);
				} catch {
					// Keep the original write error.
				}
			}
			this.showError(error, '创建前置任务失败');
		}
	}

	private wouldCreateCycle(parent: DerivedTaskNode, child: DerivedTaskNode): boolean {
		if (parent.id === child.id) return true;
		const outgoing = new Map<string, string[]>();
		this.graphData.edges.filter((edge) => !edge.missing).forEach((edge) => {
			const values = outgoing.get(edge.sourceId) ?? [];
			values.push(edge.targetId);
			outgoing.set(edge.sourceId, values);
		});
		const pending = [child.id];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const id = pending.pop()!;
			if (id === parent.id) return true;
			if (visited.has(id)) continue;
			visited.add(id);
			pending.push(...(outgoing.get(id) ?? []));
		}
		return false;
	}

	private async connectNodes(parent: DerivedTaskNode, child: DerivedTaskNode): Promise<void> {
		if (parent.warnings.includes('duplicate-id') || child.warnings.includes('duplicate-id')) {
			new Notice('存在重复任务 ID，请先在详情面板重新生成唯一 ID');
			return;
		}
		if (parent.id === child.id) {
			new Notice('不能把任务连接到自身');
			return;
		}
		if (parent.taskId && child.blockedByIds.includes(parent.taskId)) {
			new Notice('这两个任务已经存在前置关系');
			return;
		}
		if (this.wouldCreateCycle(parent, child)) {
			new Notice('无法建立关系：这会形成循环依赖');
			return;
		}
		const parentOldKey = taskPositionKey(parent);
		const childOldKey = taskPositionKey(child);
		const parentPosition = this.activeMap.nodePositions[parentOldKey];
		const childPosition = this.activeMap.nodePositions[childOldKey];
		const parentCandidate = parent.taskId ?? this.nextTaskId();
		const used = new Set(this.graphData.nodes.flatMap((node) => node.taskId ? [node.taskId] : []));
		used.add(parentCandidate);
		const childCandidate = child.taskId ?? createTaskId(used);
		const history = await this.beginHistory('建立任务关系');
		try {
			const result = await connectTasks(
				this.app,
				parent,
				child,
				parentCandidate,
				childCandidate,
			);
			if (result.parentWasUpdated && parentPosition) {
				delete this.activeMap.nodePositions[parentOldKey];
				this.activeMap.nodePositions[`id:${result.parentId}`] = parentPosition;
			}
			if (result.childWasUpdated && childPosition) {
				delete this.activeMap.nodePositions[childOldKey];
				this.activeMap.nodePositions[`id:${result.childId}`] = childPosition;
			}
			await this.plugin.persistData();
			await this.reloadMap();
			await this.commitHistory(history);
			new Notice('任务关系已建立');
		} catch (error) {
			this.showError(error, '建立任务关系失败');
		}
	}

	private async removeRelationship(parent: DerivedTaskNode, child: DerivedTaskNode): Promise<void> {
		const confirmed = await confirmAction(
			this.app,
			'解除任务关系？',
			`将解除“${parent.text}”作为“${child.text}”前置任务的关系，不会删除任何任务。`,
			'解除关系',
			false,
		);
		if (!confirmed) return;
		const history = await this.beginHistory('解除任务关系');
		try {
			await removeTaskRelationship(this.app, parent, child);
			await this.reloadMap();
			await this.commitHistory(history);
			new Notice('任务关系已解除');
		} catch (error) {
			this.showError(error, '解除任务关系失败');
		}
	}

	private findBranchAppendPosition(
		anchorTaskId: string,
		newNode: TaskNode,
		direction: 'successor' | 'predecessor',
		preferred?: NodePosition,
	): NodePosition {
		const layout = this.createPositionedLayout();
		const anchor = layout.nodes.find((node) => (
			!('nodeType' in node) && node.taskId === anchorTaskId
		)) as PositionedTaskNode | undefined;
		const siblingIds = new Set(
			this.graphData.edges
				.filter((edge) => {
					if (edge.missing) return false;
					return direction === 'successor'
						? edge.sourceId === anchor?.id && edge.targetId !== newNode.id
						: edge.targetId === anchor?.id && edge.sourceId !== newNode.id;
				})
				.map((edge) => direction === 'successor' ? edge.targetId : edge.sourceId),
		);
		const siblings = layout.nodes.filter((node): node is PositionedTaskNode => (
			!('nodeType' in node) && siblingIds.has(node.id)
		));
		const defaultX = direction === 'successor'
			? (anchor?.x ?? 72) + 328
			: Math.max(24, (anchor?.x ?? 400) - 328);
		const branchX = preferred?.x ?? siblings[0]?.x ?? defaultX;
		const firstY = preferred?.y ?? anchor?.y ?? 72;
		const afterSiblingsY = siblings.length > 0
			? Math.max(...siblings.map((node) => node.y + node.height + 34))
			: firstY;
		const branchY = siblings.length > 0
			? Math.max(firstY, afterSiblingsY)
			: firstY;
		const newNodeKey = taskPositionKey(newNode);
		return this.findFreePosition(
			{ x: branchX, y: branchY },
			new Set([newNodeKey]),
		);
	}

	private findFreePosition(preferred: NodePosition, ignoredKeys = new Set<string>()): NodePosition {
		const occupied = Object.entries(this.activeMap.nodePositions)
			.filter(([key]) => !ignoredKeys.has(key))
			.map(([, position]) => position);
		let candidate = { ...preferred };
		for (let attempt = 0; attempt < 30; attempt += 1) {
			const collision = occupied.some((position) => (
				Math.abs(position.x - candidate.x) < 240 && Math.abs(position.y - candidate.y) < 126
			));
			if (!collision) return candidate;
			candidate = { x: preferred.x, y: preferred.y + (attempt + 1) * 148 };
		}
		return candidate;
	}

	private async editTask(task: TaskNode): Promise<void> {
		const api = getTasksApi(this.app);
		if (!api) {
			new Notice('需要安装并启用 Tasks 插件后才能编辑任务');
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(task.path);
		if (!(file instanceof TFile)) {
			new Notice(`找不到文件：${task.path}`);
			return;
		}
		try {
			const content = await this.app.vault.read(file);
			const lines = content.split(/\r?\n/);
			const lineIndex = findTaskLine(lines, task);
			if (lineIndex < 0) throw new Error(`找不到任务：${task.text}`);
			const editedLine = await api.editTaskLineModal(lines[lineIndex]);
			if (!editedLine) return;
			const protectedLine = task.taskId
				? replaceTaskId(editedLine, task.taskId)
				: task.blockedByIds.length > 0
					? ensureTaskId(editedLine, this.nextTaskId()).line
					: editedLine;
			const history = await this.beginHistory('编辑任务');
			const oldKey = taskPositionKey(task);
			const oldPosition = this.activeMap.nodePositions[oldKey];
			await replaceTaskLine(this.app, task, protectedLine);
			const parsed = parseTaskFile(task.path, normalizeTaskLine(protectedLine))[0];
			if (parsed && oldPosition) {
				const newKey = taskPositionKey(parsed);
				if (newKey !== oldKey) delete this.activeMap.nodePositions[oldKey];
				this.activeMap.nodePositions[newKey] = oldPosition;
			}
			await this.plugin.persistData();
			await this.reloadMap();
			await this.commitHistory(history);
			new Notice('任务已更新');
		} catch (error) {
			this.showError(error, '编辑任务失败');
		}
	}

	private async generateTaskId(task: DerivedTaskNode): Promise<void> {
		const candidate = this.nextTaskId();
		const oldKey = taskPositionKey(task);
		const oldPosition = this.activeMap.nodePositions[oldKey];
		const history = await this.beginHistory('生成任务 ID');
		try {
			await assignTaskId(this.app, task, candidate, Boolean(task.taskId));
			if (oldPosition) {
				delete this.activeMap.nodePositions[oldKey];
				this.activeMap.nodePositions[`id:${candidate}`] = oldPosition;
			}
			await this.plugin.persistData();
			await this.reloadMap();
			const updated = this.graphData.nodes.find((node) => node.taskId === candidate);
			if (updated) this.selectNode(updated as PositionedTaskNode);
			await this.commitHistory(history);
			new Notice(`任务 ID 已生成：${candidate}`);
		} catch (error) {
			this.showError(error, '生成任务 ID 失败');
		}
	}

	private async repairRelationshipIds(tasks: TaskNode[]): Promise<void> {
		const confirmed = await confirmAction(
			this.app,
			'修复关系任务 ID？',
			`将为 ${tasks.length} 个参与关系但缺少 ID 的任务写入唯一 ID，并保留当前布局。`,
			'修复 ID',
			false,
		);
		if (!confirmed) return;
		const oldPositions = new Map(tasks.map((task) => [
			task.id,
			{ key: taskPositionKey(task), position: this.activeMap.nodePositions[taskPositionKey(task)] },
		]));
		const history = await this.beginHistory('修复任务 ID');
		try {
			const assigned = await repairTaskIds(
				this.app,
				tasks,
				this.graphData.nodes.flatMap((node) => node.taskId ? [node.taskId] : []),
			);
			assigned.forEach((taskId, internalId) => {
				const previous = oldPositions.get(internalId);
				if (!previous?.position) return;
				delete this.activeMap.nodePositions[previous.key];
				this.activeMap.nodePositions[`id:${taskId}`] = previous.position;
			});
			await this.plugin.persistData();
			await this.reloadMap();
			await this.commitHistory(history);
			new Notice(`已修复 ${assigned.size} 个任务 ID`);
		} catch (error) {
			this.showError(error, '批量修复任务 ID 失败');
		}
	}

	private async toggleStar(task: TaskNode): Promise<void> {
		const oldKey = taskPositionKey(task);
		const oldPosition = this.activeMap.nodePositions[oldKey];
		const history = await this.beginHistory(task.starred ? '取消星标' : '添加星标');
		try {
			await setTaskStar(this.app, task, !task.starred);
			await this.reloadMap();
			await this.restoreTaskPosition(task, oldKey, oldPosition);
			await this.commitHistory(history);
		} catch (error) {
			this.showError(error, '更新星标失败');
		}
	}

	private async addTag(task: TaskNode): Promise<void> {
		const tag = await requestTextValue(this.app, '添加任务标签', '标签', '例如：设计');
		if (!tag) return;
		const oldKey = taskPositionKey(task);
		const oldPosition = this.activeMap.nodePositions[oldKey];
		const history = await this.beginHistory('添加标签');
		try {
			await changeTaskTag(this.app, task, tag, true);
			await this.reloadMap();
			await this.restoreTaskPosition(task, oldKey, oldPosition);
			await this.commitHistory(history);
		} catch (error) {
			this.showError(error, '添加标签失败');
		}
	}

	private async removeTag(task: TaskNode, tag: string): Promise<void> {
		const oldKey = taskPositionKey(task);
		const oldPosition = this.activeMap.nodePositions[oldKey];
		const history = await this.beginHistory('移除标签');
		try {
			await changeTaskTag(this.app, task, tag, false);
			await this.reloadMap();
			await this.restoreTaskPosition(task, oldKey, oldPosition);
			await this.commitHistory(history);
		} catch (error) {
			this.showError(error, '移除标签失败');
		}
	}

	private async deleteTask(task: DerivedTaskNode): Promise<void> {
		const dependents = task.id
			? this.graphData.nodes.filter((node) => task.dependentIds.includes(node.id))
			: [];
		const description = dependents.length > 0
			? `将删除“${task.text}”，并从 ${dependents.length} 个后续任务中解除对应依赖。此操作会修改笔记原文。`
			: `将从笔记中删除“${task.text}”。此操作可在当前会话中撤销。`;
		const confirmed = await confirmAction(this.app, '删除任务？', description);
		if (!confirmed) return;
		const history = await this.beginHistory('删除任务');
		try {
			await deleteTaskAndReferences(this.app, task, dependents);
			delete this.activeMap.nodePositions[taskPositionKey(task)];
			this.selectedId = null;
			await this.plugin.persistData();
			await this.reloadMap();
			await this.commitHistory(history);
			new Notice('任务已删除');
		} catch (error) {
			this.showError(error, '删除任务失败');
		}
	}

	private async openTask(task: TaskNode): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(task.path);
		if (!(file instanceof TFile)) {
			new Notice(`找不到文件：${task.path}`);
			return;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.openFile(file);
		window.setTimeout(() => {
			const view = leaf.view;
			if (view instanceof MarkdownView) {
				view.editor.setCursor({ line: task.line, ch: 0 });
				view.editor.scrollIntoView({
					from: { line: Math.max(0, task.line - 3), ch: 0 },
					to: { line: task.line + 3, ch: 0 },
				}, true);
				view.editor.focus();
			}
		}, 50);
	}

	private async toggleTask(task: TaskNode): Promise<void> {
		const api = getTasksApi(this.app);
		if (!api) {
			new Notice('需要安装并启用 Tasks 插件后才能更新任务状态');
			return;
		}
		const oldKey = taskPositionKey(task);
		const oldPosition = this.activeMap.nodePositions[oldKey];
		const history = await this.beginHistory('更新任务状态');
		try {
			if (task.status === 'todo') {
				await markTaskInProgress(this.app, task);
			} else {
				const file = this.app.vault.getAbstractFileByPath(task.path);
				if (!(file instanceof TFile)) throw new Error(`找不到文件：${task.path}`);
				const content = await this.app.vault.read(file);
				const lines = content.split(/\r?\n/);
				const lineIndex = findTaskLine(lines, task);
				if (lineIndex < 0) throw new Error(`找不到任务：${task.text}`);
				if (task.status === 'canceled') {
					lines[lineIndex] = lines[lineIndex]
						.replace(/^(\s*(?:>\s*)*(?:[-*+]|\d+\.)\s+)\[-\]/, '$1[ ]')
						.replace(/\s*❌\s*\d{4}-\d{2}-\d{2}/g, '');
					await this.app.vault.modify(file, lines.join('\n'));
				} else {
					const toggled = api.executeToggleTaskDoneCommand(lines[lineIndex], task.path);
					await replaceTaskLine(this.app, task, toggled);
				}
			}
			await this.reloadMap();
			await this.restoreTaskPosition(task, oldKey, oldPosition);
			await this.commitHistory(history);
		} catch (error) {
			this.showError(error, '任务更新失败');
		}
	}

	private async restoreTaskPosition(
		previousTask: TaskNode,
		oldKey: string,
		position?: NodePosition,
	): Promise<void> {
		if (!position) return;
		const updated = previousTask.taskId
			? this.graphData.nodes.find((node) => node.taskId === previousTask.taskId)
			: this.graphData.nodes.find((node) => (
				node.path === previousTask.path && node.line === previousTask.line
			));
		if (!updated) return;
		const newKey = taskPositionKey(updated);
		if (newKey === oldKey) return;
		delete this.activeMap.nodePositions[oldKey];
		this.activeMap.nodePositions[newKey] = position;
		await this.plugin.persistData();
		this.renderGraph();
	}

	private showError(error: unknown, fallback: string): void {
		new Notice(error instanceof Error ? error.message : fallback);
	}

	private scheduleReload(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.reloadMap();
		}, 280);
	}
}
