# Changelog

所有显著变更都记录在此文件中。

## [0.0.82] - 2026-08-05

### Changed

- 账号命名、重命名与数字配置的输入框改为在底部面板内联询问，不再从 VS Code 窗口顶部弹出。原先的 showInputBox 永远出现在窗口顶端，离用户实际操作的位置很远，容易让人不知道发生了什么。校验规则（非空、数值范围）同步在面板内实现。

## [0.0.81] - 2026-08-05

### Changed

- 移除状态栏悬停的额度详情 Markdown 气泡：内容已由底部面板承载，悬停只保留「点击查看额度详情」一句提示。同时清理随之失效的 tooltip 构建链（statusBar.ts 823 → 440 行）与不再可达的 refreshQuotasFromTooltip 命令。

## [0.0.80] - 2026-08-05

### Changed

- 新增 Claude Code 5h / 7d 剩余用量显示：状态栏三段（CC · Codex · Grok，均只显 7d），tooltip 与底部面板显示 5h 与 7d 及重置倒计时。只读读取本机 CC 登录（macOS Keychain 优先，回退 ~/.claude/.credentials.json），不存凭据、不切账号、不参与自动切号。失败一律显式占位，绝不显示伪造的额度数字。

## [0.0.79] - 2026-08-05

### Changed

- 状态栏用量条前缀 icon 由 account 改为 robot
- 面板 / tooltip 产品顺序改为 CC → Codex → Grok

## [0.0.78] - 2026-08-05

### Changed

- 状态栏用量条极简：仅 7d，顺序 CC · Codex · Grok，无产品名（例：`⬜— · 🟩77% · 🟨44%`）
- 用量条 priority 改为负值，尽量靠右贴近通知铃铛

## [0.0.77] - 2026-08-05

### Changed

- 用量条二次点击关闭 Agent 用量面板
- 底部面板标题改为 Agent 用量

## [0.0.76] - 2026-08-05

### Changed

- 菜单 icon 与用量条使用相邻高 priority，尽量紧贴
- 额度详情恢复气泡同款布局（额度一览/账号/精简操作），并写入 tooltip

## [0.0.75] - 2026-08-05

### Changed

- 状态栏用量条：账号名改为产品名 codex
- 增加 Claude Code（CC）5h/7d 占位显示

## [0.0.74] - 2026-08-05

### Changed

- 状态栏拆成用量段+菜单 icon：左键详情 / 左键菜单
- 额度详情与账号操作改在底部 Panel Webview 展示，避免顶部 QuickPick 割裂
- 移除悬停详情与状态栏右键菜单，统一左键交互

## [0.0.73] - 2026-08-05

### Changed

- Grok 周期剩余改为优先 creditUsagePercent，对齐 /usage Weekly limit（已用 52% → 剩余 48%）
- GrokBuild 分项仅作缺失 overall 时的回退

## [0.0.72] - 2026-08-05

### Changed

- 状态栏并排显示本机 Grok Build 周期剩余百分比（peer 于 Codex）
- 悬停展示 Grok 重置/更新时间；未登录或失败时占位
- 新增版本脚本：npm run release / vsix，避免同版本号重复打包

## [0.0.71] - 2026-07-27

### Changed

- 扩展显示名称更新为 **Konghai Codex & Claude Code Account Manager**，为后续 Claude Code 账号管理能力预留产品命名。

## [0.0.70] - 2026-07-27

### Added

- 为首次公开发布准备 Visual Studio Code Marketplace 元数据。
- 为缺失的额度窗口增加明确的“暂不可用”提示。
- 增加额度窗口解析与展示的回归测试。

### Fixed

- 按接口返回的实际窗口时长识别 5h 与 7d 额度。
- 优先使用接口提供的额度重置倒计时。
