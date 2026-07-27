# Codex Account Manager 协作指南

## 项目目标

这是一个 VS Code 扩展，用于管理多个本地 Codex 账号。它会导入 Codex
`auth.json`，将账号元数据存入 VS Code 全局状态、将凭据存入 VS Code
Secret Storage，刷新额度，并将所选账号写回 Codex 本地的 `auth.json`。

这是安全敏感项目：凭据、refresh token 与导出的账号配置包都可用于访问用户
账号。凡涉及认证、存储、导入导出或文件写入的改动，都应按高风险改动处理。

## 目录与模块职责

| 位置 | 职责 |
| --- | --- |
| `src/extension.ts` | VS Code 扩展激活入口。 |
| `src/manager.ts` | 核心编排：命令、账号切换、刷新循环、自动切号与用户提示。 |
| `src/store.ts` | 账号元数据写入 `globalState`，凭据写入 `SecretStorage`。 |
| `src/auth.ts` | 多平台 Codex 路径解析、安全解析与原子写入 `auth.json`。 |
| `src/quotaClient.ts` | 额度请求及响应头解析。 |
| `src/tokenRecovery.ts` | refresh token 刷新流程及认证数据标准化。 |
| `src/statusBar.ts` | 状态栏项目与 Markdown 悬停提示渲染。 |
| `src/accountPresentation.ts` | 纯额度计算、排序与展示辅助函数。 |
| `src/accountHealth.ts` | 账号健康度判断与 Markdown 报告生成。 |
| `src/accountBundle.ts` | 版本化账号配置包的序列化与防御性解析。 |
| `src/types.ts` | 各模块共享的领域类型。 |
| `out/` | 编译生成的 JavaScript。禁止手工编辑，使用 `npm run compile` 重新生成。 |

主要依赖方向为 `extension -> manager -> store / auth / quotaClient /
tokenRecovery / statusBar`。展示、健康检查与配置包辅助模块应尽量保持无 VS Code
API 与文件系统副作用。

## 本地开发

```bash
npm install
npm run compile
```

在 VS Code 中按 `F5` 启动 Extension Development Host 调试。项目当前没有自动化
测试命令；修改解析、令牌处理、账号身份匹配、额度计算或自动切号规则时，应补充
针对性的测试。

修改 TypeScript 后必须运行 `npm run compile`。除非发布包需要包含重新生成的产物，
不要提交无关的 `out/` 变更。

## 认证与数据安全规则

- 绝不记录、展示、提交或放入测试夹具：access token、refresh token、ID token、
  完整 `auth.json` 或导出的账号配置包。
- 凭据只能保存在 VS Code `SecretStorage`；`globalState` 只能保存非敏感账号元数据。
- 更新 `auth.json` 时必须保留现有的原子写入方式，不要改成直接写入。
- 账号导出内容本身敏感。修改导入导出时，必须保留校验、明确的用户交互和 README
  中的安全提示。
- 保留 `auth.ts` 中 Windows/WSL 的路径处理逻辑；改动时要同时验证默认路径与 WSL
  路径。
- 额度与令牌刷新接口属于外部、非稳定集成。将接口假设隔离在对应模块，并在响应变化
  时提供可操作的错误提示。

## 改动约定

- 使用严格 TypeScript，优先拆分小而职责单一的辅助函数。
- 保持 `package.json`、`manager.ts` 与 `README.md` 中的 UI 文案和配置键一致。
- 每个用户可调用命令都要在 `package.json` 中声明 command contribution。
- 发布时保持 `package.json` 版本、发布说明/README 与 VSIX 包一致。
- 避免无关的格式化噪声；不要手工编辑 `node_modules/`、`out/` 或 `*.vsix`。

## 升级与开源检查清单

首次公开提交或发布前：

1. 初始化 Git 仓库或将项目接入现有 Git 仓库；当前目录不是 Git worktree。
2. 检查完整发布内容及隐藏文件，禁止将 `.workbuddy/`、`.DS_Store`、`nul`、本地
   VSIX 文件与 `node_modules/` 提交到源码仓库。
3. 将 `UNLICENSED` 替换为明确的开源 SPDX 许可证，并同步更新 `package.json` 与
   `LICENSE.txt`。
4. 清理或重写私有开发历史及任何凭据；扫描将要提交的准确文件集合，而不只是当前
   工作目录。
5. 有计划地升级开发工具。`@vscode/vsce` 和 `@types/vscode` 落后于兼容的当前版本；
   TypeScript 7 属于独立的主版本升级，应单独评估。
6. 运行 `npm audit`，更新开发依赖链，或记录接受仅开发期告警的理由；
   `npm audit --omit=dev` 必须保持无告警。
7. 构建并用 VSCE 打包，检查 VSIX 文件清单；手动验证导入、账号切换、额度刷新、
   令牌恢复失败、导出导入及 Windows/WSL 路径选择。

## 不可想当然的事项

- 不能假定当前已登录账号可以安全覆盖；导入或切换前须对账并提示用户。
- 不能因网络可用就假定额度请求或令牌刷新会成功。
- 自动切号可能中断正在进行的 Codex 会话；必须保留空闲保护与手动切换优先级。
