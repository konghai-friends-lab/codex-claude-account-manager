const assert = require("node:assert/strict");
const test = require("node:test");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadClaudeAuth, selectClaudeAuthFromParsed } = require("../out/claudeAuth");

// 明显合成的哨兵值：一眼可辨不是真凭据
const FAKE_TOKEN = "sk-ant-oat01-FAKE-TOKEN-FOR-TESTS-ONLY";
const NOW = Date.parse("2026-08-05T00:00:00.000Z");

function payload(oauth) {
  return { claudeAiOauth: oauth };
}

test("selectClaudeAuthFromParsed 解析完整 payload", () => {
  const auth = selectClaudeAuthFromParsed(
    payload({
      accessToken: FAKE_TOKEN,
      subscriptionType: "max",
      expiresAt: NOW + 86_400_000,
    }),
    NOW,
  );
  assert.equal(auth.accessToken, FAKE_TOKEN);
  assert.equal(auth.subscriptionType, "max");
});

test("selectClaudeAuthFromParsed 缺少 claudeAiOauth 返回 null", () => {
  assert.equal(selectClaudeAuthFromParsed({ mcpOAuth: {} }, NOW), null);
});

test("selectClaudeAuthFromParsed 缺少或空 accessToken 返回 null", () => {
  assert.equal(selectClaudeAuthFromParsed(payload({ subscriptionType: "max" }), NOW), null);
  assert.equal(selectClaudeAuthFromParsed(payload({ accessToken: "   " }), NOW), null);
});

test("selectClaudeAuthFromParsed expiresAt 已过期返回 null", () => {
  const auth = selectClaudeAuthFromParsed(
    payload({ accessToken: FAKE_TOKEN, expiresAt: NOW - 1000 }),
    NOW,
  );
  assert.equal(auth, null);
});

test("selectClaudeAuthFromParsed expiresAt 为未来 epoch 毫秒时可用", () => {
  // 实测形状：epoch 毫秒 number，不是 ISO 字符串
  const auth = selectClaudeAuthFromParsed(
    payload({ accessToken: FAKE_TOKEN, expiresAt: 1785935407201 }),
    1785935407201 - 1000,
  );
  assert.equal(auth.accessToken, FAKE_TOKEN);
});

test("selectClaudeAuthFromParsed 缺少 expiresAt 视为可用", () => {
  const auth = selectClaudeAuthFromParsed(payload({ accessToken: FAKE_TOKEN }), NOW);
  assert.equal(auth.accessToken, FAKE_TOKEN);
});

test("selectClaudeAuthFromParsed expiresAt 类型无法识别时按可用处理", () => {
  // 失败方向必须偏安全：宁可多跑一次请求拿 401，
  // 也不要因为单位/类型判断失误而永久显示「未登录」
  for (const weird of [{}, [], true, "not-a-date"]) {
    const auth = selectClaudeAuthFromParsed(
      payload({ accessToken: FAKE_TOKEN, expiresAt: weird }),
      NOW,
    );
    assert.equal(auth?.accessToken, FAKE_TOKEN, `expiresAt=${JSON.stringify(weird)} 应按可用处理`);
  }
});

test("selectClaudeAuthFromParsed 非对象输入返回 null", () => {
  assert.equal(selectClaudeAuthFromParsed(null, NOW), null);
  assert.equal(selectClaudeAuthFromParsed([], NOW), null);
  assert.equal(selectClaudeAuthFromParsed("string", NOW), null);
  assert.equal(selectClaudeAuthFromParsed(undefined, NOW), null);
});

test("selectClaudeAuthFromParsed 失败路径不泄露令牌", () => {
  // 过期条目返回 null，不应有任何出口携带令牌文本
  const result = selectClaudeAuthFromParsed(
    payload({ accessToken: FAKE_TOKEN, expiresAt: NOW - 1 }),
    NOW,
  );
  assert.equal(result, null);
  assert.doesNotMatch(JSON.stringify(result), /sk-ant/);
});


// ---- loadClaudeAuth 文件回退路径 ----
// 这是 Windows / Linux 用户唯一的取数路径，且计划里标注为「未在真机验证」(A1)。
// 用注入的 credentialsPath 覆盖，至少保证解析链本身不会静默失效。

function withTempCredentials(contents, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-auth-test-"));
  const file = path.join(dir, ".credentials.json");
  fs.writeFileSync(file, contents, "utf8");
  try {
    return run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("loadClaudeAuth 从文件回退路径读出令牌", async () => {
  const payload = JSON.stringify({
    claudeAiOauth: { accessToken: FAKE_TOKEN, subscriptionType: "max" },
  });
  const auth = await withTempCredentials(payload, (file) => loadClaudeAuth(file, NOW, { useKeychain: false }));
  // 只断言是否等于哨兵值，不把 auth 内容打进断言输出——
  // 万一取到的是真凭据，失败信息会把令牌写进日志。
  assert.equal(auth?.accessToken === FAKE_TOKEN, true, "应读到测试哨兵令牌");
  assert.equal(auth?.subscriptionType, "max");
});

test("loadClaudeAuth 文件不存在时返回 null，不抛错", async () => {
  const missing = path.join(os.tmpdir(), "cc-auth-does-not-exist", ".credentials.json");
  assert.equal(await loadClaudeAuth(missing, NOW, { useKeychain: false }), null);
});

test("loadClaudeAuth 文件内容非法 JSON 时返回 null，不抛错", async () => {
  const auth = await withTempCredentials("not json at all", (file) => loadClaudeAuth(file, NOW, { useKeychain: false }));
  assert.equal(auth, null);
});

test("loadClaudeAuth 文件里令牌已过期时返回 null", async () => {
  const payload = JSON.stringify({
    claudeAiOauth: { accessToken: FAKE_TOKEN, expiresAt: NOW - 1000 },
  });
  const auth = await withTempCredentials(payload, (file) => loadClaudeAuth(file, NOW, { useKeychain: false }));
  assert.equal(auth, null);
});
