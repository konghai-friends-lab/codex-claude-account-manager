const assert = require("node:assert/strict");
const test = require("node:test");

const { formatQuotaSummary, formatQuotaSummaryPlain } = require("../out/accountPresentation");

const weeklyOnlyQuota = {
  secondary: {
    usedPercent: 20,
    availablePercent: 80,
    windowMinutes: 10_080,
    resetAfterSeconds: 509_445,
  },
};

test("没有 5h 数据时明确显示暂不可用", () => {
  assert.match(formatQuotaSummary(weeklyOnlyQuota, 4), /^5h 暂不可用 · 7d /);
  assert.match(formatQuotaSummaryPlain(weeklyOnlyQuota, 4), /^5h 暂不可用 · 7d /);
});
