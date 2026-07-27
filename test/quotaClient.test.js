const assert = require("node:assert/strict");
const test = require("node:test");

const { CodexQuotaClient } = require("../out/quotaClient");

test("将 primary_window 中的 weekly 窗口显示为 7d 额度", async () => {
  const client = new CodexQuotaClient(
    { idToken: "test", accessToken: "test" },
    1_000,
  );

  client.fetchWhamUsage = async () =>
    JSON.stringify({
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 19,
          limit_window_seconds: 604_800,
          reset_after_seconds: 512_102,
          reset_at: 1_785_634_309,
        },
        secondary_window: null,
      },
    });

  const quota = await client.fetchQuota();

  assert.equal(quota.primary, undefined);
  assert.deepEqual(quota.secondary, {
    usedPercent: 19,
    availablePercent: 81,
    windowMinutes: 10_080,
    resetAfterSeconds: 512_102,
  });
  assert.equal(quota.error, undefined);
});

test("保留同时存在的 5h 与 7d 窗口", async () => {
  const client = new CodexQuotaClient(
    { idToken: "test", accessToken: "test" },
    1_000,
  );

  client.fetchWhamUsage = async () =>
    JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 40,
          limit_window_seconds: 18_000,
          reset_after_seconds: 3_600,
        },
        secondary_window: {
          used_percent: 60,
          limit_window_seconds: 604_800,
          reset_after_seconds: 86_400,
        },
      },
    });

  const quota = await client.fetchQuota();

  assert.deepEqual(quota.primary, {
    usedPercent: 40,
    availablePercent: 60,
    windowMinutes: 300,
    resetAfterSeconds: 3_600,
  });
  assert.deepEqual(quota.secondary, {
    usedPercent: 60,
    availablePercent: 40,
    windowMinutes: 10_080,
    resetAfterSeconds: 86_400,
  });
});
