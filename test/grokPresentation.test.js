const assert = require("node:assert/strict");
const test = require("node:test");

const {
  formatClaudeCompactProgressChip,
  formatClaudeCompactSegment,
  formatClaudePlaceholder,
  formatClaudeQuotaProgress,
  getClaudeResetAfterSeconds,
  truncateErrorSummary,
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

const CC_SNAPSHOT = {
  fiveHour: { usedPercent: 7, availablePercent: 93, windowMinutes: 300 },
  fiveHourResetAt: "2026-08-05T08:00:00.000Z",
  sevenDay: { usedPercent: 3, availablePercent: 97, windowMinutes: 10080 },
  sevenDayResetAt: "2026-08-11T22:00:00.000Z",
  fetchedAt: "2026-08-05T00:00:00.000Z",
};

test("formatClaudeCompactSegment 双窗口带标签", () => {
  const text = formatClaudeCompactSegment(CC_SNAPSHOT);
  assert.equal(text, "CC 5h 🟩93% · CC 7d 🟩97%");
});

test("formatClaudeCompactSegment 单窗口缺失时显示暂不可用而非 0%", () => {
  const text = formatClaudeCompactSegment({
    sevenDay: { usedPercent: 3, availablePercent: 97 },
    fetchedAt: "2026-08-05T00:00:00.000Z",
  });
  assert.match(text, /CC 5h 暂不可用/);
  assert.match(text, /97%/);
  assert.doesNotMatch(text, /0%/);
});

test("formatClaudeCompactSegment 无数据 / 错误时走占位", () => {
  assert.equal(formatClaudeCompactSegment(undefined), "CC —");
  assert.equal(
    formatClaudeCompactSegment({ fetchedAt: "x", error: "未登录" }),
    "CC 未登录",
  );
});

test("truncateErrorSummary 抹掉尖括号，防止注入 supportHtml tooltip", () => {
  // tooltip 用 supportHtml=true + isTrusted，而 escapeMarkdown 不转义 '<'。
  // 第三方响应体里的标签必须在进入展示层前就被消掉。
  const out = truncateErrorSummary("<img src=x onerror=alert(1)>", 200);
  assert.doesNotMatch(out, /</);
  assert.doesNotMatch(out, />/);
});

test("truncateErrorSummary 仍按长度截断", () => {
  assert.equal(truncateErrorSummary("x".repeat(100)), "x".repeat(37) + "…");
  assert.equal(truncateErrorSummary("  短  "), "短");
  assert.equal(truncateErrorSummary(undefined), undefined);
  assert.equal(truncateErrorSummary("   "), undefined);
});

test("formatClaudePlaceholder 常见失败短后缀", () => {
  assert.equal(formatClaudePlaceholder("未登录"), "CC 未登录");
  assert.equal(formatClaudePlaceholder("Claude usage HTTP 401"), "CC 鉴权失败");
  assert.equal(formatClaudePlaceholder("请求超时（20000ms）"), "CC 超时");
  assert.equal(formatClaudePlaceholder(undefined), "CC —");
});

test("formatClaudeCompactProgressChip 只反映 7d，不用 5h", () => {
  // 状态栏保持三段：CC 芯片必须取 7d(97%)，不能取 5h(93%)
  const chip = formatClaudeCompactProgressChip(CC_SNAPSHOT);
  assert.match(chip, /97%/);
  assert.doesNotMatch(chip, /93%/);
  assert.doesNotMatch(chip, /CC|7d|5h/i);
  assert.equal(formatClaudeCompactProgressChip(undefined), "⬜—");
});

test("formatClaudeQuotaProgress 缺失窗口输出暂不可用", () => {
  assert.equal(formatClaudeQuotaProgress(undefined, "fiveHour"), "CC 5h 暂不可用");
  assert.match(formatClaudeQuotaProgress(CC_SNAPSHOT, "sevenDay", 8), /CC 7d/);
});

test("getClaudeResetAfterSeconds 按当前时间现算，不冻结", () => {
  // AE5 的自动化证明：同一快照、不同 nowMs 必须给出不同倒计时
  const t1 = Date.parse("2026-08-05T00:00:00.000Z");
  const t2 = t1 + 3600_000;
  const a = getClaudeResetAfterSeconds(CC_SNAPSHOT, "sevenDay", t1);
  const b = getClaudeResetAfterSeconds(CC_SNAPSHOT, "sevenDay", t2);
  assert.equal(a - b, 3600);
});

test("formatClaudeCompactProgressChip 7d 缺失时不拿 5h 顶替", () => {
  // 守护 R4：状态栏那格代表 7d。若将来有人"贴心地"在 7d 缺失时回退到 5h，
  // 用户会把 5 小时的余量当成一周的余量来安排工作。
  const only5h = {
    fiveHour: { usedPercent: 7, availablePercent: 93 },
    fetchedAt: "x",
    error: "部分用量窗口不可用",
  };
  assert.equal(formatClaudeCompactProgressChip(only5h), "⬜—");
  assert.doesNotMatch(formatClaudeCompactProgressChip(only5h), /93%/);
});

test("getClaudeResetAfterSeconds 两个窗口都必须现算", () => {
  // 此前只测了 sevenDay；which 是三元分支，fiveHour 是另一条未覆盖路径
  const t1 = Date.parse("2026-08-05T00:00:00.000Z");
  const t2 = t1 + 3600_000;
  for (const which of ["fiveHour", "sevenDay"]) {
    const a = getClaudeResetAfterSeconds(CC_SNAPSHOT, which, t1);
    const b = getClaudeResetAfterSeconds(CC_SNAPSHOT, which, t2);
    assert.equal(a - b, 3600, `${which} 倒计时必须现算`);
  }
});

test("getClaudeResetAfterSeconds 无绝对时间时回退冻结秒数", () => {
  const secs = getClaudeResetAfterSeconds(
    { sevenDay: { usedPercent: 3, availablePercent: 97, resetAfterSeconds: 120 }, fetchedAt: "x" },
    "sevenDay",
    Date.now(),
  );
  assert.equal(secs, 120);
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
    { claudeSnapshot: undefined },
  );
  // 顺序 CC · Codex(7d=77) · Grok；不用 5h=10
  // CC 快照为 undefined 时首段仍为占位
  assert.equal(line, "⬜— · 🟩77% · 🟨44%");
  assert.doesNotMatch(line, /codex|CC|Grok|5h|10%/i);
});

test("状态栏极简行：CC 接入后三段均有数据", () => {
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
    { claudeSnapshot: CC_SNAPSHOT },
  );
  // CC 取 7d=97，不取 5h=93
  assert.equal(line, "🟩97% · 🟩77% · 🟨44%");
  assert.doesNotMatch(line, /93%/);
});

test("状态栏极简行：CC 快照必须经 options 传入才生效", () => {
  // 回归守护：claudeSnapshot 曾是 options 之后的可选位置参数，
  // 漏传时 TS 不报错，导致状态栏永远显示 CC 占位（tooltip 却是好的）。
  // 收进 options 后，这里同时锁住「传了就必须生效」。
  const codex = {
    primary: { usedPercent: 90, availablePercent: 10 },
    secondary: { usedPercent: 23, availablePercent: 77 },
    fetchedAt: "2026-08-05T00:00:00.000Z",
  };
  const withCC = formatStatusBarQuotaLine(codex, undefined, {
    codexUnavailable: false,
    claudeSnapshot: CC_SNAPSHOT,
  });
  assert.match(withCC, /^🟩97%/, "传入 CC 快照时首段必须是真实数据");

  const withoutCC = formatStatusBarQuotaLine(codex, undefined, {
    codexUnavailable: false,
    claudeSnapshot: undefined,
  });
  assert.match(withoutCC, /^⬜—/, "未传 CC 快照时首段才是占位");
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
