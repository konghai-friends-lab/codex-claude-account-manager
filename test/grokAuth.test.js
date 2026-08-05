const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isGrokAuthIdentityKey,
  selectGrokAuthFromParsed,
} = require("../out/grokAuth");

test("isGrokAuthIdentityKey 接受 auth.x.ai", () => {
  assert.equal(isGrokAuthIdentityKey("https://auth.x.ai::abc"), true);
  assert.equal(isGrokAuthIdentityKey("random"), false);
});

test("selectGrokAuthFromParsed: 单 entry", () => {
  const auth = selectGrokAuthFromParsed({
    "https://auth.x.ai::u1": {
      key: "token-a",
      email: "a@example.com",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  });
  assert.equal(auth?.accessToken, "token-a");
  assert.equal(auth?.email, "a@example.com");
});

test("selectGrokAuthFromParsed: 多 entry 取未过期且 expires 最新", () => {
  const now = Date.parse("2026-08-05T00:00:00.000Z");
  const auth = selectGrokAuthFromParsed(
    {
      "https://auth.x.ai::old": {
        key: "token-old",
        expires_at: "2026-08-10T00:00:00.000Z",
      },
      "https://auth.x.ai::new": {
        key: "token-new",
        expires_at: "2026-08-20T00:00:00.000Z",
      },
      "https://other.example::x": {
        key: "token-noise",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    },
    now,
  );
  assert.equal(auth?.accessToken, "token-new");
});

test("selectGrokAuthFromParsed: 全部过期返回 null", () => {
  const now = Date.parse("2026-08-05T00:00:00.000Z");
  const auth = selectGrokAuthFromParsed(
    {
      "https://auth.x.ai::expired": {
        key: "token-x",
        expires_at: "2026-08-01T00:00:00.000Z",
      },
    },
    now,
  );
  assert.equal(auth, null);
});

test("selectGrokAuthFromParsed: 非法结构返回 null", () => {
  assert.equal(selectGrokAuthFromParsed(null), null);
  assert.equal(selectGrokAuthFromParsed([]), null);
  assert.equal(selectGrokAuthFromParsed({ foo: "bar" }), null);
});
