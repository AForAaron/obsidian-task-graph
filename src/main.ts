import { Plugin } from 'obsidian';
import { DEFAULT_PLUGIN_DATA, TaskGraphPluginData, TaskMapConfig } from './model/TaskGraphModel';
import { migratePluginData, renamePathValue, renameSourcePaths } from './services/PluginData';
import { TASK_GRAPH_VIEW, TaskGraphView } from './views/TaskGraphView';

export default class TaskGraphPlugin extends Plugin {
	data: TaskGraphPluginData = { ...DEFAULT_PLUGIN_DATA };
	pendingScopePath = '';

	async onload(): Promise<void> {
		this.data = migratePluginData(await this.loadData());

		this.registerView(
			TASK_GRAPH_VIEW,
			(leaf) => new TaskGraphView(leaf, this),
		);

		this.addRibbonIcon('git-fork', '打开 Task Graph', () => void this.activateView());
		this.addCommand({
			id: 'open-task-graph',
			name: '打开项目任务图',
			callback: () => void this.activateView(),
		});
		this.addCommand({
			id: 'undo-task-graph',
			name: '撤销 Task Graph 操作',
			checkCallback: (checking) => {
				const view = this.activeTaskGraphView();
				if (!view?.canUndo()) return false;
				if (!checking) void view.undo();
				return true;
			},
		});
		this.addCommand({
			id: 'redo-task-graph',
			name: '重做 Task Graph 操作',
			checkCallback: (checking) => {
				const view = this.activeTaskGraphView();
				if (!view?.canRedo()) return false;
				if (!checking) void view.redo();
				return true;
			},
		});

		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			this.pendingScopePath = renamePathValue(this.pendingScopePath, oldPath, file.path);
			if (renameSourcePaths(this.data.maps, oldPath, file.path)) void this.persistData();
		}));
	}

	async onunload(): Promise<void> {
		this.app.workspace.detachLeavesOfType(TASK_GRAPH_VIEW);
	}

	async activateView(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile?.extension === 'md') this.pendingScopePath = activeFile.path;

		let leaf = this.app.workspace.getLeavesOfType(TASK_GRAPH_VIEW)[0];
		if (!leaf) {
			leaf = this.app.workspace.getLeaf('tab');
			await leaf.setViewState({ type: TASK_GRAPH_VIEW, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
	}

	private activeTaskGraphView(): TaskGraphView | null {
		const active = this.app.workspace.getMostRecentLeaf()?.view;
		if (active instanceof TaskGraphView) return active;
		const leaf = this.app.workspace.getLeavesOfType(TASK_GRAPH_VIEW)[0];
		return leaf?.view instanceof TaskGraphView ? leaf.view : null;
	}

	getActiveMap(): TaskMapConfig {
		return this.data.maps.find((map) => map.id === this.data.activeMapId)
			?? this.data.maps[0];
	}

	async persistData(): Promise<void> {
		await this.saveData(this.data);
	}
}
