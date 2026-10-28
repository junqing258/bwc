/** Parse a command, not a question, quoted suggestion, negation or hypothetical. */
export function isReparseInstruction(text: string): boolean {
  return /^(?:请)?(?:使用当前适配器)?(?:重新解析|重解析)当前(?:图纸|DWG)[。！!]?$/iu.test(
    text.trim(),
  );
}
