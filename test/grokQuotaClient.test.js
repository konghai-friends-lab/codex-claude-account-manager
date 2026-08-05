const assert = require("node:assert/strict");
const test = require("node:test");

const {
  GrokQuotaClient,
  GrokBillingHttpError,
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

test("periodLabelFromType: BIWEEKLY 不误标 7d", () => {
  assert.equal(periodLabelFromType("BIWEEKLY"), undefined);
  assert.equal(periodLabelFromType("BIWEEKLY", 20_160), "14d");
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
    Date.parse("2026-08-05T00:00:00.000Z"),
  );

  assert.equal(snapshot.error, undefined);
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.periodLabel, "7d");
  assert.equal(snapshot.product, "GrokBuild");
  assert.equal(snapshot.window?.usedPercent, 49);
  assert.equal(snapshot.window?.availablePercent, 51);
  assert.equal(snapshot.window?.windowMinutes, 10_080);
  assert.ok(snapshot.periodEndAt);
  assert.equal(typeof snapshot.window?.resetAfterSeconds, "number");
});

test("仅有 overall creditUsagePercent 时不伪装为 GrokBuild", () => {
  const snapshot = parseBillingConfigToSnapshot(
    { creditUsagePercent: 70 },
    "2026-08-05T00:00:00.000Z",
    200,
  );
  assert.ok(snapshot.error);
  assert.match(snapshot.error, /GrokBuild/);
  assert.equal(snapshot.window, undefined);
  assert.equal(snapshot.statusCode, 200);
});

test("无周期用量时返回 error，不伪造 0%", () => {
  const snapshot = parseBillingConfigToSnapshot({}, "2026-08-05T00:00:00.000Z", 200);
  assert.ok(snapshot.error);
  assert.equal(snapshot.window, undefined);
});

test("snake_case product_usage 可解析", () => {
  const snapshot = parseBillingConfigToSnapshot(
    {
      current_period: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-07-30T00:00:00.000Z",
        end: "2026-08-06T00:00:00.000Z",
      },
      product_usage: [{ product: "GrokBuild", usage_percent: 20 }],
    },
    "2026-08-05T00:00:00.000Z",
    200,
  );
  assert.equal(snapshot.window?.availablePercent, 80);
  assert.equal(snapshot.periodLabel, "7d");
});

test("usagePercent 字符串与 0-1 小数可解析", () => {
  const a = parseBillingConfigToSnapshot(
    { productUsage: [{ product: "GrokBuild", usagePercent: "25" }] },
    "2026-08-05T00:00:00.000Z",
  );
  assert.equal(a.window?.usedPercent, 25);

  const b = parseBillingConfigToSnapshot(
    { productUsage: [{ product: "GrokBuild", usagePercent: 0.4 }] },
    "2026-08-05T00:00:00.000Z",
  );
  assert.equal(b.window?.usedPercent, 40);
});

test("GrokQuotaClient HTTP 错误写入 statusCode", async () => {
  const client = new GrokQuotaClient({ accessToken: "test" }, 1_000);
  client.fetchBillingCredits = async () => {
    throw new GrokBillingHttpError(401, "unauthorized");
  };

  const snapshot = await client.fetchPeriodRemaining();
  assert.equal(snapshot.window, undefined);
  assert.equal(snapshot.statusCode, 401);
  assert.match(snapshot.error ?? "", /401/);
});

test("GrokQuotaClient 非法 JSON 保留 statusCode", async () => {
  const client = new GrokQuotaClient({ accessToken: "test" }, 1_000);
  client.fetchBillingCredits = async () => ({ body: "not-json", statusCode: 200 });

  const snapshot = await client.fetchPeriodRemaining();
  assert.equal(snapshot.statusCode, 200);
  assert.ok(snapshot.error);
  assert.equal(snapshot.window, undefined);
});

test("GrokQuotaClient 解析成功响应", async () => {
  const client = new GrokQuotaClient({ accessToken: "test" }, 1_000);
  client.fetchBillingCredits = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-30T00:00:00.000Z",
          end: "2026-08-06T00:00:00.000Z",
        },
        productUsage: [{ product: "GrokBuild", usagePercent: 20 }],
      },
    }),
  });

  const snapshot = await client.fetchPeriodRemaining();
  assert.equal(snapshot.window?.availablePercent, 80);
  assert.equal(snapshot.periodLabel, "7d");
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.error, undefined);
  assert.ok(snapshot.periodEndAt);
});
