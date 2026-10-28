# 筑材智算 · DWG 工作流

基于 [DWG-AI 工作流实施规划](DWG-AI工作流实施规划.md) 的本地可运行实现。React/TypeScript/Three.js 工作台连接 Node 项目服务、SQLite、ACadSharp .NET Worker 和 Python 几何 Worker；Codex CLI App Server 承担 Agent 运行时。

**当前交付是受支持二维子集的真实闭环，规划尚未全部验收。** 七份真实 DWG 均已运行解析与不改另存探测；真实图纸仍有未支持内容，不能宣称完整显示或完整编辑交付。详情见 [实施进度与验收](docs/实施进度与验收.md)、[样本实测](docs/evidence/样本解析实测.md)。

## 目录结构

```text
apps/web/               React/Three.js 工作台
apps/server/            Node 项目服务、HTTP API 与 MCP
apps/workers/cad/       .NET DWG Worker
apps/workers/geometry/  Python 几何 Worker
scripts/                安装、启动与验证脚本
tests/                  集成与契约测试
skills/                 随应用加载的 AI Skill
```

## 启动

本机基线：Node 22.23.1、.NET SDK 10.0.403（Worker 目标 net8.0，允许运行时向上兼容）、Python 3.12、uv；macOS arm64 已验证。AI 另需已登录的 Codex CLI，当前实测版本 0.164.0。没有 AI 账号也能操作人工工具。

```bash
npm ci
npm run launch
```

macOS 可双击 `启动筑材智算.command`。启动器会构建 Worker、建立 Python 环境、构建前端、启动本地服务并打开 <http://127.0.0.1:4310>。首次安装需要下载依赖；之后人工工具可离线运行。关闭启动终端可停止服务，项目不会丢失。

开发模式：

```bash
npm run setup
npm run dev
# 前端 http://127.0.0.1:4301，API http://127.0.0.1:4310
```

服务只绑定本机。`BWC_DATA_DIR` 可设置项目目录，`BWC_PYTHON` 可选择 Python，`BWC_CODEX_BIN` 可选择宿主可执行文件。`npm run launch` 使用默认端口 4310；手动启动服务可通过 `PORT` 改端口。

## 前端开发

前端使用 React、TypeScript、Zustand、Tailwind CSS v4 和 shadcn/ui。`@/` 指向 `apps/web/src/`。

- 项目列表和当前项目 ID 由 `apps/web/src/stores/project-store.ts` 管理；项目文件及业务数据仍通过后端保存。
- `apps/web/src/tailwind.css` 是样式入口，包含 Tailwind、shadcn/ui 主题变量，以及现有样式的 `legacy` 层。Tailwind 工具类可以覆盖现有样式。
- `apps/web/src/components/ui/` 保存 shadcn/ui 组件源码。项目菜单和编辑表单已使用 DropdownMenu、Button、Input。

在仓库根目录添加组件：

```bash
pnpm dlx shadcn@latest add dialog
```

组件路径和主题配置见根目录 `components.json`。开发服务监听前端与后端代码变更并自动重新加载。

## 第一个任务

1. 点击“体验受控基准”，导入真实生成的 DWG。此文件是测试样本，不是实际建筑的楼板认定。
2. “校准单位”采用 **米**，预览并发布修订。
3. 在对象表选择 `受控洞口`，进入“属性与修改”，点击“将选中范围暂记为洞口”。再选择 `受控楼板轮廓`，为外轮廓关联这个洞口并应用。
4. 将计量厚度设为 **150mm**，预览并应用，运行“参数体积”：毛面积 24m²，扣洞 1m²，净面积 23m²，体积 3.45m³。
5. 也可在冻结外轮廓后发送：**将选中轮廓的计量厚度设为200mm并重算**。真实 Codex 会通过 MCP 发布修订并计算 4.60m³。
6. 选择模型空间直接 LINE 或默认法向 LWPOLYLINE，可预览移动；“修订历史”支持撤销最新且没有冻结交付依赖的修改。
7. “导出成果”提供原图、数量 CSV、依据与补丁报告、交付清单。设置中提供“待核验候选 DWG”入口；只对无已知导入缺口且没有外部图形依赖的文档开放。

实际来件从 `docs/2026-10/` 发现；兼容旧目录 `2026-10/`。相邻 `../zhu-suan/assets/dwg/` 存在时，另外显示原项目的三份 DWG。复制到其他机器后没有该目录就不会显示这三份输入。

## 版本与依据

每个项目位于 `.data/projects/<projectId>/`：

```text
project.json / project.sqlite   项目、事务指针、对象索引、任务与会话
sources/<drawingVersion>/      不可变导入原件
artifacts/<parseVersion>/      双精度源 WCS 规范曲线
revisions/<snapshotId>/        快照清单、候选原生状态产物
exports/<exportId>/            成果、报告、映射与清单
agent-workspace/                宿主工作目录及 dwg-workflow Skill
```

查询、预览、检查和计量通过修订解析同一快照。原生补丁只由 .NET 求值；业务参数保存在覆盖层。候选文件先落盘校验，再通过 SQLite 比较基础修订并发布。重复 operationId 不重复应用；历史选择集不会自动迁移到新修订。另存前重新核对源文件指纹。

备份时先停止应用，复制**整个项目目录**，包括 SQLite 与所有文件产物。保持项目目录名不变放回 `BWC_DATA_DIR` 后可恢复。不要仅备份 `project.json` 或浏览器 localStorage；浏览器只保存最近项目和会话入口。运行中复制 SQLite 单文件不是一致备份方式。

## 工具与 AI

[apps/server/tools.ts](apps/server/tools.ts) 定义领域工具和 schema，HTTP `POST /api/call` 与 MCP 共用实现。公共调用包含 projectId；读取可显式固定 workingRevision/geometrySnapshotId；修改必须包含冻结范围、基础版本、operationId 与服务端已保存的 intentId。

[dwg-workflow Skill](skills/dwg-workflow/SKILL.md) 随宿主工作目录加载，普通安装不修改全局 Codex 配置。账号凭据由宿主管理。项目设置可选择摘要或详细几何，MCP 实际输出按策略裁剪并记录发送类别和版本。原始 DWG 附件上传尚未实现。

工作台消息先保存，再发送给结构化宿主协议；SSE 从持久游标补读。宿主中断与领域任务取消分开。“变更已提交但回执丢失”时先对账，禁止自动重发。当前宿主的完整历史接口实测不可用；无法确认的轮次会保留“待对账”，需要继续完成宿主恢复适配。

自然语言自动写入首期只接受明确的计量厚度命令；否定、假设和建议不会生成写入意图。其他编辑通过人工结构化表单执行。AI 不能创建自己的授权记录或跨项目操作。

## 验证

```bash
npm run check          # TypeScript/HTTP/领域/宿主恢复契约 + Python 几何测试 + 生产构建
npm run probe          # 七份可用真实文件 + 受控文件的解析/不改另存探测
npm run host:probe     # Codex 初始化、会话创建和元数据读取，不发送模型任务
npm run host:smoke     # 真实模型只读 + 厚度修改/计量，使用宿主账号额度
```

`host:smoke` 与 `host:probe` 会创建独立测试会话；前者会发送明确标注的受控样本摘要和参数。测试记录位于 `docs/evidence/`；大几何与试写 DWG 位于忽略的 `.cache/`。浏览器验证使用 ego-browser，截图分别保留受控任务和真实附房图纸。

## 已知交付缺口

- 真实文件中的 HATCH、DIMENSION、实体、专业对象及部分代理/动态块未覆盖；文字、线型、线宽、SHX 不保证原 CAD 外观。支持矩阵由 `dwg_capabilities` 和文件诊断返回。
- T3 来源可以登记，但缺少同修订原图、转换软件证据和独立 CAD 对照；不能把副本等同于原生专业对象可编辑能力。
- XREF/附图可登记依赖，递归依赖路径重写、迁移包、目标字体核验尚未实现。
- 候选 DWG 的程序往返只比较支持的几何、图层、块与单位；**不等于独立 CAD 保真验收**。七份真实来件中有四份不改另存直接报错，其他文件也仍有未支持内容。完整交付状态始终保留 false。
- 还未完成 Claude Code 对比接入、复杂宿主交互表单、自动恢复全部历史、安装包签名及大文件性能验收。
