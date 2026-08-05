const assert = require("node:assert/strict");
const test = require("node:test");

const {
  formatGrokCompactSegment,
  formatGrokPlaceholder,
  formatGrokQuotaProgress,
} = require("../out/accountPresentation");

test("formatGrokPlaceholder 未登录", () => {
  assert.equal(formatGrokPlaceholder("未登录"), "Grok 未登录");
});

test("formatGrokPlaceholder 默认", () => {
  assert.equal(formatGrokPlaceholder(), "Grok —");
  assert.equal(formatGrokPlaceholder("网络错误"), "Grok —");
});

test("formatGrokCompactSegment 可用周周期", () => {
  const text = formatGrokCompactSegment({
    window: {
      usedPercent: 49,
      availablePercent: 51,
      windowMinutes: 10_080,
      resetAfterSeconds: 86_400,
    },
    periodLabel: "7d",
    product: "GrokBuild",
    fetchedAt: "2026-08-05T00:00:00.000Z",
  });
  assert.match(text, /Grok/);
  assert.match(text, /7d/);
  assert.match(text, /51%/);
});

test("formatGrokCompactSegment 不可用走占位", () => {
  const text = formatGrokCompactSegment({
    fetchedAt: "2026-08-05T00:00:00.000Z",
    error: "未登录",
  });
  assert.equal(text, "Grok 未登录");
});

test("formatGrokCompactSegment undefined 走占位", () => {
  assert.match(formatGrokCompactSegment(undefined), /Grok/);
});

test("formatGrokQuotaProgress 有数据", () => {
  const text = formatGrokQuotaProgress({
    window: {
      usedPercent: 20,
      availablePercent: 80,
    },
    periodLabel: "7d",
    fetchedAt: "2026-08-05T00:00:00.000Z",
  });
  assert.match(text, /Grok 7d/);
  assert.match(text, /80\.0%/);
});
