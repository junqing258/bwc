import { useState } from "react";
import type { UnitProfile } from "../server/types";

export default function UnitAdoptionPanel({
  units,
  stale,
  busy,
  onRefresh,
  onAdopt,
}: {
  units: UnitProfile;
  stale: boolean;
  busy: boolean;
  onRefresh: () => void;
  onAdopt: (scale: number, evidence: string) => Promise<boolean>;
}) {
  const [scale, setScale] = useState(
    units.confirmed && units.metresPerDrawingUnit
      ? String(units.metresPerDrawingUnit)
      : "",
  );
  const [custom, setCustom] = useState(false);
  const [unitEvidence, setUnitEvidence] = useState("");
  const [message, setMessage] = useState("");
  const numericScale = Number(scale);
  const validScale =
    scale.trim() !== "" &&
    Number.isFinite(numericScale) &&
    numericScale > 0 &&
    numericScale <= 1e9;
  const reason = busy
    ? "正在保存，请稍候。"
    : stale
      ? "审阅版本已变化，请先重新载入单位核对上下文。"
      : !validScale
        ? "请选择已核实的图纸单位，或填写大于 0 的米数换算比例。"
        : !unitEvidence.trim()
          ? "请填写单位采用依据，例如原图说明的位置或人工核验结果。"
          : "";
  const preset = custom
    ? "custom"
    : (({ "0.001": "mm", "0.01": "cm", "1": "m" } as Record<string, string>)[
        scale
      ] ?? (scale ? "custom" : ""));
  return (
    <details open={!units.confirmed || !!message}>
      <summary>单位采用{units.confirmed ? " · 已采用" : ""}</summary>
      <p>
        当前：
        {units.confirmed
          ? `${units.metresPerDrawingUnit} m/图纸单位（已采用）`
          : "尚未人工采用"}
        。采用后会发布新修订，原有检查和覆盖结论需要重新核验。
      </p>
      <p>
        DWG 声明 INSUNITS={units.sourceInsUnits}，仅供核对，不自动作为计量单位。
      </p>
      {units.confirmed && <p>已保存依据：{units.evidence}</p>}
      <label htmlFor="drawing-unit">已核实的图纸单位</label>
      <select
        id="drawing-unit"
        value={preset}
        disabled={busy}
        onChange={(e) => {
          setCustom(e.target.value === "custom");
          setScale(
            ({ mm: "0.001", cm: "0.01", m: "1" } as Record<string, string>)[
              e.target.value
            ] ?? "",
          );
          setMessage("");
        }}
      >
        <option value="">请选择单位</option>
        <option value="mm">毫米（mm），1 图纸单位 = 0.001 m</option>
        <option value="cm">厘米（cm），1 图纸单位 = 0.01 m</option>
        <option value="m">米（m），1 图纸单位 = 1 m</option>
        <option value="custom">自定义换算比例</option>
      </select>
      <label htmlFor="unit-scale">每图纸单位对应米数</label>
      <input
        id="unit-scale"
        type="number"
        step="any"
        min="0"
        max="1000000000"
        value={scale}
        disabled={busy}
        onChange={(e) => {
          setCustom(true);
          setScale(e.target.value);
          setMessage("");
        }}
        aria-describedby="unit-adoption-status"
      />
      <label htmlFor="unit-evidence">单位采用依据（必填）</label>
      <textarea
        id="unit-evidence"
        maxLength={2000}
        value={unitEvidence}
        disabled={busy}
        placeholder="例如：图纸总说明第 2 条注明尺寸单位为毫米，经原图核实。"
        onChange={(e) => {
          setUnitEvidence(e.target.value);
          setMessage("");
        }}
        aria-describedby="unit-adoption-status"
      />
      <p id="unit-adoption-status" role="status" aria-live="polite">
        {reason || message || "换算比例和依据已填写，可以采用单位。"}
      </p>
      {stale && (
        <button type="button" disabled={busy} onClick={onRefresh}>
          重新载入单位核对上下文
        </button>
      )}
      <button
        type="button"
        disabled={!!reason}
        aria-describedby="unit-adoption-status"
        onClick={async () => {
          setMessage("");
          if (await onAdopt(numericScale, unitEvidence.trim()))
            setMessage("单位已采用，已载入新修订；请重新执行几何检查。");
        }}
      >
        按此依据采用单位
      </button>
    </details>
  );
}
