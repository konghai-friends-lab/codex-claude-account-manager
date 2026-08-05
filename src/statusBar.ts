import * as vscode from "vscode";
import { formatStatusBarQuotaLine, getQuotaAvailablePercent } from "./accountPresentation";

import { AccountProfile, ClaudeUsageSnapshot, ExternalAuthNotice, GrokPeriodSnapshot } from "./types";




const STATUS_BAR_ACCOUNT_NAME_MAX_LENGTH = 8;


function truncateForStatusBar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= STATUS_BAR_ACCOUNT_NAME_MAX_LENGTH) {
    return trimmed;
  }

  return `${trimmed.slice(0, STATUS_BAR_ACCOUNT_NAME_MAX_LENGTH - 1)}…`;
}

function formatStatusBarAccountName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "账号";
  }

  const compactPart = trimmed
    .split(/[\s/\\|·,_-]+/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);

  return truncateForStatusBar(compactPart || trimmed);
}



type AccountSortBy = "smart" | "min-quota" | "reset-time" | "name";
type AccountSortOrder = "asc" | "desc";

/** 5h 窗口满额与 7d 窗口满额的等效比：7d 满额 ≈ 6 倍 5h 满额 */
const WINDOW_7D_WEIGHT = 6.0;

/** 获取账号等效可用量（5h 和 7d 统一到同一量纲） */
function getEffectiveQuota(account: AccountProfile): number {
  const p = getQuotaAvailablePercent(account.quota?.primary);   // 5h
  const s = getQuotaAvailablePercent(account.quota?.secondary); // 7d
  if (p === undefined && s === undefined) {
    return -1; // 无数据排最后
  }
  const pv = p ?? 0;
  const sv = s ?? 0;
  return (pv * 1.0) + (sv * WINDOW_7D_WEIGHT);
}

/** 获取账号最小可用额度百分比（5h / 7d 中更低的那个，仅用于纯额度排序） */
function getMinQuotaPercent(account: AccountProfile): number {
  const p = getQuotaAvailablePercent(account.quota?.primary);
  const s = getQuotaAvailablePercent(account.quota?.secondary);
  if (p === undefined && s === undefined) {
    return -1;
  }
  if (p === undefined) {
    return s!;
  }
  if (s === undefined) {
    return p;
  }
  return Math.min(p, s);
}

/** 获取账号最近的重置时间秒数（越小越快重置） */
function getMinResetSeconds(account: AccountProfile): number {
  const p = account.quota?.primary?.resetAfterSeconds;
  const s = account.quota?.secondary?.resetAfterSeconds;
  const valid: number[] = [];
  if (p !== undefined && p >= 0) {
    valid.push(p);
  }
  if (s !== undefined && s >= 0) {
    valid.push(s);
  }
  if (valid.length === 0) {
    return Infinity; // 无重置时间排到最后
  }
  return Math.min(...valid);
}

/** 综合评分：等效可用量高且快过期的排前面（越值得优先使用） */
function getSmartScore(account: AccountProfile, maxResetSeconds: number): number {
  const quota = getEffectiveQuota(account);
  const reset = getMinResetSeconds(account);
  if (quota <= 0) {
    return -1; // 无额度排最后
  }
  if (!isFinite(reset) || maxResetSeconds <= 0) {
    return quota; // 无重置数据时退化为纯等效额度排序
  }
  return quota * (reset / maxResetSeconds);
}

function sortAccountsForDisplay(
  accounts: AccountProfile[],
  activeAccountId: string | undefined,
  sortBy: AccountSortBy,
  sortOrder: AccountSortOrder,
): AccountProfile[] {
  const direction = sortOrder === "asc" ? 1 : -1;

  // 预计算所有账号的最大重置时间（用于 smart 排序归一化）
  const maxResetSeconds = Math.max(...accounts.map(a => {
    const r = getMinResetSeconds(a);
    return isFinite(r) ? r : 0;
  }));

  return [...accounts].sort((left, right) => {
    // 激活账号始终置顶
    if (left.id === activeAccountId && right.id !== activeAccountId) {
      return -1;
    }
    if (left.id !== activeAccountId && right.id === activeAccountId) {
      return 1;
    }

    let cmp = 0;
    switch (sortBy) {
      case "smart":
        cmp = getSmartScore(left, maxResetSeconds) - getSmartScore(right, maxResetSeconds);
        break;
      case "min-quota":
        cmp = getMinQuotaPercent(left) - getMinQuotaPercent(right);
        break;
      case "reset-time":
        cmp = getMinResetSeconds(left) - getMinResetSeconds(right);
        break;
      case "name":
        cmp = left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" });
        break;
    }

    return cmp !== 0 ? direction * cmp : 0;
  });
}

function looksAuthRelatedError(error: string | undefined): boolean {
  const normalizedError = String(error || "").toLowerCase();
  return ["401", "403", "unauthorized", "forbidden", "expired", "invalid token", "invalid_token", "refresh token", "重新导入", "自动恢复失败"].some((keyword) => normalizedError.includes(keyword));
}

function getAccountHealthState(account: AccountProfile): "healthy" | "warning" | "error" {
  if (account.tokenHealth?.hasRefreshToken === false) {
    return "warning";
  }

  if ((account.tokenHealth?.consecutiveRecoveryFailures ?? 0) > 0) {

    return (account.tokenHealth?.consecutiveRecoveryFailures ?? 0) >= 3 ? "error" : "warning";
  }

  if (looksAuthRelatedError(account.quota?.error)) {
    return "error";
  }

  if (account.quota?.error) {
    return "warning";
  }

  return "healthy";
}

function getLeadingIcon(account: AccountProfile | undefined, refreshing: boolean): string {
  if (refreshing) {
    return "$(sync~spin)";
  }

  if (!account) {
    return "$(robot)";
  }

  switch (getAccountHealthState(account)) {
    case "error":
      return "$(error)";
    case "warning":
      return "$(warning)";
    default:
      return "$(robot)";
  }
}

function getNoticeIcon(notice: ExternalAuthNotice | undefined): string {
  if (!notice) {
    return "$(robot)";
  }

  return "$(warning)";
}

function formatNoticeText(notice: ExternalAuthNotice | undefined): string | undefined {
  if (!notice) {
    return undefined;
  }

  return "Codex 新账号已登录";
}



type StatusBarRenderState = {
  accounts: AccountProfile[];
  activeAccountId: string | undefined;
  refreshing: boolean;
  showEmail: boolean;
  notice: ExternalAuthNotice | undefined;
  grokSnapshot: GrokPeriodSnapshot | undefined;
  claudeSnapshot: ClaudeUsageSnapshot | undefined;
};


/**
 * 右侧状态栏：用量条 + 紧贴的菜单 icon。
 * - 用量条：左键打开额度详情（底部 Panel）
 * - 菜单：左键打开操作菜单
 *
 * VS Code Right 对齐：数值越大越靠左。用负 priority 把条目压到最右侧，
 * 尽量贴在通知铃铛左边；相邻数值保证用量条与菜单不被其它扩展拆开。
 * 注意：无法 100% 钉死在铃铛旁（内置项/其它扩展 priority 会插队）。
 */
const STATUS_PRIORITY_QUOTA = -999;
const STATUS_PRIORITY_MENU = -1000;

export class StatusBarController implements vscode.Disposable {
  /** 用量摘要：左键打开额度详情气泡 */
  private quotaItem: vscode.StatusBarItem;
  /** 三横杠菜单：紧贴用量条右侧 */
  private menuItem: vscode.StatusBarItem;
  private lastRenderState: StatusBarRenderState = {
    accounts: [],
    activeAccountId: undefined,
    refreshing: false,
    showEmail: true,
    notice: undefined,
    grokSnapshot: undefined,
    claudeSnapshot: undefined,
  };

  private renderNonce = 0;
  private sortBy: AccountSortBy;
  private sortOrder: AccountSortOrder;
  private configChangeListener: vscode.Disposable;

  constructor(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration("codexAccountManager");
    this.sortBy = config.get<AccountSortBy>("accountSortBy", "smart");
    this.sortOrder = config.get<AccountSortOrder>("accountSortOrder", "desc");

    this.quotaItem = this.createQuotaItem();
    this.menuItem = this.createMenuItem();
    this.showLoading();

    this.configChangeListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codexAccountManager.accountSortBy") ||
          e.affectsConfiguration("codexAccountManager.accountSortOrder")) {
        const cfg = vscode.workspace.getConfiguration("codexAccountManager");
        this.sortBy = cfg.get<AccountSortBy>("accountSortBy", "smart");
        this.sortOrder = cfg.get<AccountSortOrder>("accountSortOrder", "desc");
        this.forceStatusBarRefresh();
      }
    });

    context.subscriptions.push(this.configChangeListener);
  }

  getSortBy(): AccountSortBy {
    return this.sortBy;
  }

  getSortOrder(): AccountSortOrder {
    return this.sortOrder;
  }

  getSortByLabel(): string {
    const labels: Record<AccountSortBy, string> = {
      smart: "推荐",
      "min-quota": "额度",
      "reset-time": "重置时间",
      name: "账号",
    };
    return labels[this.sortBy];
  }

  getSortOrderLabel(): string {
    return this.sortOrder === "asc" ? "升序" : "降序";
  }

  getOrderedAccounts(accounts: AccountProfile[], activeAccountId: string | undefined): AccountProfile[] {
    return sortAccountsForDisplay(accounts, activeAccountId, this.sortBy, this.sortOrder);
  }

  async setSortBy(sortBy: string): Promise<void> {
    const validValues: AccountSortBy[] = ["smart", "min-quota", "reset-time", "name"];
    if (!validValues.includes(sortBy as AccountSortBy)) {
      return;
    }
    await vscode.workspace.getConfiguration("codexAccountManager").update("accountSortBy", sortBy, vscode.ConfigurationTarget.Global);
  }

  async toggleSortOrder(): Promise<void> {
    const next = this.sortOrder === "asc" ? "desc" : "asc";
    await vscode.workspace.getConfiguration("codexAccountManager").update("accountSortOrder", next, vscode.ConfigurationTarget.Global);
  }

  update(
    accounts: AccountProfile[],
    activeAccountId: string | undefined,
    refreshing: boolean,
    showEmail: boolean,
    notice: ExternalAuthNotice | undefined,
    grokSnapshot?: GrokPeriodSnapshot,
    claudeSnapshot?: ClaudeUsageSnapshot,
  ): void {
    this.lastRenderState = {
      accounts: [...accounts],
      activeAccountId,
      refreshing,
      showEmail,
      notice,
      grokSnapshot,
      claudeSnapshot,
    };
    this.renderQuotaItem();
    this.renderMenuItem();
  }

  forceStatusBarRefresh(): void {
    this.renderNonce += 1;
    this.quotaItem.dispose();
    this.menuItem.dispose();
    this.quotaItem = this.createQuotaItem();
    this.menuItem = this.createMenuItem();
    this.renderQuotaItem();
    this.renderMenuItem();
  }

  showLoading(message = "Codex 加载中"): void {
    const invisibleRefreshMarker = this.renderNonce % 2 === 0 ? "\u200B" : "\u200C";
    this.quotaItem.text = `$(sync~spin) ${message}${invisibleRefreshMarker}`;
    this.quotaItem.tooltip = "加载中…";
    this.menuItem.text = "$(menu)";
    this.menuItem.tooltip = "账号操作";
  }

  showWarning(message: string, detail?: string): void {
    const invisibleRefreshMarker = this.renderNonce % 2 === 0 ? "\u200B" : "\u200C";
    this.quotaItem.text = `$(warning) ${message}${invisibleRefreshMarker}`;
    this.quotaItem.tooltip = detail ?? message;
    this.menuItem.text = "$(menu)";
    this.menuItem.tooltip = "账号操作";
  }

  private createQuotaItem(): vscode.StatusBarItem {
    let item: vscode.StatusBarItem;
    try {
      item = (vscode.window.createStatusBarItem as unknown as (id: string, alignment?: vscode.StatusBarAlignment, priority?: number) => vscode.StatusBarItem)(
        "codex-account-manager.status",
        vscode.StatusBarAlignment.Right,
        STATUS_PRIORITY_QUOTA,
      );
    } catch {
      item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, STATUS_PRIORITY_QUOTA);
    }
    item.name = "Codex / Grok / CC 额度";
    // 左键打开详情（Markdown 气泡，贴状态栏）
    item.command = "codexAccountManager.showQuotaDetails";
    item.show();
    return item;
  }

  private createMenuItem(): vscode.StatusBarItem {
    let item: vscode.StatusBarItem;
    try {
      item = (vscode.window.createStatusBarItem as unknown as (id: string, alignment?: vscode.StatusBarAlignment, priority?: number) => vscode.StatusBarItem)(
        "codex-account-manager.menu",
        vscode.StatusBarAlignment.Right,
        STATUS_PRIORITY_MENU,
      );
    } catch {
      item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, STATUS_PRIORITY_MENU);
    }
    item.name = "Codex 账号菜单";
    item.text = "$(menu)";
    item.command = "codexAccountManager.manageAccounts";
    item.tooltip = "账号操作";
    item.show();
    return item;
  }

  private renderMenuItem(): void {
    this.menuItem.text = "$(menu)";
    this.menuItem.tooltip = "账号操作";
    this.menuItem.command = "codexAccountManager.manageAccounts";
  }

  private renderQuotaItem(): void {
    const { accounts, activeAccountId, refreshing, showEmail, notice, grokSnapshot, claudeSnapshot } = this.lastRenderState;
    const activeAccount = accounts.find((account) => account.id === activeAccountId);
    const invisibleRefreshMarker = this.renderNonce % 2 === 0 ? "\u200B" : "\u200C";
    const noticeText = formatNoticeText(notice);

    this.quotaItem.command = "codexAccountManager.showQuotaDetails";
    // 详情统一走底部面板（左键）。悬停只留一句提示，不再重复渲染整份详情。
    this.quotaItem.tooltip = "点击查看额度详情";

    if (noticeText) {
      // 通知文案已较长：只保留极简进度，避免整条被挤出
      const line = formatStatusBarQuotaLine(activeAccount?.quota, grokSnapshot, {
        codexUnavailable: !activeAccount,
        claudeSnapshot,
      });
      this.quotaItem.text = `${getNoticeIcon(notice)} ${line}${invisibleRefreshMarker}`;
      this.quotaItem.accessibilityInformation = {
        label: `${noticeText}。CC · Codex · Grok 7d：${line}`,
      };
      return;
    }

    const leadingIcon = getLeadingIcon(activeAccount, refreshing);
    const line = formatStatusBarQuotaLine(activeAccount?.quota, grokSnapshot, {
      codexUnavailable: !activeAccount,
      claudeSnapshot,
    });
    this.quotaItem.text = `${leadingIcon} ${line}${invisibleRefreshMarker}`;
    this.quotaItem.accessibilityInformation = {
      label: `CC · Codex · Grok 7d：${line}`,
    };
  }

  dispose(): void {
    this.quotaItem.dispose();
    this.menuItem.dispose();
  }
}
