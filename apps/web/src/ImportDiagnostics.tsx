const diagnosticNames: Record<string, string> = {
  UNSUPPORTED_ENTITY: "尚未适配的图元",
  GEOMETRY_INVALID: "规范几何提取失败",
  UNSUPPORTED_INSERT_FEATURE: "块特性尚未支持",
  INSTANCE_CYCLE_OR_DEPTH: "实例层级无法继续展开",
  COMPATIBILITY_EXPORT_REQUIRED: "专业对象需要兼容处理",
  CONVERSION_UNVERIFIED: "兼容转换尚未核验",
};
const notificationNames: Record<string, string> = {
  unknown_non_graphical: "未知非图形对象",
  missing_reference: "引用缺失",
  unclassified: "其他读取通知",
};
const number = (n: number) => n.toLocaleString("zh-CN");
export default function ImportDiagnostics({
  summary,
  onInspect,
  onReparse,
  onDiagnose,
  busy,
}: {
  summary: any;
  onInspect: (group: any) => void;
  onDiagnose: (groupId?: string) => void;
  onReparse: () => void;
  busy: boolean;
}) {
  const report = summary.importReport;
  return (
    <>
      <div className="eyebrow">IMPORT EVIDENCE</div>
      <h2>解析覆盖与待核验项</h2>
      <p className="muted">
        快照适配器 {summary.adapterVersion} ·
        当前适配器可读取填充边界与缓存标注。
        {summary.adapterVersion === "bwc-cad-1"
          ? "本快照需重新解析才能使用新增能力。"
          : ""}
      </p>
      <p className="muted">
        填充和面显示边界；尺寸标注使用缓存图形，仅供阅读。显示依据不代表面积有效或业务构件已确认。
      </p>
      <button className="outline mr-2" disabled={busy} onClick={onReparse}>
        使用当前适配器重新解析
      </button>
      <button className="outline" disabled={busy} onClick={() => onDiagnose()}>
        让 AI 排查解析问题
      </button>
      <p className="muted">
        生成新解析快照，保留原图和历史版本。身份核验通过才沿用业务参数；已有计算结果需重算。
      </p>
      {report ? (
        <>
          <p>
            模型空间共 {number(report.modelTotal)} 个展开实例，其中{" "}
            {number(report.modelWithGeometry)} 个已有规范几何或简化文字，
            {number(report.modelWithoutGeometry)}{" "}
            个尚无规范几何。这些数量不是已确认的建筑构件数量。
          </p>
          {!!report.modelWithDiagnosticPreview && (
            <p className="muted">
              其中 {number(report.modelWithDiagnosticPreview)}{" "}
              个缺失实例已有橙色辅助点位或参考范围，可定位核查；仍不参与计量。
            </p>
          )}
          <div className="diagnostic-metrics">
            <div>
              <b>{number(report.modelWithGeometry)}</b>
              <span>已有显示依据</span>
            </div>
            <div>
              <b>{number(report.modelWithoutGeometry)}</b>
              <span>尚无规范几何</span>
            </div>
            <div>
              <b>{number(report.notificationGroupCount)}</b>
              <span>类读取通知</span>
            </div>
          </div>
          <h3>图元与解析诊断</h3>
          <p className="muted">
            共 {number(report.diagnosticCount)}{" "}
            条诊断记录，包含块定义及重复实例。各组可能关联同一对象，不宜直接相加作为缺失构件数。
          </p>
          <div className="diagnostic-table">
            <table>
              <thead>
                <tr>
                  <th>类型 / 原因</th>
                  <th>诊断记录</th>
                  <th>模型实例</th>
                  <th>查看</th>
                </tr>
              </thead>
              <tbody>
                {report.diagnosticGroups.slice(0, 50).map((g: any) => (
                  <tr key={JSON.stringify([g.code, g.entityType, g.reason])}>
                    <td>
                      <b>{g.entityType}</b>
                      <small>{diagnosticNames[g.code] ?? g.code}</small>
                      {g.reason && <small>{g.reason}</small>}
                    </td>
                    <td>
                      {number(g.recordCount)}
                      <small>{number(g.sourceEntityCount)} 个不同源对象</small>
                    </td>
                    <td>
                      {number(g.modelOccurrences)}
                      <small>
                        {g.otherSpaceOccurrences
                          ? `另有 ${number(g.otherSpaceOccurrences)} 个布局实例`
                          : `${number(g.uninstantiatedSources)} 个源对象未在图上展开`}
                      </small>
                    </td>
                    <td>
                      {g.modelOccurrences > 0 && g.entityType !== "UNKNOWN" ? (
                        <button
                          className="text-button"
                          onClick={() => onInspect(g)}
                        >
                          查看本组对象
                        </button>
                      ) : (
                        <span className="muted">无模型实例可查询</span>
                      )}
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => onDiagnose(g.id)}
                      >
                        让 AI 分析本组
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.diagnosticGroups.length > 50 && (
            <p className="muted">
              展示前 50 组，共 {number(report.diagnosticGroups.length)}{" "}
              组；完整原始记录随报告导出。
            </p>
          )}
          <h3>读取通知</h3>
          <p className="muted">
            {number(report.notificationCount)} 条通知归为{" "}
            {number(report.notificationGroupCount)}{" "}
            类。样式和非图形对象的通知需要核验，不能直接当成几何丢失，也不能据此保证文档完整保持。
          </p>
          <div className="diagnostic-table">
            <table>
              <thead>
                <tr>
                  <th>类别 / 对象</th>
                  <th>出现次数</th>
                </tr>
              </thead>
              <tbody>
                {report.notificationGroups.map((g: any) => (
                  <tr key={g.category + "|" + g.name}>
                    <td>
                      <b>{notificationNames[g.category] ?? g.category}</b>
                      <small>{g.name}</small>
                      <details>
                        <summary>查看原始通知样例</summary>
                        <p>{g.example}</p>
                      </details>
                    </td>
                    <td>{number(g.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.notificationGroupsTruncated && (
            <p className="muted">
              这里只展示次数最多的 50 类，完整记录随报告导出。
            </p>
          )}
        </>
      ) : (
        <p>
          {summary.diagnosticCount} 项诊断；{summary.notificationCount}{" "}
          条读取通知。
        </p>
      )}
      <details className="raw-diagnostics">
        <summary>原始诊断样例与显示范围</summary>
        <p className="muted">
          诊断最多展示前 100 条、通知前 30 条。完整数据保存在项目和导出报告中。
        </p>
        <pre>
          {JSON.stringify(
            {
              diagnostics: summary.diagnostics,
              notifications: summary.notifications,
              dependencies: summary.dependencies,
              resources: summary.resources,
              displayLimitations: summary.displayLimitations,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </>
  );
}
