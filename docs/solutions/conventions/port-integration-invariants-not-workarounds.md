---
title: "移植集成的不变量，而不是它的权宜之计"
date: "2026-08-05"
category: conventions
module: Quota integrations (Codex / Grok / Claude Code)
problem_type: convention
component: tooling
severity: high
applies_when:
  - "新增一个与既有集成业务同构的第三方接口"
  - "打算把既有解析器当模板复制其防御性逻辑"
  - "既有学习文档的 Prevention 规则没有写明适用范围"
related_components: [tooling, documentation]
tags: [external-integration, quota-window, defensive-parsing, claude-code, grok, codex]
---

# 移植集成的不变量，而不是它的权宜之计

## Context

本仓库的状态栏原本只展示 Codex（`/wham/usage`）和 Grok（billing config）两路额度。在 `feat/multi-product-usage-strip` 分支上新接入第三路——Claude Code 的 `https://api.anthropic.com/api/oauth/usage`（`src/claudeQuotaClient.ts:6`）时，出现了一种很自然但危险的工作方式：把前两路解析器当成模板，整段照抄。

照抄之所以诱人，是因为三路接口在业务上确实同构：都是「若干额度窗口 + 已用百分比 + 重置时间」，展示层甚至共用同一个 `QuotaWindow` 类型。但接口的**形状**并不同构。前两路解析器里的代码可以分成两类：

- **不变量（invariant）**：来自本项目对「额度展示不能骗人」的立场，与具体接口无关。例如缺失窗口必须整窗省略、失败必须降级成显式占位。
- **变通（workaround）**：为某个接口的具体缺陷写的防御。例如按窗口时长归类，是为了绕开 `/wham/usage` 的槽位歧义；把 [0,1] 的值乘 100，是为了吃下 Grok 计费载荷的量纲抖动。

不变量该照抄，变通必须重新论证。这次接入中，两条变通分别走出了两种结局：一条被正确地判定为不需要移植，另一条差点被移植成一个线上 bug——计划文档明确建议复用它，理由是「便宜的保险」，靠一次对抗性审查才在实现前拦下。

## Guidance

**接入一个与既有集成平行的第三方接口时，逐条区分前一路的代码是不变量还是变通。不变量原样移植；每一条变通都要拿新接口的实测响应重新推导一遍，并在代码里写下「为什么这里不需要它」。**

具体做法：

**1. 先给每条防御标出它防的是什么。** 如果一条防御的理由能写成「因为接口 A 的字段 X 有缺陷」，那它就是变通，作用域只到接口 A。如果理由是「因为我们不能显示假数字」，那才是不变量。

**2. 对每条变通，问「这个缺陷在新接口上结构性地可能发生吗？」** 不是「大概率不会」，而是「响应形状是否允许它发生」。答案是否定的，就不要移植——多余的防御不是零成本，它自己就是新的失败模式。

**3. 不移植的决定要留在代码里，不要留在 PR 讨论里。** 下一个人会看到两个解析器不一致，然后「顺手统一」。`src/claudeQuotaClient.ts:47-54` 的注释就是为此而写：

```ts
/**
 * 解析 utilization（已用百分比，0–100 量纲）。
 *
 * 刻意不复用 Grok 的 coerceUsagePercent：那个会把 [0,1] 的值乘 100。
 * CC 的量纲已实测为 0–100，套用该启发式会把真实的 0.5%（还剩 99.5%）
 * 变成「已用 50%」，把 1.0 变成「已用 100% → 剩 0%」——正是本项目
 * 明令禁止的伪造 0%。它恰好在账号最健康时出错。
 */
```

同样地，`src/claudeQuotaClient.ts:114-119` 解释了为什么不按时长归类窗口：

```ts
/**
 * 把 usage 响应解析成快照。
 * 按字段名直接读 five_hour / seven_day：这两个键是自描述的，不存在
 * Codex /wham/usage 那种 primary/secondary 槽位歧义，因此不需要
 * 按时长归类——那样反而会引入新的失败模式。
 */
```

**4. 「不移植」的决定要有测试钉住，而不是只有注释。** 注释拦不住重构，测试可以。`test/claudeQuotaClient.test.js:42-64` 用两个测试把这条边界固定下来，断言写成 `equal` + `notEqual` 成对，让「被误移植后会变成什么」直接出现在测试文本里。

**5. 写学习文档时，给变通类结论标注作用域。** 一条没有作用域限定的变通结论，读起来就是通用规则，会误导下一个接入者（下节第一个实例正是如此）。

## Why This Matters

不必要的防御和缺失的防御，成本并不对称。缺失的防御通常在异常输入上出错，而移植错的防御会在**正常输入**上出错——它按设计就是要主动改写数据。

Grok 的 `coerceUsagePercent`（`src/grokQuotaClient.ts:114-129`）就是这样一段代码：

```ts
if (raw >= 0 && raw <= 1) {
  return clampPercent(raw * 100);
}
```

它对 Grok 是对的，因为那份计费载荷的量纲真的会变。但对 Claude Code 的 `utilization`（实测 0–100 量纲），这段代码的触发条件恰好是「本周几乎没用额度」。也就是说，它只在账号**最健康**的时候出错，并且错的方向是把余量报低。`utilization: 1.0` 会被换算成「已用 100% → 剩 0%」——一个凭空捏造的 0%。

这个数字的危害在本项目里已经有先例。既有学习文档《按窗口时长识别 /wham/usage 的 5h 与 7d 额度》记录过：缺失窗口曾被画成空进度条，用户读成「真的没额度了」（`docs/solutions/integration-issues/classify-wham-quota-windows-by-duration.md:26`、`:31`）。伪造的 0% 和缺失画成 0% 在 UI 上是同一个像素结果，只是伪造的那个更难发现——它有数据来源，看起来完全正常。

而这次接入时的实测值是 `five_hour: 7`、`seven_day: 3`（`test/claudeQuotaClient.test.js:16-17` 用的就是这组实测值）。7d 那个 3 距离出错区间只差一个不写代码的周末。移植进去，验收当天大概率一切正常，几天后开始报假数字。

## When to Apply

- 接入一个与既有集成**业务同构**的第三方接口时（同一类数据、同一套展示层类型），尤其是准备把既有解析器当模板复制的时候。
- 阅读或引用本仓库既有的 integration-issues 学习文档时——它们记录的多数是针对具体接口的变通，不是通用规则。
- 计划文档里出现「顺手复用」「便宜的保险」「反正加上不亏」这类措辞时。这类措辞默认防御是零成本的，而本文的两个实例说明它不是。
- 反过来：本文**不适用**于不变量。缺失窗口整窗省略（`src/claudeQuotaClient.ts:81-97`）、失败降级为占位（`src/claudeQuotaClient.ts:155-180`）、倒计时在渲染时现算（`src/accountPresentation.ts:270-290`）、测试同时断言可用率 / 窗口时长 / 重置时间（`test/claudeQuotaClient.test.js:21-33`）——这四条不需要重新论证，直接照抄。

## Examples

### 实例一：按时长归类窗口——正确地没有移植

**前一路的情况。** Codex 的 `/wham/usage` 返回 `primary_window` / `secondary_window`，这是**位置槽位**，含义不固定：只有 weekly 额度时，604800 秒的 7d 窗口会出现在 `primary_window` 里。修复方式是收集完窗口后按 `windowMinutes` 归类，不信槽位顺序（`src/quotaClient.ts:59-62`）：

```ts
// /wham/usage 不保证 primary/secondary 槽位分别对应 5h/7d。
// 例如只有 weekly 额度时，当前接口会把 7d 窗口放在 primary_window。
const primary = windows.find((window) => (window.windowMinutes ?? 0) < 24 * 60);
const secondary = windows.find((window) => (window.windowMinutes ?? 0) >= 24 * 60);
```

**新接口的情况。** Claude Code 返回的是 `five_hour` 和 `seven_day`（`src/claudeQuotaClient.ts:21-24`）——**语义化键名**。槽位歧义在这个响应形状下结构性地不可能发生：键名本身就是分类。

**结论。** 不移植。真移植了会怎样？时长归类需要先有 `windowMinutes` 才能分类，而 CC 的接口根本不返回周期起点，`windowMinutes` 只能由键名反推标称值（`src/claudeQuotaClient.ts:12-14`）：

```ts
/** 窗口名 → 标称时长（分钟）。接口不返回周期起点，无法像 Grok 那样由起止相减得出 */
const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 7 * 24 * 60;
```

也就是说，归类逻辑只会拿着自己刚填进去的常数再分一次类——纯粹的绕圈，且多出一条「常数写错则窗口错位」的路径。防御变成了失败模式。

**这个实例暴露的文档问题。** 前一条学习文档的 Prevention 里写的是（`docs/solutions/integration-issues/classify-wham-quota-windows-by-duration.md:55`）：

> 新增或调整 `/wham/usage` 字段时，优先使用窗口的显式时长作为业务分类依据；仅在旧响应没有该信息时才使用槽位名降级。

前半句限定了 `/wham/usage`，但「优先使用窗口的显式时长作为业务分类依据」这句结论本身没有作用域标记，单独读就是一条通行规则。写变通类结论时，作用域要长在结论句子里，不能只靠上下文。

### 实例二：0–1 小数启发式——差点移植，会是线上 bug

**前一路的情况。** `src/grokQuotaClient.ts:114-129` 的 `coerceUsagePercent` 把 [0,1] 区间的值乘 100，因为 Grok 的计费载荷量纲确实会变。这在 Grok 一侧是必要的。

**计划里的建议。** 实现计划明确写了复用它，理由是「便宜的保险」——反正 CC 的值也是百分比，多一层兼容不亏。

**对抗性审查发现的问题。** CC 的 `utilization` 已实测为 0–100 量纲。套上这条启发式后：

| `utilization` 实际含义 | 正确输出 | 套用启发式后 |
| --- | --- | --- |
| `0.5`（已用 0.5%） | 剩 99.5% | 剩 50% |
| `1.0`（已用 1%） | 剩 99% | **剩 0%** |

第二行是伪造的 0%——本项目明令禁止的东西，并且触发条件是「账号几乎没被用过」。当时的实测值是 `five_hour: 7` / `seven_day: 3`，离出错区间只差一天不用。

**最终代码。** `parseUtilization`（`src/claudeQuotaClient.ts:55-66`）刻意不做量纲猜测，只做解析和夹取：

```ts
function parseUtilization(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return clampPercent(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const numeric = Number(raw.trim().replace(/%$/, ""));
    if (Number.isFinite(numeric)) {
      return clampPercent(numeric);
    }
  }
  return undefined;
}
```

**钉住它的测试。** `test/claudeQuotaClient.test.js:42-64` 两个守护测试，把「被误移植后的错误值」直接写进断言：

```js
test("parseUsageResponseToSnapshot utilization 0.5 → 剩 99.5%，不是 50%", () => {
  // 守护 KTD7：不得把 [0,1] 当小数乘 100，那会在账号最健康时报出腰斩的余量
  ...
  assert.equal(snap.fiveHour.availablePercent, 99.5);
  assert.notEqual(snap.fiveHour.availablePercent, 50);
});

test("parseUsageResponseToSnapshot utilization 1.0 → 剩 99%，不是 0%", () => {
  // 同样守护 KTD7：1.0 被当成小数会变成「已用 100% → 剩 0%」，即伪造的 0%
  ...
  assert.equal(snap.fiveHour.availablePercent, 99);
  assert.notEqual(snap.fiveHour.availablePercent, 0);
});
```

`notEqual` 那一行不是冗余：它让「误移植会产生什么值」变成可执行的记录，重构者复用 `coerceUsagePercent` 时会直接撞上带解释的失败断言，而不是只看到一个陌生的期望值。

### 对照：这次照抄了什么

四条不变量原样移植，没有重新论证的必要：

- **窗口解析不了就整窗省略，绝不退化成 0 或 100**——`src/claudeQuotaClient.ts:81-97`，注释直接引用了前一条学习文档的教训：「缺失窗口画成空条会被误读为『真的没额度了』」。测试见 `test/claudeQuotaClient.test.js:77-118`。
- **测试同时断言可用率、窗口时长、重置时间**——`test/claudeQuotaClient.test.js:21-33`。这条在前一条学习文档的 Prevention 里就有（`:54`），三者必须作为同一个窗口一起被验证。
- **倒计时从绝对时间在渲染时现算，不在拉取时冻结成秒数**——`src/claudeQuotaClient.ts:110` 保存 `resetAt` 的 ISO 字符串，`src/accountPresentation.ts:270-290` 的 `getClaudeResetAfterSeconds` 在渲染时用 `nowMs` 现减；`resetAfterSeconds` 只作为没有绝对时间时的兜底（`src/claudeQuotaClient.ts:104-105`）。`test/claudeQuotaClient.test.js:35-40` 专门钉住「原样保存 `resets_at`，不冻结成倒计时」。
- **失败一律降级为显式占位，不编数字**——`buildClaudeSnapshot`（`src/claudeQuotaClient.ts:155-180`）对凭据读取失败、未登录、请求失败三条路径分别写入带 `error` 的空快照。

## Related

- [按窗口时长识别 /wham/usage 的 5h 与 7d 额度](../integration-issues/classify-wham-quota-windows-by-duration.md) —— 实例一的来源。那篇记录了 Codex 为何需要按时长归类；本文补充的是它的**适用边界**：该做法解决的是槽位名歧义，因此对 `five_hour` / `seven_day` 这类自描述键不适用。该文 Prevention 第 2 条目前写成了无作用域限定的通则，建议补上适用前提。
- 代码锚点：`src/claudeQuotaClient.ts` 的 `parseUtilization` 与 `parseUsageResponseToSnapshot` 注释记录了两处「刻意不移植」的决定；`test/claudeQuotaClient.test.js` 的两个守护测试把边界钉死。改动其中任何一处时，另外两处应同步检查。

---

*状态：截至撰写时，以上代码位于**未合并**分支 `feat/multi-product-usage-strip`，仓库当前无关联 PR。
撰写时的分支 HEAD 为 `d4bb2f4`——这是本地提交，合并（rebase / squash）后该 SHA 会被改写，
因此它只作为撰写时点的记录，不要用它去检出；合并后请以 PR 号为准。
文中行号对应该分支当时的树，其后的改动可能造成偏移。*
