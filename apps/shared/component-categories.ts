export const componentCategories = [
  "未分类",
  "墙",
  "柱",
  "梁",
  "板",
  "门",
  "窗",
  "洞口",
  "其他",
] as const;
export type ComponentCategory = (typeof componentCategories)[number];
