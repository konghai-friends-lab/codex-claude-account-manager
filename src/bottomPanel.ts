import * as vscode from "vscode";
import {
  formatAccountLevel,
  formatClaudeCodeCompactPlaceholder,
  formatGrokCompactSegment,
  formatGrokQuotaProgress,
  formatQuotaSummary,
  getGrokResetAfterSeconds,
} from "./accountPresentation";
import { AccountProfile, ExternalAuthNotice, GrokPeriodSnapshot } from "./types";

export type BottomPanelMode = "details" | "menu";

export interface ManageMenuAction {
  id: string;
  label: string;
  description?: string;
  icon?: string;
}

export interface QuotaDetailsPayload {
  accounts: AccountProfile[];
  activeAccountId: string | undefined;
  showEmail: boolean;
  notice: ExternalAuthNotice | undefined;
  grokSnapshot: GrokPeriodSnapshot | undefined;
  sortByLabel: string;
  sortOrderLabel: string;
}

/**
 * 底部 Panel 区域的 Webview：额度详情 / 操作菜单。
 * 贴底展示，避免状态栏点击后 QuickPick 飞到窗口顶部。
 */
export class BottomPanelController implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "codexAccountManager.panel";

  private view?: vscode.WebviewView;
  private mode: BottomPanelMode = "details";
  private details?: QuotaDetailsPayload;
  private menuActions: ManageMenuAction[] = [];
  /** 额度详情面板是否处于前台可见（用于用量条二次点击关闭） */
  private detailsVisible = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMenuAction: (actionId: string) => void | Promise<void>,
    private readonly onDetailsCommand: (command: string, args?: unknown[]) => void | Promise<void>,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.renderHtml();

    this.disposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (!webviewView.visible) {
          this.detailsVisible = false;
        } else if (this.mode === "details") {
          this.detailsVisible = true;
        }
      }),
      webviewView.webview.onDidReceiveMessage(async (message) => {
        if (!message || typeof message !== "object") {
          return;
        }
        const type = (message as { type?: string }).type;
        if (type === "menuAction") {
          const actionId = (message as { actionId?: string }).actionId;
          if (actionId) {
            await this.onMenuAction(actionId);
          }
          return;
        }
        if (type === "runCommand") {
          const command = (message as { command?: string }).command;
          const args = (message as { args?: unknown[] }).args;
          if (command) {
            await this.onDetailsCommand(command, args);
          }
        }
      }),
    );
  }

  /**
   * 打开额度详情；若详情已在前台可见则关闭面板（用量条二次点击）。
   * @returns true = 已打开，false = 已关闭
   */
  async showDetails(payload: QuotaDetailsPayload): Promise<boolean> {
    if (this.detailsVisible && this.mode === "details" && this.view?.visible) {
      await this.closePanel();
      return false;
    }

    this.mode = "details";
    this.details = payload;
    await this.revealAndRender("Agent 用量");
    this.detailsVisible = true;
    return true;
  }

  async showMenu(actions: ManageMenuAction[]): Promise<void> {
    this.mode = "menu";
    this.menuActions = actions;
    this.detailsVisible = false;
    await this.revealAndRender("Agent 用量");
  }

  private async closePanel(): Promise<void> {
    this.detailsVisible = false;
    try {
      await vscode.commands.executeCommand("workbench.action.closePanel");
    } catch {
      // ignore
    }
  }

  private async revealAndRender(title: string): Promise<void> {
    try {
      await vscode.commands.executeCommand(`${BottomPanelController.viewType}.focus`);
    } catch {
      try {
        await vscode.commands.executeCommand("workbench.view.extension.codexAccountManager");
        await vscode.commands.executeCommand(`${BottomPanelController.viewType}.focus`);
      } catch {
        // 仍尝试刷新已有 view
      }
    }

    if (this.view) {
      this.view.title = title;
      this.view.description = undefined;
      this.view.show?.(true);
      this.view.webview.html = this.renderHtml();
    }
  }

  private renderHtml(): string {
    if (this.mode === "menu") {
      return this.wrapDocument(this.renderMenuBody(), "账号操作");
    }
    return this.wrapDocument(this.renderDetailsBody(), "Agent 用量");
  }

  private wrapDocument(body: string, heading: string): string {
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      padding: 12px 16px 20px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h1 {
      margin: 0 0 12px;
      font-size: 13px;
      font-weight: 600;
      opacity: 0.9;
    }
    .section {
      margin-bottom: 14px;
    }
    .section-title {
      font-size: 12px;
      font-weight: 600;
      margin: 0 0 8px;
      opacity: 0.85;
    }
    .card {
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 8px;
      background: var(--vscode-editorWidget-background, transparent);
    }
    .card.active {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .row {
      margin: 2px 0;
      line-height: 1.45;
      word-break: break-word;
    }
    .muted {
      opacity: 0.75;
      font-size: 12px;
    }
    .notice {
      border-left: 3px solid var(--vscode-inputValidation-warningBorder, #cca700);
      padding: 8px 10px;
      margin-bottom: 10px;
      background: var(--vscode-inputValidation-warningBackground, transparent);
    }
    button.action {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      width: 100%;
      text-align: left;
      margin: 0 0 6px;
      padding: 10px 12px;
      border-radius: 6px;
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      cursor: pointer;
      font: inherit;
    }
    button.action:hover {
      background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.15));
    }
    button.action:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .action-label {
      font-weight: 500;
    }
    .action-desc {
      margin-top: 2px;
      opacity: 0.75;
      font-size: 12px;
    }
    a.cmd {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
    }
    a.cmd:hover {
      text-decoration: underline;
    }
    .empty {
      opacity: 0.7;
      padding: 8px 0;
    }
    .dot {
      color: var(--vscode-charts-green, #3fb950);
      margin-right: 4px;
    }
    .actions-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 0;
    }
    .actions-bar .sep {
      margin: 0 6px;
      opacity: 0.45;
    }
    /* 进度条 HTML 来自 accountPresentation */
    .card .row span {
      font-family: var(--vscode-editor-font-family, monospace);
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(heading)}</h1>
  ${body}
  <script>
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const actionBtn = target.closest('[data-action-id]');
      if (actionBtn) {
        const actionId = actionBtn.getAttribute('data-action-id');
        if (actionId) {
          vscode.postMessage({ type: 'menuAction', actionId });
        }
        return;
      }
      const cmd = target.closest('[data-command]');
      if (cmd) {
        event.preventDefault();
        const command = cmd.getAttribute('data-command');
        let args = [];
        const raw = cmd.getAttribute('data-args');
        if (raw) {
          try { args = JSON.parse(raw); } catch (_) {}
        }
        if (command) {
          vscode.postMessage({ type: 'runCommand', command, args });
        }
      }
    });
  </script>
</body>
</html>`;
  }

  private renderMenuBody(): string {
    if (this.menuActions.length === 0) {
      return `<div class="empty">暂无可用操作</div>`;
    }
    return this.menuActions
      .map((action) => {
        const desc = action.description
          ? `<span class="action-desc">${escapeHtml(action.description)}</span>`
          : "";
        return `<button type="button" class="action" data-action-id="${escapeHtml(action.id)}">
          <span class="action-label">${escapeHtml(action.label)}</span>
          ${desc}
        </button>`;
      })
      .join("\n");
  }

  private renderDetailsBody(): string {
    const data = this.details;
    if (!data) {
      return `<div class="empty">暂无额度数据，请先刷新。</div>`;
    }

    // 布局对齐原先状态栏气泡（额度一览 → 账号列表 → 精简操作）
    const parts: string[] = [];

    if (data.notice) {
      parts.push(`<div class="notice">
        <div class="row"><strong>${escapeHtml(data.notice.title)}</strong></div>
        ${data.notice.detail ? `<div class="row muted">${escapeHtml(data.notice.detail)}</div>` : ""}
        <div class="row muted" style="margin-top:6px;">
          <a class="cmd" data-command="codexAccountManager.importCurrentAuth">导入当前 auth.json</a>
          ·
          <a class="cmd" data-command="codexAccountManager.dismissExternalAuthNotice">暂不提醒</a>
        </div>
      </div>`);
    }

    // 产品顺序与状态栏一致：CC → Codex → Grok
    parts.push(`<div class="section-title">额度一览</div>`);

    parts.push(`<div class="card">
      <div class="row"><strong>CC</strong> · ${escapeHtml(formatClaudeCodeCompactPlaceholder())}</div>
      <div class="row muted">Claude Code 5h / 7d 暂未接入</div>
    </div>`);

    parts.push(`<div class="section-title" style="margin-top:12px;">Codex 账号列表</div>`);

    if (data.accounts.length === 0) {
      parts.push(`<div class="empty">还没有导入账号。点右侧 ☰ 菜单可导入。</div>`);
    } else {
      for (const account of data.accounts) {
        const isActive = account.id === data.activeAccountId;
        const level = formatAccountLevel(account.planType);
        const titleBits = [
          escapeHtml(account.name),
          level ? escapeHtml(level) : undefined,
          isActive ? "当前" : undefined,
          data.showEmail && account.email && !account.name.includes("@")
            ? escapeHtml(account.email.replace(/@/g, "＠"))
            : undefined,
        ].filter(Boolean);
        const quotaHtml = formatQuotaSummary(account.quota, 8);
        const meta = formatCodexDetailMeta(account);
        const nameHtml = isActive
          ? `<span class="dot">⬤</span> ${titleBits.join(" · ")}`
          : `<a class="cmd" data-command="codexAccountManager.activateAccount" data-args='${escapeHtml(JSON.stringify([account.id]))}'>${titleBits.join(" · ")}</a>`;

        parts.push(`<div class="card${isActive ? " active" : ""}">
          <div class="row">${nameHtml}</div>
          <div class="row muted">${quotaHtml}</div>
          ${meta}
        </div>`);
      }
    }

    parts.push(`<div class="section-title" style="margin-top:12px;">Grok</div>`);
    parts.push(`<div class="card">
      <div class="row"><strong>Grok</strong> · ${escapeHtml(formatGrokCompactSegment(data.grokSnapshot))}</div>
      <div class="row muted">${formatGrokQuotaProgress(data.grokSnapshot, 8)}</div>
      ${formatGrokDetailMeta(data.grokSnapshot)}
    </div>`);

    // 精简操作（替代原先冗长的「快速访问」分栏）
    parts.push(`<div class="section-title" style="margin-top:12px;">操作</div>`);
    parts.push(`<div class="card actions-bar">
      <a class="cmd" data-command="codexAccountManager.manageAccounts">打开菜单</a>
      <span class="sep">·</span>
      <a class="cmd" data-command="codexAccountManager.refreshQuotas">刷新额度</a>
      <span class="sep">·</span>
      <a class="cmd" data-command="codexAccountManager.switchAccount">切换账号</a>
      <span class="sep">·</span>
      <a class="cmd" data-command="codexAccountManager.showAccountHealth">健康检查</a>
      <span class="sep">·</span>
      <a class="cmd" data-command="codexAccountManager.openSettings">配置</a>
    </div>`);

    return parts.join("\n");
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ");
}

function formatGrokDetailMeta(snapshot: GrokPeriodSnapshot | undefined): string {
  if (!snapshot) {
    return "";
  }
  const bits: string[] = [];
  const resetSecs = getGrokResetAfterSeconds(snapshot);
  if (resetSecs !== undefined) {
    bits.push(`重置 ${formatDuration(resetSecs)}`);
  }
  if (snapshot.fetchedAt) {
    bits.push(`更新 ${formatClock(snapshot.fetchedAt)}`);
  }
  if (snapshot.error && !snapshot.window) {
    bits.push(snapshot.error);
  }
  return bits.length ? `<div class="row muted">${escapeHtml(bits.join(" · "))}</div>` : "";
}

function formatCodexDetailMeta(account: AccountProfile): string {
  const bits: string[] = [];
  const p = account.quota?.primary?.resetAfterSeconds;
  const s = account.quota?.secondary?.resetAfterSeconds;
  if (p !== undefined) {
    bits.push(`5h 重置 ${formatDuration(p)}`);
  }
  if (s !== undefined) {
    bits.push(`7d 重置 ${formatDuration(s)}`);
  }
  if (account.quota?.fetchedAt) {
    bits.push(`更新 ${formatClock(account.quota.fetchedAt)}`);
  }
  if (account.quota?.error) {
    const raw = account.quota.error.trim();
    bits.push(raw.length > 40 ? `${raw.slice(0, 37)}…` : raw);
  }
  return bits.length ? `<div class="row muted">${escapeHtml(bits.join(" · "))}</div>` : "";
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}天`);
  }
  if (hours > 0) {
    parts.push(`${hours}小时`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}分钟`);
  }
  return parts.join("");
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}
