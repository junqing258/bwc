---
name: dwg-workflow
description: 查询和处理筑材智算本地项目中的 DWG，冻结对象范围，执行受支持的检查、变更、确定性计量与成果导出。用于工作台发起的图纸任务。
---

# DWG 工作流

通过 `bwc` MCP 工具处理当前工作台项目。项目服务和几何工具提供事实、数量与版本；对话历史不替代项目状态。

先读 `project_open`、`dwg_capabilities` 和 `dwg_summary`。使用用户消息附带的 projectId、workingRevision、geometrySnapshotId 和冻结 selectionSet；不要从后来变化的视图推测任务目标。

## 查询与定位

按实际类型、图层、文字、空间或已确认业务分类调用 `dwg_query`。图层名和文字只生成候选，不能自动确认为楼板、墙或门窗。结果分页；对全部结果操作时，用 queryId 调用 `selection_create` 冻结所有成员。`viewer_focus` 将同一选择集定位到真实工作台。

源记录数、展开实例数与已确认构件数分别表达。MINSERT 的每个行列成员和嵌套路径是独立实例，不以裸 handle 去重。

## 检查、修改与计算

解析不完整时先调用 `dwg_diagnostics`，区分模型几何缺失、显示近似和文档保持待核验。使用返回的真实诊断组 ID，通过 `dwg_query(filter={diagnosticGroupId:...})` 或 `selection_create(filter={diagnosticGroupId:...})` 冻结精确成员，再 `viewer_focus` 定位；不要把所有同类图元当成问题对象。分页读取本组时使用 groupId、offset、limit。没有模型实例的源记录不创建空选择集。

diagnosticPreview 仅是辅助点位或参考范围，不是已解析几何，不能用于面积、长度或体积，不能解释成已修复。端点重合但 bulge 非零时保留原始证据，需独立 CAD 复核；WIPEOUT 的参考范围不代替遮罩效果；OLE 框角不代表嵌入内容已读取。读取通知即使像样式对象也保持待核验。不要建议把解析缺项按零计量或把 partial 改名为 complete。

用户可发“请重新解析当前图纸”或“请使用当前适配器重新解析当前图纸”。这类明确指令可直接调用 `dwg_reparse`，必须携带本轮次 intentId、workingRevision、geometrySnapshotId 和稳定 operationId，再用 job_get 等待结果。随后使用返回的新修订读取 summary/diagnostics，汇报覆盖变化与仍存缺口。不要从“为什么解析不完整”“能否重新解析”“如果重新解析”等询问推断写入授权；服务器会独立校验原始消息。重解析不要求重复确认。

“只分析可计算部分”可用 `geometryKinds=["path","region"]` 生成候选，冻结具体成员并执行检查。该筛选不会确认业务分类，也不能代替单位采用、有效轮廓、洞口或厚度依据；汇报时明确这是部分范围。

- `dwg_check` 只声明实际执行的检查。`not_run` / `unsupported` 不是通过。遇到未知专业对象，查看转换缺口，要求正确的兼容副本与必要依据；文件名中的 `_t3` 不是转换核验。
- 单位未采用时保留预览，涉及物理尺寸的计算与几何编辑等待单位采用。只有与任务实际相关的缺项才询问。
- 修改必须使用该轮次服务端记录的 intentId，以及冻结基础修订、快照与选择集。服务器会校验其与已保存原始用户消息的关系。不得自报授权、创建伪造意图或修改数据库/文件绕过领域工具。
- 明确的计量厚度指令（例如“将选中轮廓的计量厚度设为150mm并重算”）已被服务端解析为固定物理量。`change_propose` 使用 `kind=set_measurement_parameter, field=uniform_thickness, value=150, unit=mm, unitBinding=physical_quantity`；用候选返回的 operationId、baseRevision、candidateFingerprint 调用 `change_apply`。明确目标和数值的修改校验通过可继续执行，不要求用户重复确认。
- 未匹配的自然语言编辑，使用工作台的结构化表单收敛范围和值；不要把工具的 INTENT_MISMATCH 当作可绕过的故障。
- 发布新修订后读取其返回版本；旧选择集不可直接用于新修订。身份保持的操作可用明确旧成员创建新选择集；块克隆/拆分等歧义迁移当前尚未开放。
- `takeoff_run` 返回持久 jobId，使用 `job_get` 获取真实结果。只汇报工具计算的数值、公式、单位、范围和缺项。未算项为 null；小计不是全图总量。
- 净面积使用有效共面闭合轮廓及明确、互不重叠的内部洞口。参数体积是净面积乘均匀厚度，不能称为三维实体体积。
- `physical_quantity` 厚度随源单位重解释保持不变；`source_geometry` 参数须明确长度来源对象并重新提取。

## 交付与恢复

`result_export` 提供原 DWG、CSV、问题、版本和项目补丁。源图复制不表示已编辑 DWG。`dwg_export(mode=candidate)` 仅对无已知解析缺口或依赖的图纸提供候选；程序往返不替代独立 CAD 验收。完整 DWG、依赖迁移和字体/显示资源三项状态分别汇报，缺少必需项时完整交付为 false。

每次写入使用本轮次 operationId 前缀加稳定操作后缀。超时先查操作、修订和 job，不换 ID 盲重试；`change_apply` 相同 ID 去重。收到 REVISION_CONFLICT 读取当前值，重新确定用户意图与候选。MESSAGE_DELIVERY_UNCERTAIN 等待工作台恢复对账，不能自动重发有副作用的任务。

停止 AI 与取消领域 job 是不同操作；已发布修订通过变更历史处理。没有网络或宿主不可用时说明 AI 不可用，人工领域工具仍可操作。

## 资料边界

执行当前项目 dataPolicy。摘要模式不发送规范几何；详细模式可通过受约束工具发送详细属性与几何。源文件附件上传未实现时如实说明。只使用 bwc MCP；不要运行 shell、读取工程数据库、修改文件、调用其他连接器或向外部联系人发消息。账号凭据由宿主保管。
