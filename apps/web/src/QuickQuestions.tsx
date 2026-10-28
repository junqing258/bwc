export interface QuickQuestion {
  label: string;
  prompt: string;
  scope: "drawing" | "selection";
  requiresUnits?: boolean;
  requiresGaps?: boolean;
}

const questions: QuickQuestion[] = [
  {
    label: "图纸概况",
    prompt:
      "请介绍整张图纸的实体类型、图层、单位状态和当前可用能力。只读查询，不修改图纸。",
    scope: "drawing",
  },
  {
    label: "解析排查",
    prompt:
      "请排查整张图纸为什么解析不完整，区分几何缺失、显示限制和读取通知，说明实际影响与下一步。只做诊断，不修改图纸或重新解析。",
    scope: "drawing",
  },
  {
    label: "定位异常",
    prompt:
      "请读取整张图纸的解析诊断，按诊断组冻结准确的问题实例并定位，说明各组数量及所需补充依据。辅助定位不代表已修复；只做查询和定位，不修改图纸或重新解析。",
    scope: "drawing",
    requiresGaps: true,
  },
  {
    label: "检查选中",
    prompt:
      "请检查当前冻结的选中对象，说明实际通过、未通过、未运行的检查及原因。不要扩大到全图，不修改图纸。",
    scope: "selection",
  },
  {
    label: "选中净面积",
    prompt:
      "请计算当前冻结的选中对象的净面积，使用规范几何及已确认的洞口，报告已知小计、计算范围和无法计算的缺项。不要扩大范围、猜测参数或将缺项按零计量。",
    scope: "selection",
    requiresUnits: true,
  },
  {
    label: "重新解析",
    prompt: "请重新解析当前图纸",
    scope: "drawing",
  },
];

export default function QuickQuestions({
  hasSelection,
  unitsConfirmed,
  hasGaps,
  disabled,
  onPick,
}: {
  hasSelection: boolean;
  unitsConfirmed: boolean;
  hasGaps: boolean;
  disabled: boolean;
  onPick: (question: QuickQuestion) => void;
}) {
  return (
    <section className="quick-questions" aria-label="AI 快捷提问">
      <div className="quick-questions-heading">
        <span>快捷提问</span>
        <small>点击填入，可编辑后发送</small>
      </div>
      <div className="quick-question-list">
        {questions.map((question) => {
          const reason =
            question.scope === "selection" && !hasSelection
              ? "请先选择并冻结对象"
              : question.requiresUnits && !unitsConfirmed
                ? "请先校准图纸单位"
                : question.requiresGaps && !hasGaps
                  ? "当前图纸没有已知解析缺口"
                  : "";
          return (
            <button
              key={question.label}
              type="button"
              disabled={disabled || !!reason}
              title={reason || question.prompt}
              onClick={() => onPick(question)}
            >
              {question.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
