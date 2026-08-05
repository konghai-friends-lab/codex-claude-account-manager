const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ClaudeQuotaClient,
  ClaudeUsageHttpError,
  parseUsageResponseToSnapshot,
} = require("../out/claudeQuotaClient");

const NOW = Date.parse("2026-08-05T00:00:00.000Z");
const FETCHED_AT = "2026-08-05T00:00:00.000Z";
const FAKE_TOKEN = "sk-ant-oat01-FAKE-TOKEN-FOR-TESTS-ONLY";

function fullResponse() {
  return {
    five_hour: { utilization: 7, resets_at: "2026-08-05T07:59:59.000Z" },
    seven_day: { utilization: 3, resets_at: "2026-08-11T21:59:59.000Z" },
  };
}

test("parseUsageResponseToSnapshot 解析双窗口：可用率 / 窗口时长 / 重置一并断言", () => {
  const snap = parseUsageResponseToSnapshot(fullResponse(), FETCHED_AT, 200, NOW);

  assert.equal(snap.fiveHour.availablePercent, 93);
  assert.equal(snap.fiveHour.windowMinutes, 300);
  assert.equal(snap.fiveHourResetAt, "2026-08-05T07:59:59.000Z");

  assert.equal(snap.sevenDay.availablePercent, 97);
  assert.equal(snap.sevenDay.windowMinutes, 10080);
  assert.equal(snap.sevenDayResetAt, "2026-08-11T21:59:59.000Z");

  assert.equal(snap.error, undefined);
});

test("parseUsageResponseToSnapshot 原样保存 resets_at，不冻结成倒计时", () => {
  // 倒计时必须在渲染时现算；把绝对时间丢掉就无法满足 R6/AE5
  const snap = parseUsageResponseToSnapshot(fullResponse(), FETCHED_AT, 200, NOW);
  assert.equal(typeof snap.sevenDayResetAt, "string");
  assert.equal(snap.sevenDayResetAt, "2026-08-11T21:59:59.000Z");
});

test("parseUsageResponseToSnapshot utilization 0.5 → 剩 99.5%，不是 50%", () => {
  // 守护 KTD7：不得把 [0,1] 当小数乘 100，那会在账号最健康时报出腰斩的余量
  const snap = parseUsageResponseToSnapshot(
    { five_hour: { utilization: 0.5 }, seven_day: { utilization: 0.5 } },
    FETCHED_AT,
    200,
    NOW,
  );
  assert.equal(snap.fiveHour.availablePercent, 99.5);
  assert.notEqual(snap.fiveHour.availablePercent, 50);
});

test("parseUsageResponseToSnapshot utilization 1.0 → 剩 99%，不是 0%", () => {
  // 同样守护 KTD7：1.0 被当成小数会变成「已用 100% → 剩 0%」，即伪造的 0%
  const snap = parseUsageResponseToSnapshot(
    { five_hour: { utilization: 1 }, seven_day: { utilization: 1 } },
    FETCHED_AT,
    200,
    NOW,
  );
  assert.equal(snap.fiveHour.availablePercent, 99);
  assert.notEqual(snap.fiveHour.availablePercent, 0);
});

test("parseUsageResponseToSnapshot 越界 utilization 被夹取", () => {
  const snap = parseUsageResponseToSnapshot(
    { five_hour: { utilization: 140 }, seven_day: { utilization: -20 } },
    FETCHED_AT,
    200,
    NOW,
  );
  assert.equal(snap.fiveHour.availablePercent, 0);
  assert.equal(snap.sevenDay.availablePercent, 100);
});

test("parseUsageResponseToSnapshot 仅 five_hour 时 sevenDay 省略而非归零", () => {
  const snap = parseUsageResponseToSnapshot(
    { five_hour: { utilization: 10, resets_at: "2026-08-05T07:59:59.000Z" } },
    FETCHED_AT,
    200,
    NOW,
  );
  assert.equal(snap.fiveHour.availablePercent, 90);
  assert.equal(snap.sevenDay, undefined);
  assert.ok(snap.error, "缺失窗口应记录原因");
});

test("parseUsageResponseToSnapshot 缺 five_hour 时不伪造 0%/100%（AE4）", () => {
  const snap = parseUsageResponseToSnapshot(
    { seven_day: { utilization: 3, resets_at: "2026-08-11T21:59:59.000Z" } },
    FETCHED_AT,
    200,
    NOW,
  );
  assert.equal(snap.fiveHour, undefined);
  assert.equal(snap.fiveHourResetAt, undefined);
  assert.equal(snap.sevenDay.availablePercent, 97);
});

test("parseUsageResponseToSnapshot 两个窗口都解析不了时只带 error", () => {
  const snap = parseUsageResponseToSnapshot({}, FETCHED_AT, 200, NOW);
  assert.equal(snap.fiveHour, undefined);
  assert.equal(snap.sevenDay, undefined);
  assert.ok(snap.error);
});

test("parseUsageResponseToSnapshot utilization 非数值时省略该窗口", () => {
  const snap = parseUsageResponseToSnapshot(
    { five_hour: { utilization: null }, seven_day: { utilization: "abc" } },
    FETCHED_AT,
    200,
    NOW,
  );
  assert.equal(snap.fiveHour, undefined);
  assert.equal(snap.sevenDay, undefined);
  assert.ok(snap.error);
});

test("parseUsageResponseToSnapshot resets_at 缺失时窗口仍在", () => {
  const snap = parseUsageResponseToSnapshot(
    { five_hour: { utilization: 20 }, seven_day: { utilization: 10 } },
    FETCHED_AT,
    200,
    NOW,
  );
  assert.equal(snap.fiveHour.availablePercent, 80);
  assert.equal(snap.fiveHourResetAt, undefined);
  assert.equal(snap.fiveHour.resetAfterSeconds, undefined);
});

test("ClaudeQuotaClient 非法 JSON 保留 statusCode", async () => {
  const client = new ClaudeQuotaClient({ accessToken: FAKE_TOKEN }, 1000);
  client.requestUsage = async () => ({ body: "not json", statusCode: 200 });
  const snap = await client.fetchUsage();
  assert.equal(snap.statusCode, 200);
  assert.match(snap.error, /JSON/);
});

test("ClaudeQuotaClient HTTP 401 写入 statusCode 且不泄露令牌", async () => {
  const client = new ClaudeQuotaClient({ accessToken: FAKE_TOKEN }, 1000);
  client.requestUsage = async () => {
    throw new ClaudeUsageHttpError(401, "unauthorized");
  };
  const snap = await client.fetchUsage();
  assert.equal(snap.statusCode, 401);
  assert.doesNotMatch(snap.error, /sk-ant/);
  assert.equal(snap.fiveHour, undefined);
});

test("ClaudeUsageHttpError 截断过长 body 摘要", () => {
  const err = new ClaudeUsageHttpError(500, "x".repeat(500));
  assert.ok(err.message.length < 200, `摘要应被截断，实际长度 ${err.message.length}`);
});

test("ClaudeQuotaClient 网络错误降级为 error 快照", async () => {
  const client = new ClaudeQuotaClient({ accessToken: FAKE_TOKEN }, 1000);
  client.requestUsage = async () => {
    throw new Error("socket hang up");
  };
  const snap = await client.fetchUsage();
  assert.ok(snap.error);
  assert.equal(snap.fiveHour, undefined);
  assert.equal(snap.sevenDay, undefined);
});

test("ClaudeQuotaClient 解析成功响应", async () => {
  const client = new ClaudeQuotaClient({ accessToken: FAKE_TOKEN }, 1000);
  client.requestUsage = async () => ({
    body: JSON.stringify(fullResponse()),
    statusCode: 200,
  });
  const snap = await client.fetchUsage();
  assert.equal(snap.fiveHour.availablePercent, 93);
  assert.equal(snap.sevenDay.availablePercent, 97);
});

test("慢速滴流响应必须被端到端超时掐断", async () => {
  // 回归守护：request.setTimeout 是「空闲超时」，对端每隔一小段时间滴一个
  // 字节就能无限重置它，Promise 于是永远挂着。而它挂着会占住 refreshing
  // 标志，连带让 Codex 与 Grok 也停止刷新——正是本改动承诺不会发生的事。
  const http = require("node:http");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    const timer = setInterval(() => res.write(" "), 50);
    res.on("close", () => clearInterval(timer));
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const client = new ClaudeQuotaClient({ accessToken: FAKE_TOKEN }, 400);
    // 直连本地测试服务器，绕开写死的 https URL
    client.requestUsage = function () {
      return new Promise((resolve, reject) => {
        let settled = false;
        let deadline;
        const finish = (fn) => {
          if (settled) return;
          settled = true;
          if (deadline) clearTimeout(deadline);
          fn();
        };
        const req = http.request({ port, path: "/" }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { body += c; });
          res.on("end", () => finish(() => resolve({ body, statusCode: 200 })));
        });
        req.setTimeout(400, () => { req.destroy(); finish(() => reject(new Error("空闲超时"))); });
        deadline = setTimeout(() => { req.destroy(); finish(() => reject(new Error("请求超时（端到端）"))); }, 400);
        req.on("error", () => finish(() => reject(new Error("socket error"))));
        req.end();
      });
    };

    const started = Date.now();
    const snap = await client.fetchUsage();
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 3000, `必须被截止时间掐断，实际耗时 ${elapsed}ms`);
    assert.ok(snap.error, "超时应降级为占位快照");
    assert.equal(snap.fiveHour, undefined);
    assert.equal(snap.sevenDay, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
