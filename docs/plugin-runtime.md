# 工作目录插件运行与验证

目标：Codex CLI 0.165.0，macOS arm64，本地 marketplace 安装。清单采用根目录 `plugin.json` / `mcp.json`，不同时维护兼容清单。官方依据：https://developers.openai.com/plugins/build/plugins 。

## 运行依赖

Node >=22.13、.NET Runtime >=8、Python >=3.10（含 fcntl）由用户预装；CAD Worker/ACadSharp、几何 Worker 源码、编译后的领域服务/MCP/CLI、审阅资源和 Node 生产依赖随包分发。Python 环境须安装 numpy==2.2.6、shapely==2.1.2。首版建议 Python 3.12。所有预装依赖须处于启动 Codex 时的 PATH；通过 `BWC_PYTHON` 指定几何环境的解释器绝对路径，`BWC_LOCK_PYTHON` 指定含 fcntl 的解释器。

在用户可写的目录安装 Python 依赖，例如：

```sh
python3 -m venv "$HOME/.local/share/bwc/python"
"$HOME/.local/share/bwc/python/bin/pip" install -r /安装路径/workers/geometry/requirements.txt
export BWC_PYTHON="$HOME/.local/share/bwc/python/bin/python"
node /安装路径/scripts/doctor.mjs
```

不在插件安装目录构建、不依赖源码 checkout、开发机 `.venv` 或 tsx。`doctor` 给出缺失项和修复方式，不自动安装依赖。

## 开发与发行

```sh
npm run build:plugin
# 输出 release/bwc-macos-arm64 及 release/.agents/plugins/marketplace.json
codex plugin marketplace add /构建目录/release
codex plugin add bwc-workspace@bwc-local
```

只有首个平台列为验证目标。公共目录发布、其他平台与真实建筑规范量验收单独进行。发行包的跨机干净安装仍需独立验收，不能以本机打包测试代替。

## 选择正确的安装入口

桌面端选择本地插件文件夹时，选择解压后的 `bwc-macos-arm64/`，该目录内应直接看到 plugin.json、mcp.json 和 skills/；不要选择其父目录 release/ 或 .tar.gz 文件。

需要单插件 ZIP 的入口，使用 `bwc-macos-arm64.zip`。此 ZIP 的根目录直接包含插件清单，不含同级 marketplace 元数据。`bwc-macos-arm64.tar.gz` 是 CLI marketplace 快照，需先解压，再对包含 `.agents/plugins/marketplace.json` 的父目录运行 marketplace add；两者不可混用。

若使用网页发布入口，本项目依赖本地 stdio 与 Worker，不能作为远程 HTTP 插件直接运行；需按 OpenAI 的 desktop-only 插件流程处理。该发布入口的可用性不等同于本地 CLI 安装。

检查单插件 ZIP：

```sh
python3 scripts/package-plugin.py --validate release/bwc-macos-arm64.zip
```

## 用户显式启动运行时

默认 MCP 不启动持久子进程。宿主退出是否清理 detached 子进程不能从 Node 的 detached 行为推断；首版采用用户在独立终端显式启动的方式：

```sh
node /安装路径/apps/server/cli.js runtime start /工程绝对路径
node /安装路径/apps/server/cli.js runtime status /工程绝对路径
node /安装路径/apps/server/cli.js runtime stop /工程绝对路径
```

开发模式对应 `npm run bwc -- runtime start /工程绝对路径`。MCP `workspace_open(root)` 显式绑定目录，再调用 `drawing_discover` / `drawing_import`。同一 MCP 可绑定多个目录，工具均携带 workspaceId，图纸工具再携带 drawingId。不把进程 cwd 当作工程目录。

CLI 默认与 MCP 一样执行资料过滤和发送审计，例如：

```sh
node /安装路径/apps/server/cli.js workspace open /工程绝对路径
node /安装路径/apps/server/cli.js call /工程绝对路径 drawing_import '{"path":"建筑.dwg","operationId":"import-1"}'
```

导入返回 drawingId 和 jobId，使用 `job_get` 轮询。`drawing_list` 返回各图纸独立当前修订；输入清单固定 drawingId/revisionId/snapshotId。目录内来源按真实路径校验；工程外来源须显式 externalImport。原图不会改写。

## 审阅与资料策略

通过 `component_recognize` 产生候选，`viewer_open` 返回 30 分钟有效的本地链接。审阅器仅包含图纸、图层、候选核对、单位采用、诊断和成果；没有项目管理、聊天、账号或模型配置。审阅链接绑定冻结修订、快照、候选版本和内容指纹；任一变化后旧页面拒绝提交。核对写入同一 SQLite。单位采用发布新修订，需重新识别/核对。

v0.4 优先通过 `review_in_session` 发起 Codex 原生表单，正式确认来自宿主 elicitation 接受结果。模型工具只接收操作和对象标识，不接收确认答案。需要看图、批量核对或宿主不支持表单时继续走 Web；用户直接运行的 CLI 也可设置资料策略：

```sh
node /安装路径/apps/server/cli.js policy summary /工程绝对路径
node /安装路径/apps/server/cli.js policy geometry /工程绝对路径 '["gs_实际快照ID"]'
```

模型不得调用这两条人工策略命令或用 shell、数据库、成果文件、其他工具绕过资料策略。默认摘要；详细授权精确绑定快照。该约束只管插件输出，不宣称隔离宿主全部文件访问。模型可提出建议，不能自报 userConfirmed 并升级为人工确认。

## 存储、锁与恢复

`.bwc/workspace.json` 为 schemaVersion 1；数据库独立使用 PRAGMA user_version 事务迁移，遇更新版本拒绝打开。`workspace.sqlite` 的 drawings/drawing_versions/geometry_snapshots/revisions/input_manifests/input_manifest_members 以组合外键防止跨图父修订、快照和当前指针。旧领域记录按 drawingId 命名空间复用，工作目录无全局 currentRevision。

Python fcntl.flock 持有 `.bwc/run/runtime.lock`，exec 到 Node 后继承描述符，直到运行时退出由系统释放。锁文件存在不代表持锁，不删除锁文件，不凭 PID/心跳抢占。竞争启动的失败者重连胜出实例。仅获得锁者打开 SQLite 和执行任务恢复。描述文件原子更新，凭据权限 0600，IPC 使用回环动态端口与随机实例 ID/令牌握手。

崩溃后重开：已提交导入/重解析修订按 operationId 对账恢复；其余旧实例未完成任务标记 interrupted，保持 operationId 幂等，不盲重跑。锁被持有但端点无响应时返回错误与日志位置，使用 runtime status/stop 排查；无法连接时不会自动 kill。先停止旧位置运行时再移动目录，不支持热迁移。

成果任务完成时自动复制到 `outputs/bwc/<exportId>/`，原始报告和证据也保留于 `.bwc/exports/`。未绑定计量规范时只表达几何量；实体计数不同于建筑构件计数，已知小计不同于整图总量。范围覆盖默认 unknown；可通过独立人工覆盖审阅记录 reviewed_complete。候选全部确认不自动产生覆盖完成声明，计算齐备性与范围完整性分别保存。

## 验收边界

本次技术实现优先打通 P0 和 P1 的代码路径。P0 故障矩阵、独立 MCP 与发行包测试记录见 `docs/plans/Codex插件实施记录.md`。没有真实建筑参考清单、地区规范和人工基准时，不宣称完成 P2/P3。P4 的旧数据复制迁移与跨平台发行尚须单独验收。旧启动入口与 host.ts 保留兼容，但发行包不含 host.ts 及聊天宿主。


## v0.3 独立覆盖审阅与多图结果

新增 scope_coverage_prepare/status、scope_takeoff_run/get、scope_result_export 五个 MCP 工具，工具总数 36。数据库继续使用既有 schema 1；新增覆盖、审阅、排除和多图结果保存在工作目录 records 的 workspace 命名空间，不改变单图存储模型。

先创建 input_manifest，再准备覆盖范围，例如工具输入结构：

```json
{
  "workspaceId": "workspace_open 返回的 ID",
  "manifestId": "input_manifest_create 返回的 ID",
  "scope": {
    "discipline": "建筑",
    "categories": ["板", "柱"],
    "drawings": [{"drawingId": "图纸 ID", "floor": "一层", "viewPurpose": "平面"}]
  }
}
```

不确定的 floor/viewPurpose 传 null，保持未完成。每张参与图纸都必须出现在 scope.drawings。可通过 selectionSet 固定来源子集，该范围明确标识为 explicit_source_subset，不声称整张模型视图完成。

使用 viewer_open 的 coverageId 参数打开独立覆盖审阅。Web 支持切换参与图纸、分页定位未归属来源、带证据的批量排除、撤回排除、展开排除成员和查看无法定位的解析缺口；人工结论必须填写原图定位/参考清单版本及审阅证据。结论通过 Web 或 v0.4 原生表单提交，均受领域层阻止项校验。

## v0.4 会话内填写与确认

`review_in_session` 是新增的第 37 个 MCP 工具，输入为 workspaceId、drawingId、action；component 操作另需 componentId，coverage 操作另需 coverageId。支持单位采用、单个候选属性与状态、当前快照资料授权、独立覆盖结论四类平面表单。单位不预选猜测比例，依据必填。几何预览、批量核对与来源排除仍使用 Web。

MCP adapter 检查客户端 form elicitation 能力，向私有 runtime 接口准备冻结表单，然后将宿主的 accept/decline/cancel 直接传回运行时。一次性票据在十分钟后过期，不作为模型工具输出或输入；提交时重验修订、快照、候选及覆盖版本，策略变更还比较原授权版本。接受后记录 mcp_elicitation 来源与批次指纹，返回值经过既有资料过滤和发送审计。普通 `/call` 不能提交原生答案。此信任基于宿主的用户交互协议，不宣称对任意本地恶意客户端提供用户身份认证。

无能力声明、仅 URL 能力、宿主表单错误或旧 runtime 无此接口时返回 saved=false 及 Web 审阅链接；取消不反复弹出。已安装旧版时须更新插件并重新连接 MCP，旧运行时须重启以加载新接口。过期或版本冲突需要重新发起用户确认，不能重放旧答案。

协议依据：[OpenAI MCP server 文档](https://developers.openai.com/plugins/build/mcp-server)、[MCP form elicitation 规范](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)。`scripts/session-review-probe.ts` 实测 Codex CLI 0.165.0 的 mcpServer/tool/call → mcpServer/elicitation/request → cancel 链路；未发送模型任务，仅在临时受控图纸上模拟 App 客户端取消。证据见 docs/evidence/session-review-host-probe.json。该结果验证真实 Codex 协议转发，桌面客户端表单的实际视觉呈现仍需用户会话验证。

scope_takeoff_run 计算所有参与图纸内未被排除的目标构件（含待确认候选）并保存子任务；scope_takeoff_get 返回计算齐备、覆盖审阅、未决计量关系与完成声明。既有小计不会在后续补审后自行升级为完成。改变图纸、候选、排除或覆盖审阅版本后，相关多图结果的 scopeComplete 变 false、completeTotal 变 null，并显示 stale。跨图导出保留计算时的覆盖记录、独立审阅证据、当前有效性和所有来源指纹。

完全相同的同楼层/同类别边界可作为重复线索；模糊或任意平立剖语义去重尚未实现。洞口与板/墙的自动或人工扣减关联尚未开放：参与图纸存在未排除洞口候选时，面积/体积汇总保留 OPENING_RELATIONS_UNVERIFIED，并明确小计基于构件几何边界，不声明净扣减齐备。最终规范量、真实样本精度与另一台干净机器的安装仍须独立验收。
