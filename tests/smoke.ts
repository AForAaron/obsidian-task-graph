import { readFileSync } from 'fs';
import { parseTaskFile } from '../src/services/TaskParser';
import { buildTaskGraph } from '../src/services/GraphBuilder';
import { layoutGraph } from '../src/layout/LayeredLayout';
import { layoutTaskDocuments } from '../src/layout/DocumentLayout';
import { migratePluginData, renamePathValue, renameSourcePaths } from '../src/services/PluginData';
import { taskPositionKey } from '../src/services/TaskParser';
import { resolveSourcePathRules } from '../src/services/SourceRules';
import { runSuccessorWriteTransaction } from '../src/services/WriteTransaction';
import { HistoryManager, HistorySnapshot } from '../src/services/HistoryManager';
import {
	addDependency,
	addDocumentLink,
	addTaskTag,
	ensureTaskId,
	ensureSuccessorTaskMetadata,
	readDependencyIds,
	removeDependency,
	removeDocumentLink,
	removeTaskTag,
	replaceDocumentLink,
	replaceTaskLineText,
	setTaskStarred,
} from '../src/services/TaskLineMetadata';
import { createTaskId } from '../src/services/TaskId';
import {
	calculateDocumentStats,
	contentFolderForFile,
	documentPositionKey,
	sanitizeDocumentTitle,
} from '../src/services/DocumentMetadata';

let assertionCount = 0;

function assert(condition: boolean, message: string): void {
	assertionCount += 1;
	if (!condition) throw new Error(message);
}

const canvasStyles = readFileSync('src/styles/main.css', 'utf8');
assert(
	/\.tgf-node-layer\s*\{[^}]*pointer-events:\s*none/s.test(canvasStyles)
		&& /\.tgf-node\s*\{[^}]*pointer-events:\s*auto/s.test(canvasStyles)
		&& /\.tgf-edge-hit\s*\{[^}]*pointer-events:\s*stroke/s.test(canvasStyles),
	'节点透明容器应允许事件穿透，同时保留节点和依赖线命中区域',
);

const sample = [
	'- [ ] 项目根 🆔 root001',
	'- [ ] 设计界面 🆔 design01 ⛔ root001',
	'- [/] 开发画布 🆔 canvas01 ⛔ design01 🛫 2026-06-28',
	'- [x] 调研 ✅ 2026-06-27 🆔 research01',
].join('\n');

const sampleTasks = parseTaskFile('sample.md', sample);
assert(sampleTasks.length === 4, '应解析 4 个任务');
assert(sampleTasks[1].blockedByIds[0] === 'root001', '应解析阻塞关系');
assert(sampleTasks[2].status === 'in_progress', '应解析进行中状态');

const documentTask = parseTaskFile(
	'Projects/Plan.md',
	'- [ ] 写方案 🆔 plan01 📄 [[Projects/任务内容/plan01-写方案|任务内容]]',
)[0];
assert(documentTask.text === '写方案', '内容 WikiLink 不应进入任务卡标题');
assert(
	documentTask.documentLinks[0] === 'Projects/任务内容/plan01-写方案.md',
	'应解析内容 WikiLink 为规范 Markdown 路径',
);
const linkedTaskLine = addDocumentLink('- [ ] 写方案 🆔 plan01', 'Projects/任务内容/方案.md');
assert(linkedTaskLine.includes('📄 [[Projects/任务内容/方案|任务内容]]'), '应写入可读内容 WikiLink');
assert(
	addDocumentLink(linkedTaskLine, '/Projects/任务内容/方案.md') === linkedTaskLine,
	'重复添加同一内容路径时不应写入第二个 WikiLink',
);
assert(!removeDocumentLink(linkedTaskLine, 'Projects/任务内容/方案.md').includes('📄'), '应解除指定内容关联');
const shortDocumentLink = '- [ ] 写方案 🆔 plan01 📄 [[方案|任务内容]]';
assert(
	!removeDocumentLink(
		shortDocumentLink,
		'Projects/任务内容/方案.md',
		['方案.md'],
	).includes('📄'),
	'应使用已解析的短 WikiLink 别名解除内容关联',
);
assert(
	replaceDocumentLink(
		shortDocumentLink,
		'Projects/任务内容/方案.md',
		'Archive/方案.md',
		['方案.md'],
	).includes('[[Archive/方案|任务内容]]'),
	'应使用已解析的短 WikiLink 别名重绑内容关联',
);
assert(
	replaceTaskLineText(
		'  > 1. [ ] 嵌套任务 🆔 nested01',
		'- [/] 嵌套任务 🆔 nested01 🛫 2026-07-01',
	) === '  > 1. [/] 嵌套任务 🆔 nested01 🛫 2026-07-01',
	'任务写回应保留缩进、引用和原列表标记',
);

const documentStats = calculateDocumentStats([
	'# 方案',
	'这是正文 abc words。',
	'- [x] 已完成',
	'- [ ] 未完成',
].join('\n'));
assert(documentStats.checklistDone === 1 && documentStats.checklistTotal === 2, '应统计正文清单进度');
assert(documentStats.wordCount > 0, '应统计中英文正文字数');
assert(contentFolderForFile('Projects/Plan.md') === 'Projects/任务内容', '内容目录应位于任务文件同目录');
assert(documentPositionKey('Projects/任务内容/方案.md') === 'doc:Projects/任务内容/方案.md', '内容节点应使用独立位置键');
assert(sanitizeDocumentTitle('  A/B: C?  ') === 'A-B- C-', '内容标题应移除文件名非法字符');
assert(sanitizeDocumentTitle('...') === '未命名内容', '清理为空的内容标题应使用安全默认值');

const sampleGraph = buildTaskGraph(sampleTasks);
assert(sampleGraph.edges.length === 2, '应建立 2 条依赖边');
assert(sampleGraph.nodes.find((node) => node.taskId === 'root001')?.readiness === 'ready', '根任务应可开始');
assert(sampleGraph.nodes.find((node) => node.taskId === 'design01')?.readiness === 'blocked', '子任务应被阻塞');
assert(sampleGraph.nodes.find((node) => node.taskId === 'canvas01')?.readiness === 'active', '进行中任务应为 active');

const layout = layoutGraph(sampleGraph.nodes, sampleGraph.edges);
const root = layout.nodes.find((node) => node.taskId === 'root001');
const child = layout.nodes.find((node) => node.taskId === 'design01');
assert(Boolean(root && child && root.x < child.x), '前置任务应排在依赖任务左侧');

const documentLayout = layoutTaskDocuments(
	layout,
	[
		{
			id: 'doc:root.md',
			nodeType: 'document',
			path: 'root.md',
			title: '根任务内容',
			excerpt: '',
			wordCount: 0,
			checklistDone: 0,
			checklistTotal: 0,
			mtime: 0,
			linkedTaskIds: [sampleGraph.nodes[0].id],
			missing: false,
		},
		{
			id: 'doc:child.md',
			nodeType: 'document',
			path: 'child.md',
			title: '子任务内容',
			excerpt: '',
			wordCount: 0,
			checklistDone: 0,
			checklistTotal: 0,
			mtime: 0,
			linkedTaskIds: [sampleGraph.nodes[1].id],
			missing: false,
		},
	],
	new Set(['root.md', 'child.md']),
);
const rootWithContent = documentLayout.tasks.find((node) => node.taskId === 'root001');
const rootDocument = documentLayout.documents.find((node) => node.path === 'root.md');
assert(
	Boolean(rootWithContent && rootDocument && rootDocument.x === rootWithContent.x
		&& rootDocument.y > rootWithContent.y + rootWithContent.height),
	'单任务内容应紧贴并对齐其所属任务下方',
);
const mixedDocumentLayout = layoutTaskDocuments(
	layout,
	[
		{
			id: 'doc:shared.md',
			nodeType: 'document',
			path: 'shared.md',
			title: '共享内容',
			excerpt: '',
			wordCount: 0,
			checklistDone: 0,
			checklistTotal: 0,
			mtime: 0,
			linkedTaskIds: [sampleGraph.nodes[0].id, sampleGraph.nodes[1].id],
			missing: false,
		},
		{
			id: 'doc:standalone.md',
			nodeType: 'document',
			path: 'standalone.md',
			title: '独立内容',
			excerpt: '',
			wordCount: 0,
			checklistDone: 0,
			checklistTotal: 0,
			mtime: 0,
			linkedTaskIds: [],
			missing: false,
		},
	],
	new Set(['shared.md', 'standalone.md']),
);
assert(
	mixedDocumentLayout.documents.find((document) => document.path === 'shared.md')?.layer === -2,
	'多任务共享内容应进入共享内容布局层',
);
assert(
	mixedDocumentLayout.documents.find((document) => document.path === 'standalone.md')?.layer === -3,
	'无关联内容应进入独立内容布局层',
);

const orderedBranchTasks = parseTaskFile('ordered-branch.md', [
	'- [ ] 父任务 🆔 parent01',
	'- [ ] 后创建但行号靠前的分支 ➕ 2026-06-28 🆔 branch02 ⛔ parent01',
	'- [ ] 后创建分支的子任务 ➕ 2026-06-28 🆔 child002 ⛔ branch02',
	'- [ ] 先创建但行号靠后的分支 ➕ 2026-06-26 🆔 branch01 ⛔ parent01',
	'- [ ] 先创建分支的子任务 ➕ 2026-06-29 🆔 child001 ⛔ branch01',
].join('\n'));
const orderedBranchGraph = buildTaskGraph(orderedBranchTasks);
const orderedBranchLayout = layoutGraph(orderedBranchGraph.nodes, orderedBranchGraph.edges);
const firstBranch = orderedBranchLayout.nodes.find((node) => node.taskId === 'branch01');
const secondBranch = orderedBranchLayout.nodes.find((node) => node.taskId === 'branch02');
assert(
	Boolean(firstBranch && secondBranch && firstBranch.y < secondBranch.y),
	'同一父任务的后创建分支应排在已有分支下方',
);
const firstBranchChild = orderedBranchLayout.nodes.find((node) => node.taskId === 'child001');
const secondBranchChild = orderedBranchLayout.nodes.find((node) => node.taskId === 'child002');
assert(
	Boolean(firstBranchChild && secondBranchChild && firstBranchChild.y < secondBranchChild.y),
	'子节点应继承父分支的上下顺序，避免跨分支连线交叉',
);
const branchDocumentLayout = layoutTaskDocuments(
	orderedBranchLayout,
	[
		{
			id: 'doc:branch01.md',
			nodeType: 'document',
			path: 'branch01.md',
			title: '分支一内容',
			excerpt: '',
			wordCount: 0,
			checklistDone: 0,
			checklistTotal: 0,
			mtime: 0,
			linkedTaskIds: [firstBranch!.id],
			missing: false,
		},
	],
	new Set(['branch01.md']),
);
const reservedFirstBranchDocument = branchDocumentLayout.documents[0];
const reservedSecondBranch = branchDocumentLayout.tasks.find((node) => node.taskId === 'branch02');
assert(
	Boolean(reservedSecondBranch
		&& reservedSecondBranch.y > reservedFirstBranchDocument.y + reservedFirstBranchDocument.height),
	'同层下一任务应排在上一任务的内容区之后，避免内容归属混淆',
);

const isolated = layout.nodes.find((node) => node.taskId === 'research01');
assert(Boolean(isolated && isolated.layer === -1), '无关联任务应进入独立网格区域');

const forestTasks = parseTaskFile('forest.md', [
	'- [ ] 树 A 根 🆔 treea0',
	'- [ ] 树 A 子 🆔 treea1 ⛔ treea0',
	'- [ ] 树 A 孙 🆔 treea2 ⛔ treea1',
	'- [ ] 树 B 根 🆔 treeb0',
	'- [ ] 树 B 子 🆔 treeb1 ⛔ treeb0',
].join('\n'));
const forestGraph = buildTaskGraph(forestTasks);
const forestLayout = layoutGraph(forestGraph.nodes, forestGraph.edges);
const treeANodes = forestLayout.nodes.filter((node) => node.taskId?.startsWith('treea'));
const treeBNodes = forestLayout.nodes.filter((node) => node.taskId?.startsWith('treeb'));
assert(
	new Set(treeANodes.map((node) => node.layoutGroup)).size === 1
		&& new Set(treeBNodes.map((node) => node.layoutGroup)).size === 1
		&& treeANodes[0].layoutGroup !== treeBNodes[0].layoutGroup,
	'互不相连的任务树应进入不同布局分组',
);
assert(
	Math.max(...treeANodes.map((node) => node.y + node.height))
		< Math.min(...treeBNodes.map((node) => node.y)),
	'完整任务树应占据互不重叠的上下泳道',
);
const forestWithDocument = layoutTaskDocuments(
	forestLayout,
	[{
		id: 'doc:tree-a.md',
		nodeType: 'document',
		path: 'tree-a.md',
		title: '树 A 内容',
		excerpt: '',
		wordCount: 0,
		checklistDone: 0,
		checklistTotal: 0,
		mtime: 0,
		linkedTaskIds: [forestGraph.nodes[0].id],
		missing: false,
	}],
	new Set(['tree-a.md']),
	true,
);
const treeADocument = forestWithDocument.documents[0];
const shiftedTreeB = forestWithDocument.tasks.filter((node) => node.taskId?.startsWith('treeb'));
assert(
	treeADocument.y + treeADocument.height < Math.min(...shiftedTreeB.map((node) => node.y)),
	'展开的私有内容卡应计入所属树高度，不得侵入下一棵树',
);

const joinedDagTasks = parseTaskFile('joined-dag.md', [
	'- [ ] 根一 🆔 roota1',
	'- [ ] 根二 🆔 roota2',
	'- [ ] 汇合 🆔 joined1 ⛔ roota1,roota2',
].join('\n'));
const joinedDagGraph = buildTaskGraph(joinedDagTasks);
const joinedDagLayout = layoutGraph(joinedDagGraph.nodes, joinedDagGraph.edges);
assert(
	new Set(joinedDagLayout.nodes.map((node) => node.layoutGroup)).size === 1,
	'通过汇合节点连接的多根 DAG 应作为同一布局分量',
);

const cycleTasks = parseTaskFile('cycle.md', [
	'- [ ] A 🆔 aaa ⛔ bbb',
	'- [ ] B 🆔 bbb ⛔ aaa',
].join('\n'));
const cycleGraph = buildTaskGraph(cycleTasks);
assert(cycleGraph.nodes.every((node) => node.warnings.includes('cycle')), '应识别循环依赖');
const cycleLayout = layoutGraph(cycleGraph.nodes, cycleGraph.edges);
assert(cycleLayout.nodes[0].layer === cycleLayout.nodes[1].layer, '循环依赖应集中在同一布局层');

const migrated = migratePluginData({
	lastScopePath: 'Projects/Launch.md',
	showCompleted: false,
});
assert(migrated.version === 3, '旧数据应迁移到 v3');
assert(migrated.maps[0].documents.length === 0, '旧地图迁移后应初始化空内容列表');
assert(migrated.maps.length === 1, '旧范围应迁移为一张地图');
assert(migrated.maps[0].sources[0]?.path === 'Projects/Launch.md', '旧文件范围应成为地图来源');
assert(migrated.showCompleted === false, '旧显示设置应保留');
const sanitized = migratePluginData({
	maps: [{
		id: 'map-a',
		name: 'A',
		sources: [
			{ type: 'file', path: 'Plan.md' },
			{ type: 'file', path: 'Plan.md' },
		],
		nodePositions: {
			valid: { x: 1, y: 2 },
			invalid: { x: 'bad', y: 2 },
		},
		viewport: { x: 0, y: 0, scale: 99 },
		documents: [
			{ path: 'Content.md', expanded: false },
			{ path: 'Content.md', expanded: true },
		],
	}],
});
assert(sanitized.maps[0].sources.length === 1, '迁移时应去重来源');
assert(sanitized.maps[0].documents.length === 1 && sanitized.maps[0].documents[0].expanded, '迁移时应合并重复内容配置');
assert(!sanitized.maps[0].nodePositions.invalid, '迁移时应丢弃非法节点坐标');
assert(sanitized.maps[0].viewport.scale === 2, '迁移时应限制视口缩放范围');

const firstPositionKey = taskPositionKey(sampleTasks[0]);
assert(firstPositionKey === 'id:root001', '有 ID 任务应使用 ID 位置键');
const noIdTask = parseTaskFile('sample.md', '- [ ] 没有 ID 的任务')[0];
assert(taskPositionKey(noIdTask).startsWith('task:sample.md:'), '无 ID 任务应使用路径和内容指纹');

const renamedMaps = migrated.maps;
renamedMaps[0].sources.push({ type: 'folder', path: 'Projects/Area', recursive: true });
renamedMaps[0].nodePositions['task:Projects/Area/Plan.md:abc'] = { x: 10, y: 20 };
renamedMaps[0].documents.push({ path: 'Projects/Area/任务内容/方案.md', expanded: true });
renamedMaps[0].nodePositions['doc:Projects/Area/任务内容/方案.md'] = { x: 30, y: 40 };
assert(renameSourcePaths(renamedMaps, 'Projects/Area', 'Archive/Area'), '来源重命名应报告变化');
assert(renamedMaps[0].sources[1].path === 'Archive/Area', '文件夹来源路径应随重命名更新');
assert(Boolean(renamedMaps[0].nodePositions['task:Archive/Area/Plan.md:abc']), '无 ID 布局键应随路径迁移');
assert(renamedMaps[0].documents[0].path === 'Archive/Area/任务内容/方案.md', '内容文件配置应随路径迁移');
assert(Boolean(renamedMaps[0].nodePositions['doc:Archive/Area/任务内容/方案.md']), '内容节点坐标应随路径迁移');
assert(
	renamePathValue('Projects/Area/Nested/Plan.md', 'Projects/Area', 'Archive/Area')
		=== 'Archive/Area/Nested/Plan.md',
	'当前文件和展开目录路径应随文件夹重命名迁移',
);
assert(
	renamePathValue('Projects/Area-old/Plan.md', 'Projects/Area', 'Archive/Area')
		=== 'Projects/Area-old/Plan.md',
	'重命名迁移必须遵守路径边界',
);

const sourceResolution = resolveSourcePathRules([
	{ type: 'folder', path: 'Projects', recursive: true },
	{ type: 'file', path: 'Projects/Plan.md' },
	{ type: 'file', path: 'Missing.md' },
], [
	'Projects/Plan.md',
	'Projects/Nested/Build.md',
	'Unselected.md',
], ['Projects', 'Projects/Nested']);
assert(sourceResolution.filePaths.length === 2, '递归文件夹与重叠文件来源应去重');
assert(sourceResolution.filePaths.includes('Projects/Nested/Build.md'), '文件夹来源应递归包含子目录');
assert(!sourceResolution.filePaths.includes('Unselected.md'), '未选择的文件不应进入地图');
assert(sourceResolution.missing[0]?.path === 'Missing.md', '删除的来源应保留为缺失配置');

const successorMetadata = ensureSuccessorTaskMetadata('- [ ] 后续任务', 'parent01', 'child01');
assert(successorMetadata.line.includes('🆔 child01'), '后续任务应自动获得独立任务 ID');
assert(successorMetadata.line.includes('⛔ parent01'), '后续任务应保留父任务依赖');
const existingSuccessorMetadata = ensureSuccessorTaskMetadata(
	'- [ ] 已有 ID 🆔 existing01 ⛔ parent01',
	'parent01',
	'ignored01',
);
assert(existingSuccessorMetadata.childId === 'existing01', '已有子任务 ID 不应被覆盖');
assert((existingSuccessorMetadata.line.match(/🆔/g) ?? []).length === 1, '不应重复写入子任务 ID');

const csvLine = addDependency('- [ ] 多前置 🆔 child1 ⛔ root1', 'root2');
assert(csvLine.includes('⛔ root1,root2'), '新增关系应统一写为 CSV 依赖');
assert(readDependencyIds('- [ ] 混合 ⛔ root1, root2 ⛔ root3').join(',') === 'root1,root2,root3', '应读取 CSV 与独立依赖');
assert(removeDependency(csvLine, 'root1').includes('⛔ root2'), '应只移除指定关系');
assert(!removeDependency(csvLine, 'root1').includes('root1'), '已移除的关系不应残留');
assert(
	addDependency('  > - [ ] 嵌套关系', 'root1').startsWith('  > - [ ]'),
	'关系写回应保留嵌套任务前缀',
);

const independentGraph = buildTaskGraph(parseTaskFile('independent.md', '- [ ] 独立任务'));
assert(!independentGraph.nodes[0].warnings.includes('missing-id'), '独立无 ID 任务不应警告');
const customStatusTask = parseTaskFile('custom.md', '- [?] 等待确认')[0];
assert(customStatusTask.status === 'custom' && customStatusTask.statusMarker === '?', '自定义 checkbox 状态应进入地图');
const missingRelationGraph = buildTaskGraph(parseTaskFile('relation.md', '- [ ] 关系任务 ⛔ parent1'));
assert(missingRelationGraph.nodes[0].warnings.includes('missing-id'), '参与关系的无 ID 任务应警告');

const duplicateGraph = buildTaskGraph(parseTaskFile('duplicate.md', [
	'- [ ] 重复 A 🆔 same01',
	'- [ ] 重复 B 🆔 same01',
].join('\n')));
assert(duplicateGraph.nodes.every((node) => node.warnings.includes('duplicate-id')), '重复 ID 应在每个任务上警告');
assert(new Set(duplicateGraph.nodes.map((node) => node.id)).size === 2, '重复任务 ID 不应覆盖内部节点');

const generatedId = createTaskId(['aaaaaa']);
assert(/^[a-z0-9]{6}$/.test(generatedId), '自动 ID 应为 Tasks Map 兼容的 6 位小写字母数字');
const preparedTask = ensureTaskId('- [ ] 普通新任务', 'new001');
assert(preparedTask.line.includes('🆔 new001'), '普通新任务也应自动写入 ID');
assert(setTaskStarred('- [ ] 星标任务', true).endsWith('⭐'), '应写入标准星标');
assert(!setTaskStarred('- [ ] 星标任务 ⭐', false).includes('⭐'), '应移除标准星标');
const tagged = addTaskTag('- [ ] 标签任务', '#设计');
assert(tagged.endsWith('#设计'), '应写入标准标签');
assert(!removeTaskTag(tagged, '设计').includes('#设计'), '应移除指定标签');

async function testSuccessorRollback(): Promise<void> {
	const events: string[] = [];
	let failed = false;
	try {
		await runSuccessorWriteTransaction(
			async () => { events.push('parent'); },
			async () => {
				events.push('child');
				throw new Error('write failed');
			},
			async () => { events.push('rollback'); },
		);
	} catch {
		failed = true;
	}
	assert(failed, '子任务写入失败应向上传递错误');
	assert(events.join(',') === 'parent,child,rollback', '子任务失败后应回滚父任务 ID');

	const successfulEvents: string[] = [];
	await runSuccessorWriteTransaction(
		async () => { successfulEvents.push('parent'); },
		async () => { successfulEvents.push('child'); },
		async () => { successfulEvents.push('rollback'); },
	);
	assert(
		successfulEvents.join(',') === 'parent,child',
		'写入成功时不应执行回滚',
	);
}

function snapshot(value: string): HistorySnapshot {
	return { files: { 'Plan.md': value }, maps: {} };
}

async function testHistoryManager(): Promise<void> {
	const history = new HistoryManager(50);
	history.record('map-a', {
		label: '建立任务关系',
		before: snapshot('before'),
		after: snapshot('after'),
	});
	assert(history.canUndo('map-a'), '记录操作后应允许撤销');
	assert(!history.canUndo('map-b'), '不同地图的历史应相互隔离');
	let conflictRaised = false;
	try {
		await history.undo('map-a', async () => {
			throw new Error('external conflict');
		});
	} catch {
		conflictRaised = true;
	}
	assert(
		conflictRaised && history.canUndo('map-a') && !history.canRedo('map-a'),
		'恢复回调失败时应保留原撤销项且不得生成重做项',
	);
	let applied = '';
	const undone = await history.undo('map-a', async (expected, target) => {
		assert(expected.files['Plan.md'] === 'after', '撤销应校验操作后的状态');
		assert(target.files['Plan.md'] === 'before', '撤销应恢复操作前的状态');
		applied = target.files['Plan.md'] ?? '';
	});
	assert(undone?.label === '建立任务关系' && applied === 'before', '撤销应返回被撤销的历史项');
	assert(history.canRedo('map-a'), '撤销后应允许重做');
	await history.redo('map-a', async (expected, target) => {
		assert(expected.files['Plan.md'] === 'before', '重做应校验撤销后的状态');
		applied = target.files['Plan.md'] ?? '';
	});
	assert(applied === 'after', '重做应恢复操作后的状态');

	history.record('map-a', {
		label: '编辑内容',
		before: snapshot('after'),
		after: snapshot('edit-1'),
		coalesceKey: 'editor:Plan.md',
	});
	history.record('map-a', {
		label: '编辑内容',
		before: snapshot('edit-1'),
		after: snapshot('edit-2'),
		coalesceKey: 'editor:Plan.md',
	});
	await history.undo('map-a', async (expected, target) => {
		assert(expected.files['Plan.md'] === 'edit-2', '合并历史应保留最后一次编辑结果');
		assert(target.files['Plan.md'] === 'after', '合并历史应恢复到整次编辑会话之前');
	});

	for (let index = 0; index < 55; index += 1) {
		history.record('limited', {
			label: `操作 ${index}`,
			before: snapshot(String(index)),
			after: snapshot(String(index + 1)),
		});
	}
	let undoCount = 0;
	while (history.canUndo('limited')) {
		await history.undo('limited', async () => { undoCount += 1; });
	}
	assert(undoCount === 50, '每张地图最多应保留 50 步撤销历史');

	history.record('redo-clear', {
		label: '第一步',
		before: snapshot('0'),
		after: snapshot('1'),
	});
	await history.undo('redo-clear', async () => {});
	history.record('redo-clear', {
		label: '新操作',
		before: snapshot('0'),
		after: snapshot('2'),
	});
	assert(!history.canRedo('redo-clear'), '撤销后执行新操作应清空重做栈');
}

const targetPath = process.argv[2];
if (targetPath) {
	const actualTasks = parseTaskFile(targetPath, readFileSync(targetPath, 'utf8'));
	const actualGraph = buildTaskGraph(actualTasks);
	console.log(JSON.stringify({
		file: targetPath,
		tasks: actualTasks.length,
		edges: actualGraph.edges.filter((edge) => !edge.missing).length,
		ready: actualGraph.nodes.filter((node) => node.readiness === 'ready').length,
		blocked: actualGraph.nodes.filter((node) => node.readiness === 'blocked').length,
		active: actualGraph.nodes.filter((node) => node.readiness === 'active').length,
		warnings: actualGraph.nodes.filter((node) => node.warnings.length > 0).length,
	}, null, 2));
}

void Promise.all([testSuccessorRollback(), testHistoryManager()]).then(() => {
	console.log(`Task Graph core tests passed (${assertionCount} assertions).`);
});
