---
title: "按窗口时长识别 /wham/usage 的 5h 与 7d 额度"
date: "2026-07-27"
category: integration-issues
module: Codex quota retrieval
problem_type: integration_issue
component: tooling
symptoms:
  - "只有 weekly 额度时，7d 剩余额度与重置时间可能落在错误的槽位"
  - "缺失的 5h 数据曾被呈现为空额度进度条，容易被误解为真实余额"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags: [wham-usage, quota-window, weekly-quota, primary-window]
---

# 按窗口时长识别 /wham/usage 的 5h 与 7d 额度

## Problem

Codex 的 `/wham/usage` 响应中，`primary_window` 和 `secondary_window` 不保证分别代表 5 小时与 7 天额度。把槽位名直接当作业务含义，会让 weekly（7d）的剩余额度和重置时间被归类错误。

## Symptoms

- 账号只有 weekly 额度时，接口会在 `primary_window` 返回一个时长为 604800 秒的窗口；旧逻辑会把它当成 5h。
- 账户列表可能显示错误的 7d 信息，或为没有返回的 5h 数据画出一条没有业务含义的空进度条。

## What Didn't Work

- 以 `primary_window` 等同 5h、`secondary_window` 等同 7d。这个假设只适用于部分响应形状，无法处理 weekly 位于 primary 槽位的响应。
- 在窗口缺失时复用默认空条。空条看起来像 0% 额度，而不是“服务端未返回该窗口”。

## Solution

保留接口槽位的兼容读取，但在解析后依据 `limit_window_seconds` 归类：小于 24 小时的是 5h，大于或等于 24 小时的是 7d。`src/quotaClient.ts:54` 至 `src/quotaClient.ts:62` 收集两个可用窗口后执行这一步，而 `src/quotaClient.ts:239` 至 `src/quotaClient.ts:245` 将接口秒数转换为分钟，并只在旧响应缺失窗口长度时使用旧槽位语义作为降级。

```ts
const primary = windows.find((window) => (window.windowMinutes ?? 0) < 24 * 60);
const secondary = windows.find((window) => (window.windowMinutes ?? 0) >= 24 * 60);
```

解析器继续优先使用服务端给出的 `reset_after_seconds`，并在其缺失时从秒或毫秒时间戳计算剩余秒数（`src/quotaClient.ts:215` 至 `src/quotaClient.ts:235`）。因此，正确归类的 7d 窗口会把对应重置时间传给状态栏。

展示层对缺失窗口明确输出“暂不可用”（`src/accountPresentation.ts:159` 至 `src/accountPresentation.ts:193`），不再将缺失误画成额度为零的条形图。状态栏将 secondary 窗口的重置时间标为 7d（`src/statusBar.ts:226` 至 `src/statusBar.ts:235`）。

回归测试覆盖两个接口形状：仅有 weekly 且位于 `primary_window`，以及 5h 与 7d 同时存在（`test/quotaClient.test.js`）；另有测试覆盖缺失 5h 时的文本呈现（`test/accountPresentation.test.js`）。

## Why This Works

窗口时长是接口响应中与产品语义直接对应的属性；槽位名只是传输结构。`QuotaWindow` 同时保存窗口时长、可用百分比和重置秒数（`src/types.ts:19` 至 `src/types.ts:24`），所以按时长归类后，额度与重置时间会始终作为同一个窗口一起进入 5h 或 7d 展示。

## Prevention

- 为外部额度接口保留“weekly 位于 primary 槽位”的测试样本，并同时断言可用百分比、窗口时长和重置秒数。
- 新增或调整 `/wham/usage` 字段时，优先使用窗口的显式时长作为业务分类依据；仅在旧响应没有该信息时才使用槽位名降级。
- 缺失数据使用“暂不可用”等明确状态，避免用数值或图形默认值暗示服务端返回了真实额度。

## Related Issues

- 未发现相关的项目学习文档或 GitHub Issue。
