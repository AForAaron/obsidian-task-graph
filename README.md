# Task Graph · Obsidian 插件

> 任务依赖关系可视化插件：限定 Markdown 来源、图形化编辑任务、自动布局，多地图视图与位置持久化。

## 这是什么

把 Markdown 里的任务抽成一张依赖关系图：任务之间的先后关系可视化，可以直接在图上编辑，支持自动布局，多张地图各自记住自己的视图位置。

## 状态

- **阶段**：v0.4.0 · 早期阶段（README 中作者自己标注了这一点）
- **已完成**：任务抓取（可限定 Markdown 来源）、依赖图渲染、图形化编辑、自动布局、多地图视图与位置持久化
- **已知缺口**：早期版本，接口与数据结构可能变动

## 开发

```bash
npm install
npm test
npm run build        # esbuild 打包
```

## 结构

```text
src/                插件源码
tests/              测试
DESIGN.md           设计说明
PROJECT_CONTEXT.md  开发日志（内部记录）
esbuild.config.mjs  构建配置
```

## 数据与隐私

只读写你 vault 内的 Markdown 文件，不联网。任务依赖以 Markdown 语法表达，卸载插件不会损坏笔记内容。

<!-- readme-skeleton: 顶部为统一骨架，其下为原文，未删减 -->

---


Task Graph 是一款面向 Obsidian 的可编辑任务依赖图插件。它把 Markdown 中的
[Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) 任务组织成多张独立地图，
帮助你看清任务之间的前置关系、当前阻塞和下一步行动。

> 当前版本：`0.4.0`。项目仍处于早期开发阶段，建议先在测试 Vault 或已备份的笔记中使用写入功能。

## 核心能力

- 创建、重命名和删除多张互相独立的任务地图。
- 为每张地图选择多个 Markdown 文件或递归文件夹作为来源。
- 解析 Tasks 状态、任务 ID、依赖、日期、优先级、标签和星标。
- 自动判断任务是可开始、进行中、被阻塞、已完成还是已取消。
- 检测缺失 ID、重复 ID、缺失引用和循环依赖。
- 搜索任务、标签、ID 或文件路径，并保留匹配任务的上下游关系。
- 按状态筛选，查看任务详情并跳转到 Markdown 原文。
- 拖动节点和缩放画布；每张地图分别保存节点位置与视口。
- 先分离独立任务树，再在每棵树内按依赖关系从左到右自动规整。
- 在图中创建、编辑、删除任务，以及添加前置或后续任务。
- 拖动节点连接点建立依赖；右键依赖线可确认解除关系。
- 支持当前会话内每张地图 50 步撤销/重做，并在外部修改冲突时拒绝覆盖。
- 修改任务状态、标签和星标，并为关系任务生成或修复唯一 ID。
- 创建或关联独立 Markdown 内容文件，并在画布中快速编辑、预览、重命名、重绑或删除。
- 显示内容摘要、字数和清单进度，并允许一个内容文件关联多个任务。
- 监听来源文件的创建、修改、删除和重命名并刷新地图。

## 任务关系格式

Task Graph 直接读取和写回 Markdown，不维护第二套任务数据库。正式依赖关系沿用 Tasks 的
`🆔` 与 `⛔` 字段：

```md
- [ ] 项目规划 🆔 root001
- [/] 设计界面 🆔 design01 ⛔ root001
- [ ] 开发画布 🆔 canvas01 ⛔ root001,design01
- [ ] 编写方案 🆔 plan001 📄 [[Projects/任务内容/plan001-编写方案|任务内容]]
```

图中箭头方向为：

```text
前置任务 ──────> 依赖它的任务
```

没有参与依赖关系的任务可以不带 ID。参与关系的任务应使用唯一 ID；插件能够为缺失或重复的
ID 提供修复入口。

`📄` 后的 WikiLink 表示任务内容文件。插件兼容完整路径、相对路径和短 WikiLink；解除、重命名或
重绑时会按 Obsidian 实际解析到的文件匹配。

## 使用要求

- Obsidian `1.4.0` 或更高版本。
- Tasks 插件：查看和解析地图时不是必需项；使用 Tasks 表单创建、编辑任务及切换状态时需要安装并启用。
- 仅支持 Obsidian 桌面端；插件清单已设置 `isDesktopOnly: true`。

当前画布以鼠标和键盘交互为基线：滚轮缩放、右键菜单、双击打开、拖动节点和细粒度连接点拖线都没有
完整的触控替代方案。窄屏样式只用于桌面端较窄窗口，不代表已经支持手机或平板触控操作。

## 从源码安装

克隆仓库并安装依赖：

```bash
git clone https://github.com/AForAaron/task-graph-obsidian.git
cd task-graph-obsidian
corepack pnpm install --frozen-lockfile
corepack pnpm run build
```

将以下三个文件复制到 Vault 的插件目录：

```text
main.js
manifest.json
styles.css
```

目标路径：

```text
<vault>/.obsidian/plugins/task-graph/
```

然后重新加载 Obsidian，在“设置 → 第三方插件”中启用 **Task Graph**。可通过左侧 ribbon
图标或命令面板中的“打开项目任务图”进入插件。

## 基本工作流

1. 新建或选择一张任务地图。
2. 点击“来源”，勾选需要纳入地图的 Markdown 文件或文件夹。
3. 在左侧文件树中选择当前文件，或直接在画布空白处右键创建任务。
4. 从节点右侧连接点拖到另一节点以建立“前置 → 后续”关系；拖到空白处则创建后续任务。
5. 从节点左侧连接点拖到另一节点或空白处，可建立或创建前置任务。
6. 拖动节点调整位置；需要恢复依赖布局时点击“规整”。
7. 使用工具栏撤销/重做按钮，或按 `Cmd/Ctrl+Z`、`Cmd/Ctrl+Shift+Z` 回退和恢复图内操作。
8. 从任务底部的内容连接点拖到空白处创建内容，或拖到已有内容卡建立关联。
9. 在右侧详情中快速编辑内容；检测到外部修改冲突时，插件会停止覆盖。

删除地图只会移除该地图保存的来源、布局和视口，不会删除笔记。删除任务或修改关系会直接写回
Markdown，执行前请确认提示内容。

## 项目结构

```text
src/
├── components/       # 画布、节点交互和弹窗
├── layout/           # 按独立任务树分组的从左到右分层布局
├── model/            # 任务、依赖、地图和视口模型
├── services/         # 解析、构图、来源解析、Tasks API 与安全写回
├── styles/           # Obsidian 主题适配样式
├── views/            # Task Graph 主视图
└── main.ts           # 插件入口
```

主要设计说明见 [`DESIGN.md`](./DESIGN.md)，当前实现上下文和验证记录见
[`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md)。

## 开发

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run dev
```

测试、类型检查和生产构建：

```bash
npm test
npm run build
npm run check
```

使用 pnpm 时，以上命令可等价替换为 `corepack pnpm test`、`corepack pnpm run build` 和
`corepack pnpm run check`。测试运行器会自动发现 `tests/smoke.ts` 和 `tests/*.test.ts`，
在系统临时目录中编译、执行并清理测试产物。

构建会对源码和 TypeScript 测试执行类型检查，生成 `main.js`，并把 `src/styles/main.css` 复制为
`styles.css`。这些生成文件默认不提交到源码仓库。

## 当前边界

- 只解析 Markdown inline checkbox task，不支持 note-as-task。
- 只有 `🆔` / `⛔` 会形成正式依赖边；Markdown 缩进不等同于阻塞关系。
- 当前仅支持桌面端；移动端缺少双指缩放、长按菜单、触控拖线与防误触节点移动等完整交互。
- 尚无 Markdown 嵌入图、批量编辑、关键路径或工期预测。
- 自定义 checkbox 标记会作为“自定义状态”进入地图；完成切换仍由 Tasks 插件解释。
- 当前测试是可重复执行的核心 smoke test，尚未引入完整 UI 自动化与真实 Vault 集成测试。
- 插件会直接修改用户笔记；虽然跨文件关系写入包含失败回滚处理，仍建议保持 Vault 备份。

## License

本项目采用 [MIT License](./LICENSE)。
