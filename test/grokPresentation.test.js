const assert = require("node:assert/strict");
const test = require("node:test");

const {
  formatGrokCompactSegment,
  formatGrokPlaceholder,
  formatGrokQuotaProgress,
  getGrokResetAfterSeconds,
} = require("../out/accountPresentation");

test("formatGrokPlaceholder 未登录", () => {
  assert.equal(formatGrokPlaceholder("未登录"), "Grok 未登录");
});

test("formatGrokPlaceholder 鉴权与超时", () => {
  assert.equal(formatGrokPlaceholder("Grok billing HTTP 401"), "Grok 鉴权失败");
  assert.equal(formatGrokPlaceholder("Grok billing 请求超时（20000ms）"), "Grok 超时");
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

test("formatGrokQuotaProgress 不可用", () => {
  assert.equal(
    formatGrokQuotaProgress({ fetchedAt: "2026-08-05T00:00:00.000Z", error: "未登录" }),
    "Grok 暂不可用",
  );
  assert.equal(formatGrokQuotaProgress(undefined), "Grok 暂不可用");
});

test("getGrokResetAfterSeconds 优先 periodEndAt 现算", () => {
  const now = Date.parse("2026-08-05T00:00:00.000Z");
  const seconds = getGrokResetAfterSeconds(
    {
      window: { usedPercent: 0, availablePercent: 100, resetAfterSeconds: 999_999 },
      periodEndAt: "2026-08-05T01:00:00.000Z",
      fetchedAt: "2026-08-05T00:00:00.000Z",
    },
    now,
  );
  assert.equal(seconds, 3600);
});

test("Codex 未登录状态栏文案形态（拼串约定）", () => {
  // statusBar 使用固定前缀 + formatGrokCompactSegment
  const grok = formatGrokCompactSegment({
    window: { usedPercent: 49, availablePercent: 51 },
    periodLabel: "7d",
    fetchedAt: "2026-08-05T00:00:00.000Z",
  });
  const offlineText = `$(account) Codex 未登录 · ${grok}`;
  assert.match(offlineText, /Codex 未登录/);
  assert.match(offlineText, /Grok 7d/);
  assert.match(offlineText, /51%/);

  const noticeText = `$(warning) 检测到新账号 · ${formatGrokPlaceholder("未登录")}`;
  assert.match(noticeText, /Grok 未登录/);
});
