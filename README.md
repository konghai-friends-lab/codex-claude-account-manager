# Konghai Codex & Claude Code Account Manager

一个基于 VS Code 的 Codex 多账号管理插件，目标是把下面几件事放到一个状态栏里完成：

- 管理多个 Codex 账号
- 每 5 分钟自动刷新每个账号可用的 5 小时 / 7 天额度
- 手动切换当前账号时，同步覆盖官方 `Codex - OpenAI's coding agent` 扩展正在使用的 `auth.json`
- 状态栏常驻显示当前账号、账号级别和当前 5 小时可用额度
- 左键点击状态栏用量条，在底部面板看到所有账号列表，以及带颜色进度条的 5 小时 / 7 天可用额度
- 支持把已保存账号导出为配置包，并在另一台机器上整体导入恢复
- access token 失效时，自动尝试用 refresh token 恢复并回写当前 `auth.json`
- 支持配置自动切号阈值和优先级：可按最低窗口 / 5h / 7d 策略，在低额度时自动切到更优账号，且默认会等 Codex 空闲后再切


- 提供账号健康检查视图，集中标出 refresh token 缺失、恢复失败、低额度和额度异常
- 提供“快速修复问题账号”流程，可直接重试刷新、切换账号、重新导入或打开 `auth.json`
- 支持一键切回上一个账号，适合两个主力号来回倒手







## 已实现能力

### 1. 多账号导入与保存

支持两种导入方式：

- 从当前环境的 `~/.codex/auth.json` 导入
- 从任意 `auth.json` 文件导入

账号基础信息保存在扩展全局存储中，敏感令牌保存在 VS Code Secret Storage 中。

### 2. 额度自动刷新

插件会定时请求 Codex 额度数据，并按接口返回的窗口时长识别 5 小时和 7 天额度。

当前实现展示的是 **剩余额度百分比**，也就是：

- 5 小时可用额度 = `100 - primary used percent`
- 7 天可用额度 = `100 - secondary used percent`

如果当前激活账号在刷新后触发了自动切号阈值，插件会自动：

1. 对比所有已刷新账号的剩余额度
2. 按你配置的优先级策略排序：
   - `lowest-window-first`：最低窗口优先（默认）
   - `primary-first`：5h 优先
   - `secondary-first`：7d 优先
3. 默认先检查官方 Codex 最近是否仍有会话写入：如果还在忙，就先延后；只有在判定为空闲后，才会自动切到当前策略下更优的账号并同步覆盖官方 Codex 扩展正在使用的 `auth.json`


默认阈值是 `5%`，也可以自己改，比如：

```json
"codexAccountManager.autoSwitchThresholdPercent": 10,
"codexAccountManager.autoSwitchPriority": "primary-first",
"codexAccountManager.autoSwitchRequiresCodexIdle": true,
"codexAccountManager.codexIdleThresholdSeconds": 30
```


如果你不想自动切号，直接把阈值设成 `0` 就行。

> 说明：可用额度按剩余百分比展示。Codex 接口偶尔只返回其中一个窗口；此时插件会明确显示“暂不可用”，不会猜测或伪造另一个窗口的数据。


### 3. 状态栏与底部面板

状态栏右侧拆成两段，**只依赖左键**（不再依赖悬停看详情）：

```text
🟩97% · 🟩81% · 🟨48% ☰
└── CC · Codex · Grok（均为 7d）  └── 紧贴用量条，点击打开操作菜单
```

- **用量段**：三产品并排 — **CC** · **Codex** · **Grok**，均只显 7d 以保持紧凑；左键打开详情（额度一览 + 账号列表 + 精简操作）
- **5h 额度**：CC 与 Codex 的 5 小时窗口在底部面板中展示，例如 `CC 5h 🟩93% · CC 7d 🟩97%`
- **菜单 icon**：紧挨用量条右侧；左键在底部 Panel 打开完整操作列表
- 悬停只提示「点击查看额度详情」；完整详情统一在底部面板，避免同一份内容维护两套排版

> **关于 Claude Code 用量**：扩展会只读读取本机当前 Claude Code 登录，展示其 5h / 7d
> 剩余用量。不保存凭据、不切换账号、不参与自动切号。
> macOS 从系统 Keychain 读取（因此首次可能出现一次钥匙串授权提示，属正常现象）；
> Windows / Linux 走 `~/.claude/.credentials.json`，该路径**尚未在真机验证**，
> 读取失败时会显示「CC 未登录」占位，不影响 Codex 与 Grok。

如果账号名称里带空格、斜杠、连字符之类的分隔符，会优先取前面的简称；如果简称本身还太长，再自动省略一截。

颜色含义大致是：

- `🟩`：额度充足
- `🟨`：额度开始变低
- `🟧`：额度紧张
- `🟥`：额度告急（低于 5%）

详情面板里非当前账号可点「切换到此账号」。


### 4. 账号配置包导出 / 导入

新增了“账号配置包”能力，用来做备份、迁移和多机同步：

- 可导出**全部账号**，也可只导出**某一个账号**
- 导出内容包含账号名称、额度缓存、令牌和原始 `auth.json` 信息
- 导入时会自动按账号身份去重：已有账号更新，不重复新增
- 如果导出包里标记了当前账号，导入完成后会自动同步激活它

> 注意：导出的 JSON 文件里包含敏感令牌，相当于账号钥匙串，请只保存在你自己可控的位置。

### 5. token 失效后的自动恢复

当插件在刷新额度时遇到典型的鉴权失败（比如 `401` / `403`、token expired、unauthorized）时，会自动尝试：

1. 使用账号里保存的 `refresh_token` 向 OpenAI 认证端点刷新令牌
2. 回写本地安全存储中的 access token / id token / refresh token
3. 如果这是当前激活账号，再同步覆盖官方 Codex 扩展正在读取的 `auth.json`
4. 立即重试一次额度请求

如果自动恢复也失败：

- 账号额度状态里会显示失败原因
- 当前账号在切换时会弹出提醒
- 你只需要重新导入一次该账号即可恢复

### 6. 账号健康检查视图

现在可以直接打开“账号健康检查”视图，集中查看每个账号的关键健康信息：

- 是否缺少 `refresh_token`
- 最近是否发生过自动恢复失败，以及连续失败次数
- 最近一次额度刷新结果和报错原因
- 当前账号是不是快见底了，是否低于当前自动切号阈值，以及刷新后会不会按当前策略触发切号

- 当前账号是谁、最近一次额度快照是什么时候拿到的


这个视图会把账号按“健康 / 提醒 / 异常”给出结论，适合快速排查：

- 哪个账号后面会在 token 过期时失去自动恢复能力
- 哪个账号已经连续恢复失败，基本该重新导入了
- 哪个账号长时间没拿到新的额度快照

报告里现在还会直接列出账号级别、5h / 7d 进度条，并给出每个账号的“建议动作”，例如：


- 先重试刷新额度
- 先切换到该账号并同步官方 Codex 扩展
- 直接重新导入该账号
- 打开当前 `auth.json` 路径做手动检查

### 7. 快速修复问题账号

新增了“快速修复问题账号”命令，适合在健康检查之后直接处理：

1. 先选中一个异常 / 提醒账号
2. 然后直接执行下面这些动作之一：
   - 重试刷新这个账号的额度
   - 切换到这个账号并同步 `auth.json`
   - 从当前 `auth.json` 重新导入当前账号
   - 从文件重新导入指定账号
   - 打开当前 `auth.json` 路径
3. 动作执行后，会重新打开健康检查报告，方便你立刻确认修没修好

这个流程的目标很简单：别只告诉你“哪里坏了”，还顺手给你一个能直接修的入口。

### 8. 与官方 Codex 扩展同步切换


切换账号时，插件会把对应账号的令牌写回当前有效的 Codex `auth.json` 路径：


- 默认：`~/.codex/auth.json`
- Windows + `chatgpt.runCodexInWindowsSubsystemForLinux = true` 时：自动解析并写入 WSL 内的 `~/.codex/auth.json`

这意味着官方 `Codex - OpenAI's coding agent` 扩展后续读取到的就是新账号。

为了让它尽量立刻生效，插件现在会在**切换到另一个账号后默认自动重启扩展宿主**，比整窗重载更轻；如果你不想要这一步，可以关闭：

```json
"codexAccountManager.restartExtensionHostAfterSwitch": false
```

另外，**自动切号**和**手动切号**现在是分开处理的：

- 手动切号：会按你的配置决定是否重启扩展宿主，让官方 Codex 扩展尽快切到新账号
- 自动切号：默认会先看 `~/.codex/sessions`（Windows + WSL 会自动解析到对应 WSL 路径）最近有没有会话写入；如果判断 Codex 还在忙，就先不切，等空闲达到设定秒数后、下次刷新再切
- 切回上一个账号：扩展会记住你刚切走的那个账号，适合两个账号来回切；如果上一个账号已经被删除或不存在，会直接提示你改为手动选择

## 命令列表


插件注册了这些命令：

- `Codex 账号：管理账号`
- `Codex 账号：从当前 auth.json 导入账号`
- `Codex 账号：从文件导入账号`
- `Codex 账号：打开当前 auth.json 路径`
- `Codex 账号：导出账号配置包`
- `Codex 账号：导入账号配置包`
- `Codex 账号：账号健康检查`
- `Codex 账号：快速修复问题账号`
- `Codex 账号：切换当前账号`
- `Codex 账号：切回上一个账号`
- `Codex 账号：刷新额度`
- `Codex 账号：重命名账号`


- `Codex 账号：删除账号`

## 配置项

```json
{
  "codexAccountManager.refreshIntervalMinutes": 5,
  "codexAccountManager.restartExtensionHostAfterSwitch": true,
  "codexAccountManager.showEmailInTooltip": true,

  "codexAccountManager.requestTimeoutSeconds": 20,
  "codexAccountManager.autoSwitchThresholdPercent": 5,
  "codexAccountManager.autoSwitchPriority": "lowest-window-first",
  "codexAccountManager.autoSwitchRequiresCodexIdle": true,
  "codexAccountManager.codexIdleThresholdSeconds": 30
}
```

其中：

- `restartExtensionHostAfterSwitch`：切换到另一个账号后默认自动重启扩展宿主，让官方 Codex 扩展立即重新读取新 `auth.json`
- `autoSwitchThresholdPercent`：低于这个百分比时触发自动切号，`0` 表示关闭
- `autoSwitchPriority`：候选账号排序策略，可选
  - `lowest-window-first`：最低窗口优先
  - `primary-first`：5h 优先
  - `secondary-first`：7d 优先
- `autoSwitchRequiresCodexIdle`：自动切号前先检查 Codex 最近是否仍在活动，默认开启
- `codexIdleThresholdSeconds`：把 Codex 判定为空闲前需要连续“无会话写入”的秒数，默认 30 秒




## 本地开发

```bash
npm install
npm run compile
```

然后在 VS Code 中按 `F5` 启动一个 Extension Development Host 进行调试。

## 贡献者 / Contributors

- [@Raozhiven](https://github.com/Raozhiven) — 共同开发

## 建议的后续增强

如果你准备继续往下做，下一步最值得补的是：

1. 增加账号分组 / 排序
2. 增加测试覆盖（尤其是 auth 解析、额度头解析、账号去重逻辑）
3. 支持更细粒度的导出策略（比如不带令牌的只读清单）
4. 给快速修复流程补上更细的定向动作（比如只修当前账号、自动聚焦失败原因最重的账号）

## 许可证

[MIT](LICENSE.txt)

## 免责声明

本项目是独立的社区扩展，与 OpenAI 或 Visual Studio Code 团队无隶属关系。Codex 的认证与额度接口可能随上游变化；使用多账号、导入导出或切换账号前，请自行确认符合适用的服务条款。




