---
name: dwg-workflow
description: 在 Codex 当前工作目录发现和解析 DWG，识别建筑构件候选，准备本地人工审阅，计算确定性几何量并导出可追溯成果。
---

# 工作目录建筑算量

仅使用 bwc MCP 领域工具获取工程事实和数值。先取 Codex 当前任务工作目录的绝对路径，调用 `workspace_open(root)`；不能假定 MCP 进程 cwd 就是工程目录。若返回 RUNTIME_NOT_STARTED，指导用户在独立终端显式运行发行包 `apps/server/cli.js runtime start <绝对路径>`。不启动 Codex App Server，不维护第二套聊天。

所有后续调用携带返回的 workspaceId；图纸工具另携带 drawingId。通过 `drawing_discover` 发现 DWG，通过 `drawing_import(path, operationId)` 复制不可变来源并启动持久任务，工程外文件须显式 externalImport。保留 operationId，用 `job_get` 轮询，任务返回不等于完成。重新导入同一逻辑图纸时显式提供 drawingId，不能覆盖另一张图纸。`drawing_list` 给出各图独立当前修订。

## 查询与冻结范围

先读 `dwg_capabilities`、`dwg_summary` 与 `dwg_diagnostics`。记录 workingRevision 与 geometrySnapshotId，后续查询、选择和计算都显式携带这些版本。图层、文字、块名只能作为候选线索，不能推断单位、楼层或高度。

`dwg_query` 按类型、图层、空间、文字或诊断组筛选并分页。使用 `selection_create(queryId)` 冻结完整查询结果，不能把第一页当全部。对多图任务调用 `input_manifest_create`，冻结每张图的 drawingId/revisionId/snapshotId；不要通过反复切换全局当前图纸完成跨图任务。`scope_coverage_prepare` 用该清单独立冻结专业、目标类别、每张图的楼层/视图及可选来源选择集；不能从候选列表反推范围，未知楼层/视图显式传 null。未提供选择集时基准是整张模型视图，提供时只代表该来源子集。

源记录数、展开实例数、实体计数和建筑构件数分别汇报。MINSERT 每个行列单元与嵌套实例是独立来源，不以裸 handle 去重。诊断辅助点位和范围不能用于计量；partial、unsupported 和 not_run 均不能解释为完整或通过。

## 识别与可信人工审阅

`component_recognize` 在冻结快照生成待核对候选，支持选择集；`component_suggest` 提交实际 occurrenceId 组成的单个构件建议，附类型、名称与理由。禁止虚构坐标、边界、尺寸或把整层墙线视作一面墙。AI 建议不能自动升级为人工确认。

优先调用 `review_in_session(workspaceId,drawingId,action)`，在 Codex 原生表单中让用户填写并确认。action 为 units（单位及依据）、component（另传 componentId，核对单个候选分类、楼层、材料、厚度与依据）、policy（当前快照资料授权）、coverage（另传 coverageId，独立覆盖结论及参考定位）。模型只选择操作与对象，不传表单答案或 userConfirmed；正式提交只来自宿主 elicitation 返回的用户接受。拒绝、取消、超时不保存。服务绑定修订、快照、候选版本和内容指纹，版本变化后重新发起，不能自动重试旧确认。

`review_prepare` 冻结图纸与候选版本；`viewer_open` 返回指定图纸/批次的本地审阅链接。需要看图判断、批量操作或宿主不支持表单时，使用工具返回的 Web 链接。不能自报 userConfirmed、伪造意图或通过 shell 调用人工提交接口。不要在用户取消表单后反复发起同一请求。

`component_list` 区分 pending/confirmed/rejected。`component_takeoff` 可计量当前快照的 pending/confirmed 构件，无须先人工确认；rejected 构件不参与计量。符号组只支持计数，闭合边界仍需拓扑检查；厚度、高度与洞口不能臆造。图纸或人工信息变化后旧结果失效。

## 独立范围覆盖与多图小计

调用 `scope_coverage_prepare` 准备覆盖范围后，通过 `scope_coverage_status` 分页读取 sourcePage、未归属来源、解析缺口和阻止项。使用 `viewer_open(drawingId, coverageId)` 让用户独立对照原图或参考清单，逐项核对未纳入候选的来源，为排除成员填写理由和证据。结论可用 `review_in_session(action="coverage",coverageId)` 填写 incomplete 或 reviewed_complete 及依据；服务仍检查所有阻止项，不能用候选全确认代替独立覆盖。来源排除/撤回仍在 Web 操作，不得伪造人工来源。

补充候选、修改构件或改变图纸版本会使旧覆盖结论失效；来源排除变化也会使已绑定结果的完成声明失效。重新冻结候选时不自动沿用排除理由；图纸修订变化必须重新冻结输入清单。未知楼层/视图、无法定位的解析缺口、未归属来源和重复关系不能静默排除。同楼层同类别完全相同的边界仅提示疑似重复，不静默合并；任意跨视图语义匹配尚未实现。

`scope_takeoff_run(coverageId,quantityKind,operationId)` 在冻结范围内逐图计算已确认目标构件；用 `scope_takeoff_get(scopeResultId)` 查看子任务、knownSubtotal、calculationComplete 与独立的 scopeComplete。覆盖未通过仍可输出已知小计，completeTotal 保持 null。结果固定覆盖版本与人工审阅 ID，后续补审不会自动把旧小计升级为范围完成；需要重新发起计算。缺参数、未关联洞口或旧版本结果仍阻止完成声明。

`scope_result_export(scopeResultId,operationId)` 返回 drawingId 与持久 job；通过 job_get 轮询，交付跨图 CSV、冻结输入清单、来源图纸和覆盖证据报告。scopeComplete 只适用于明确冻结的几何范围，不代表整层/整栋或地区规范清单验收。

## 计算与交付

`dwg_check` 执行确定性检查。`takeoff_run` 对冻结选择集计算长度、净面积、参数体积或实体计数；`component_takeoff` 对已确认构件计算。使用 `job_get` 等待真实结果，`takeoff_get` 检查结果时效。单位未采用、厚度或洞口依据缺失时只汇报已知小计与缺项，未算项保持 null。

净面积需要明确、有效、共面且互不重叠的洞口；参数体积是净面积乘人工参数，不等于三维实体恢复。未指定专业、地区、规范及版本时，结果只称几何量，不称符合某规范的工程清单量。未经过独立人工覆盖审阅时，覆盖状态为 unknown 或 incomplete；候选全部确认或选择集全部算出都不能声明整图、整层或整栋完成。

`result_export` 输出 CSV、依据报告、源图和快照信息。轮询导出任务完成后返回 outputs/bwc 下的成果路径。原图复制不表示已编辑 DWG。报告中保留范围、公式、方法版本、未决项与完整性。

operationId 在重试时保持稳定。超时先查任务与已提交修订；interrupted 需要对账，不换新 ID 盲重跑。REVISION_CONFLICT 时重新读取版本和核对范围。job_cancel 不撤销已发布修订。

## 资料发送边界

先读取 `data_policy_get`，默认摘要。MCP 与 CLI 的响应、嵌套任务结果、分页和错误统一经过过滤与发送审计。详细资料授权精确绑定人工选择的快照；新快照不自动继承授权。只获取当前任务必要的有限明细。

资料扩大授权优先用 `review_in_session(action="policy")` 由用户在原生表单设置，也可在 Web 设置，或由用户直接执行发行包的 `policy` CLI 人工入口。模型不得运行该命令、调用人工 HTTP 接口、读取数据库/源文件/几何产物/导出报告，或通过 shell、其他连接器和引用读取绕过策略。插件输出策略不是宿主全盘文件访问隔离。审阅与成果属于本地访问通道，不应自动送给模型。
