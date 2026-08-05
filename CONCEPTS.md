# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Quota retrieval

### Quota window

Codex 服务发布的一段独立用量额度，以窗口时长、可用百分比和下一次重置时间共同描述。

### Quota snapshot

某个账号一次刷新得到的额度窗口视图，归一为 5h 和 7d 两类以供展示和账号选择使用。

## Multi-product remaining

### Multi-product remaining strip

状态栏上把不同 coding agent 产品的剩余额度作为对等段并排展示的视图。对等段顺序为 CC · Codex · Grok；不是多账号列表本身。状态栏每段只显 7d，5h 放 tooltip 与底部面板。

### Grok period remaining

本机当前登录的 Grok Build/CLI 在某个用量重置周期内还剩的可用比例。标签跟随真实窗口（仅当窗口确为约 7 天时才标 7d），与 Codex 的 7d 窗口是不同产品的额度概念。

### Claude Code usage

本机当前登录的 Claude Code 的 5h 与 7d 剩余可用比例。与 Grok 同属「只读单一本机登录」模型（不存凭据、不切账号、不参与自动切号），区别于 Codex 的多账号额度。
