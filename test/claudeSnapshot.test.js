const assert = require("node:assert/strict");
const test = require("node:test");

const { buildClaudeSnapshot, ClaudeUsageHttpError } = require("../out/claudeQuotaClient");

const NOW_ISO = "2026-08-05T00:00:00.000Z";
const FAKE_TOKEN = "sk-ant-oat01-FAKE-TOKEN-FOR-TESTS-ONLY";

function neverCalledClient() {
  return {
    fetchUsage: async () => {
      throw new Error("不应该走到这里");
    },
  };
}

/** 失败快照必须两个窗口都缺失——绝不能退化成 0%/100% */
function assertPlaceholder(snap) {
  assert.equal(snap.fiveHour, undefined);
  assert.equal(snap.sevenDay, undefined);
  assert.ok(snap.error, "占位快照必须带 error");
}

test("buildClaudeSnapshot 未登录时写占位快照", async () => {
  const snap = await buildClaudeSnapshot(async () => null, neverCalledClient, NOW_ISO);
  assertPlaceholder(snap);
  assert.match(snap.error, /未登录/);
});

test("buildClaudeSnapshot 凭据读取抛错时写占位快照而非冒泡", async () => {
  const snap = await buildClaudeSnapshot(
    async () => {
      throw new Error("keychain exploded");
    },
    neverCalledClient,
    NOW_ISO,
  );
  assertPlaceholder(snap);
});

test("buildClaudeSnapshot HTTP 401 时写占位快照且不含令牌", async () => {
  const snap = await buildClaudeSnapshot(
    async () => ({ accessToken: FAKE_TOKEN }),
    () => ({
      fetchUsage: async () => {
        throw new ClaudeUsageHttpError(401, "unauthorized");
      },
    }),
    NOW_ISO,
  );
  assertPlaceholder(snap);
  assert.doesNotMatch(snap.error, /sk-ant/);
});

test("buildClaudeSnapshot 客户端返回错误快照时原样透传，不补零窗口", async () => {
  const snap = await buildClaudeSnapshot(
    async () => ({ accessToken: FAKE_TOKEN }),
    () => ({
      fetchUsage: async () => ({ fetchedAt: NOW_ISO, error: "解析失败" }),
    }),
    NOW_ISO,
  );
  assertPlaceholder(snap);
  assert.equal(snap.error, "解析失败");
});

test("buildClaudeSnapshot 成功时返回真实窗口", async () => {
  const snap = await buildClaudeSnapshot(
    async () => ({ accessToken: FAKE_TOKEN }),
    () => ({
      fetchUsage: async () => ({
        fiveHour: { usedPercent: 7, availablePercent: 93 },
        sevenDay: { usedPercent: 3, availablePercent: 97 },
        fetchedAt: NOW_ISO,
      }),
    }),
    NOW_ISO,
  );
  assert.equal(snap.fiveHour.availablePercent, 93);
  assert.equal(snap.sevenDay.availablePercent, 97);
  assert.equal(snap.error, undefined);
});
