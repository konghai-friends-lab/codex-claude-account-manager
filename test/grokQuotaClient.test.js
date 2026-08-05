const assert = require("node:assert/strict");
const test = require("node:test");

const {
  GrokQuotaClient,
  parseBillingConfigToSnapshot,
  periodLabelFromType,
} = require("../out/grokQuotaClient");

test("periodLabelFromType: WEEKLY → 7d", () => {
  assert.equal(periodLabelFromType("USAGE_PERIOD_TYPE_WEEKLY"), "7d");
  assert.equal(periodLabelFromType("weekly"), "7d");
});

test("periodLabelFromType: MONTHLY → 30d", () => {
  assert.equal(periodLabelFromType("USAGE_PERIOD_TYPE_MONTHLY"), "30d");
});

test("periodLabelFromType: 未知类型不硬编码 7d", () => {
  assert.equal(periodLabelFromType(undefined), undefined);
  assert.equal(periodLabelFromType("CUSTOM"), undefined);
});

test("periodLabelFromType: 按窗口分钟数推断约 7 天", () => {
  assert.equal(periodLabelFromType(undefined, 10_080), "7d");
});

test("解析 GrokBuild productUsage 与 weekly 周期", () => {
  const snapshot = parseBillingConfigToSnapshot(
    {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-07-30T08:48:32.427135+00:00",
        end: "2026-08-06T08:48:32.427135+00:00",
      },
      creditUsagePercent: 50.0,
      productUsage: [
        { product: "GrokBuild", usagePercent: 49.0 },
        { product: "GrokChat", usagePercent: 1.0 },
      ],
    },
    "2026-08-05T00:00:00.000Z",
    200,
  );

  assert.equal(snapshot.error, undefined);
  assert.equal(snapshot.periodLabel, "7d");
  assert.equal(snapshot.product, "GrokBuild");
  assert.equal(snapshot.window?.usedPercent, 49);
  assert.equal(snapshot.window?.availablePercent, 51);
  assert.equal(snapshot.window?.windowMinutes, 10_080);
  assert.equal(typeof snapshot.window?.resetAfterSeconds, "number");
});

test("无周期用量时返回 error，不伪造 0%", () => {
  const snapshot = parseBillingConfigToSnapshot({}, "2026-08-05T00:00:00.000Z", 200);
  assert.ok(snapshot.error);
  assert.equal(snapshot.window, undefined);
});

test("GrokQuotaClient 可注入 fetch 失败为 snapshot error", async () => {
  const client = new GrokQuotaClient({ accessToken: "test" }, 1_000);
  client.fetchBillingCredits = async () => {
    throw new Error("Grok billing HTTP 401");
  };

  const snapshot = await client.fetchPeriodRemaining();
  assert.equal(snapshot.window, undefined);
  assert.match(snapshot.error ?? "", /401|失败|billing/i);
});

test("GrokQuotaClient 解析成功响应", async () => {
  const client = new GrokQuotaClient({ accessToken: "test" }, 1_000);
  client.fetchBillingCredits = async () =>
    JSON.stringify({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-30T00:00:00.000Z",
          end: "2026-08-06T00:00:00.000Z",
        },
        productUsage: [{ product: "GrokBuild", usagePercent: 20 }],
      },
    });

  const snapshot = await client.fetchPeriodRemaining();
  assert.equal(snapshot.window?.availablePercent, 80);
  assert.equal(snapshot.periodLabel, "7d");
  assert.equal(snapshot.error, undefined);
});
