const assert = require("node:assert/strict");
const test = require("node:test");

const {
  formatClaudeCodeCompactPlaceholder,
  formatCodexCompactSegment,
  formatCompactProgressChip,
  formatGrokCompactProgressChip,
  formatGrokCompactSegment,
  formatGrokPlaceholder,
  formatGrokQuotaProgress,
  formatStatusBarQuotaLine,
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

test("formatCodexCompactSegment 用产品名 codex 而非账号名", () => {
  const text = formatCodexCompactSegment("7d", {
    usedPercent: 19,
    availablePercent: 81,
  });
  assert.match(text, /^codex 7d /);
  assert.match(text, /81%/);
  assert.doesNotMatch(text, /@|用户/);
});

test("formatClaudeCodeCompactPlaceholder 5h/7d 占位", () => {
  assert.equal(formatClaudeCodeCompactPlaceholder(), "CC 5h — · CC 7d —");
});

test("formatCompactProgressChip 无标题仅进度", () => {
  assert.equal(formatCompactProgressChip(undefined, true), "⬜—");
  const chip = formatCompactProgressChip({ usedPercent: 19, availablePercent: 81 });
  assert.match(chip, /81%/);
  assert.doesNotMatch(chip, /codex|CC|Grok|7d|5h/i);
});

test("formatGrokCompactProgressChip 无 Grok 前缀", () => {
  const chip = formatGrokCompactProgressChip({
    window: { usedPercent: 56, availablePercent: 44 },
    periodLabel: "7d",
    fetchedAt: "2026-08-05T00:00:00.000Z",
  });
  assert.match(chip, /44%/);
  assert.doesNotMatch(chip, /Grok|7d/);
  assert.equal(formatGrokCompactProgressChip(undefined), "⬜—");
});

test("状态栏极简行：CC · Codex · Grok，仅 7d，无标题", () => {
  const line = formatStatusBarQuotaLine(
    {
      primary: { usedPercent: 90, availablePercent: 10 },
      secondary: { usedPercent: 23, availablePercent: 77 },
      fetchedAt: "2026-08-05T00:00:00.000Z",
    },
    {
      window: { usedPercent: 56, availablePercent: 44 },
      periodLabel: "7d",
      fetchedAt: "2026-08-05T00:00:00.000Z",
    },
  );
  // 顺序 CC · Codex(7d=77) · Grok；不用 5h=10
  assert.equal(line, "⬜— · 🟩77% · 🟨44%");
  assert.doesNotMatch(line, /codex|CC|Grok|5h|10%/i);
});

test("状态栏极简行：codex 不可用", () => {
  const line = formatStatusBarQuotaLine(
    undefined,
    {
      window: { usedPercent: 0, availablePercent: 100 },
      periodLabel: "7d",
      fetchedAt: "2026-08-05T00:00:00.000Z",
    },
    { codexUnavailable: true },
  );
  assert.equal(line, "⬜— · ⬜— · 🟩100%");
});
