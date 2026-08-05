import * as vscode from "vscode";
import {
  formatAccountLevel,
  formatGrokCompactSegment,
  formatGrokQuotaProgress,
  formatQuotaSummary,
  formatStatusBarQuotaLine,
  getGrokResetAfterSeconds,
  getQuotaAvailablePercent,
} from "./accountPresentation";

import { AccountProfile, ExternalAuthNotice, GrokPeriodSnapshot, QuotaSnapshot, QuotaWindow } from "./types";




function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}


const STATUS_BAR_ACCOUNT_NAME_MAX_LENGTH = 8;
const TOOLTIP_ACCOUNT_INDENT = "&nbsp;&nbsp;";
const TOOLTIP_ACCOUNT_DETAIL_INDENT = "&nbsp;&nbsp;&nbsp;&nbsp;";


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



function getTooltipMarkerColor(account: AccountProfile): string {

  switch (getAccountHealthState(account)) {
    case "error":
      return "#f85149";
    case "warning":
      return "#d29922";
    default:
      return "#3fb950";
  }
}

function formatActiveTooltipMarker(account: AccountProfile): string {
  return `<span style="color:${getTooltipMarkerColor(account)};">⬤</span>`;
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

function formatTooltipEmail(account: AccountProfile, showEmail: boolean, nameOverride?: string): string | undefined {
  if (!showEmail || !account.email) {
    return undefined;
  }

  // 如果 name 本身就是邮箱，避免重复显示
  const displayName = nameOverride ?? account.name;
  if (displayName.includes("@")) {
    return undefined;
  }

  // 用 HTML 实体 &#64; 替代 @，阻止 VS Code Markdown 的 mailto: 自动链接识别。
  // VS Code 渲染时显示为 @，复制时还原为纯文本 @，不插入任何不可见字符。
  return account.email.replace(/@/g, "&#64;");
}

function formatTooltipTitle(account: AccountProfile, showEmail: boolean, nameOverride?: string): string {
  const rawName = nameOverride ?? account.name;

  // 如果 name 本身就是邮箱，需要转义 @ 阻止 mailto 自动链接，同时跳过独立的 email 显示
  const displayName = rawName.includes("@") ? rawName.replace(/@/g, "&#64;") : rawName;

  const titleBits = [
    displayName,
    formatAccountLevel(account.planType),
    getHealthLabel(account),
    formatTooltipEmail(account, showEmail, nameOverride),
  ].filter((value): value is string => Boolean(value));

  return titleBits.join(" · ");
}

function formatResetFromSeconds(totalSeconds: number | undefined): string | undefined {
  if (totalSeconds === undefined) {
    return undefined;
  }
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

function formatGrokTooltipBlock(snapshot: GrokPeriodSnapshot | undefined): string {
  const lines: string[] = [];
  lines.push(`**Grok** · ${formatGrokCompactSegment(snapshot)}  \n`);
  lines.push(`${TOOLTIP_ACCOUNT_DETAIL_INDENT}${formatGrokQuotaProgress(snapshot, 8)}  \n`);

  const details: string[] = [];
  if (snapshot?.window) {
    // 优先 periodEndAt 现算，避免冻结 resetAfterSeconds（审查 #7）
    const reset = formatResetFromSeconds(getGrokResetAfterSeconds(snapshot));
    if (reset) {
      const label = snapshot.periodLabel ? `${snapshot.periodLabel} 重置` : "重置";
      details.push(`${label} ${reset}`);
    }
  }
  const updatedAt = formatTimestamp(snapshot?.fetchedAt);
  if (updatedAt) {
    details.push(`更新 ${updatedAt}`);
  }
  if (snapshot?.error && !snapshot.window) {
    const raw = snapshot.error.trim();
    const summary = raw.length > 40 ? `${raw.slice(0, 37)}…` : raw;
    details.push(summary);
  }
  if (details.length > 0) {
    lines.push(`${TOOLTIP_ACCOUNT_DETAIL_INDENT}${escapeMarkdown(details.join(" · "))}  \n`);
  }
  return lines.join("");
}

function formatTooltipDetailLine(account: AccountProfile): string | undefined {
  const details: string[] = [];
  const primaryReset = formatReset(account.quota?.primary);
  const secondaryReset = formatReset(account.quota?.secondary);
  const updatedAt = formatTimestamp(account.quota?.fetchedAt);

  if (primaryReset) {
    details.push(`5h 重置 ${primaryReset}`);
  }
  if (secondaryReset) {
    details.push(`7d 重置 ${secondaryReset}`);
  }
  if (updatedAt) {
    details.push(`更新 ${updatedAt}`);
  }
  if (account.tokenHealth?.hasRefreshToken === false) {
    details.push("缺少 refresh token");
  }
  if ((account.tokenHealth?.consecutiveRecoveryFailures ?? 0) > 0) {
    details.push(`恢复失败 ${(account.tokenHealth?.consecutiveRecoveryFailures ?? 0)} 次`);
  }
  if (account.quota?.error) {
    const raw = account.quota.error.trim();
    // 截取简明摘要：取第一个句号/换行之前的内容，最多 40 字符
    const summary = raw.length > 40 ? raw.slice(0, 37) + "…" : raw;
    details.push(summary);
  }

  return details.length > 0 ? details.join(" · ") : undefined;
}

function formatTooltipRefreshLine(account: AccountProfile): string | undefined {
  if (!account.quota?.error) {
    return undefined;
  }
  const args = encodeURIComponent(JSON.stringify([account.id]));
  return `[刷新](command:codexAccountManager.refreshSingleAccount?${args} "仅刷新此账号")`;
}

function formatActiveTooltipBlock(account: AccountProfile, showEmail: boolean): string {
  const lines = [`${formatActiveTooltipMarker(account)} ${formatTooltipTitle(account, showEmail)}  \n`];
  const detailLine = formatTooltipDetailLine(account);

  lines.push(`${TOOLTIP_ACCOUNT_DETAIL_INDENT}${formatQuotaSummary(account.quota, 8)}  \n`);

  if (detailLine) {
    const refreshLine = formatTooltipRefreshLine(account);
    const suffix = refreshLine ? ` · ${refreshLine}` : "";
    lines.push(`${TOOLTIP_ACCOUNT_DETAIL_INDENT}${escapeMarkdown(detailLine)}${suffix}  \n`);
  } else {
    const refreshLine = formatTooltipRefreshLine(account);
    if (refreshLine) {
      lines.push(`${TOOLTIP_ACCOUNT_DETAIL_INDENT}${refreshLine}  \n`);
    }
  }

  return lines.join("");
}





function formatReset(window: QuotaWindow | undefined): string | undefined {

  if (!window || window.resetAfterSeconds === undefined) {
    return undefined;
  }

  const totalSeconds = Math.max(0, window.resetAfterSeconds);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

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


function formatTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
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

function getHealthLabel(account: AccountProfile): string {
  switch (getAccountHealthState(account)) {
    case "error":
      return "异常";
    case "warning":
      return "提醒";
    default:
      return "健康";
  }
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



function buildCommandUri(command: string, args: unknown[]): string {

  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

type StatusBarRenderState = {
  accounts: AccountProfile[];
  activeAccountId: string | undefined;
  refreshing: boolean;
  showEmail: boolean;
  notice: ExternalAuthNotice | undefined;
  grokSnapshot: GrokPeriodSnapshot | undefined;
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

  /** 供点击用量条时弹出：与原先悬停详情同款 Markdown */
  buildDetailsMarkdown(): vscode.MarkdownString {
    const { accounts, activeAccountId, showEmail, notice, grokSnapshot } = this.lastRenderState;
    return this.buildDetailsTooltip(accounts, activeAccountId, showEmail, notice, grokSnapshot);
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
  ): void {
    this.lastRenderState = {
      accounts: [...accounts],
      activeAccountId,
      refreshing,
      showEmail,
      notice,
      grokSnapshot,
    };
    this.renderQuotaItem();
    this.renderMenuItem();
  }

  forceTooltipRefresh(): void {
    this.forceStatusBarRefresh();
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
    const { accounts, activeAccountId, refreshing, showEmail, notice, grokSnapshot } = this.lastRenderState;
    const activeAccount = accounts.find((account) => account.id === activeAccountId);
    const invisibleRefreshMarker = this.renderNonce % 2 === 0 ? "\u200B" : "\u200C";
    const noticeText = formatNoticeText(notice);

    this.quotaItem.command = "codexAccountManager.showQuotaDetails";
    // 详情内容放进 tooltip，点击命令再弹出同款 Markdown 气泡（见 showQuotaDetails）
    this.quotaItem.tooltip = this.buildDetailsTooltip(accounts, activeAccountId, showEmail, notice, grokSnapshot);

    if (noticeText) {
      // 通知文案已较长：只保留极简进度，避免整条被挤出
      const line = formatStatusBarQuotaLine(activeAccount?.quota, grokSnapshot, {
        codexUnavailable: !activeAccount,
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
    });
    this.quotaItem.text = `${leadingIcon} ${line}${invisibleRefreshMarker}`;
    this.quotaItem.accessibilityInformation = {
      label: `CC · Codex · Grok 7d：${line}`,
    };
  }

  /**
   * 原先悬停详情样式：额度一览 + 账号列表 + 精简操作菜单。
   */
  private buildDetailsTooltip(
    accounts: AccountProfile[],
    activeAccountId: string | undefined,
    showEmail: boolean,
    notice: ExternalAuthNotice | undefined,
    grokSnapshot?: GrokPeriodSnapshot,
  ): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.supportHtml = true;
    tooltip.isTrusted = {
      enabledCommands: [
        "codexAccountManager.activateAccount",
        "codexAccountManager.manageAccounts",
        "codexAccountManager.importCurrentAuth",
        "codexAccountManager.refreshQuotas",
        "codexAccountManager.refreshQuotasFromTooltip",
        "codexAccountManager.refreshSingleAccount",
        "codexAccountManager.switchAccount",
        "codexAccountManager.switchToLastAccount",
        "codexAccountManager.showAccountHealth",
        "codexAccountManager.openSettings",
        "codexAccountManager.dismissExternalAuthNotice",
        "codexAccountManager.setAccountSortBy",
        "codexAccountManager.toggleAccountSortOrder",
      ],
    };

    // 产品顺序与状态栏 / 底部面板一致：CC → Codex → Grok
    tooltip.appendMarkdown("**额度一览**\n\n");
    tooltip.appendMarkdown(`${TOOLTIP_ACCOUNT_DETAIL_INDENT}CC 5h 暂不可用 · CC 7d 暂不可用  \n`);
    tooltip.appendMarkdown("\n---\n\n");
    tooltip.appendMarkdown("**Codex 账号列表**\n\n");

    if (notice) {
      const noticeTitle = escapeMarkdown(notice.title);
      const noticeDetail = notice.detail ? escapeMarkdown(notice.detail) : undefined;
      tooltip.appendMarkdown(`> $(warning) ${noticeTitle}  \n`);
      if (noticeDetail) {
        tooltip.appendMarkdown(`> ${noticeDetail}  \n`);
      }
      tooltip.appendMarkdown("> [导入当前 auth.json](command:codexAccountManager.importCurrentAuth) · [暂不提醒](command:codexAccountManager.dismissExternalAuthNotice)\n\n");
    }

    if (accounts.length === 0) {
      tooltip.appendMarkdown("还没有导入账号。点右侧菜单可导入。\n\n");
    } else {
      const orderedAccounts = sortAccountsForDisplay(accounts, activeAccountId, this.sortBy, this.sortOrder);
      orderedAccounts.forEach((account, index) => {
        const accountName = escapeMarkdown(account.name);
        const activateUri = buildCommandUri("codexAccountManager.activateAccount", [account.id]);
        const isActive = account.id === activeAccountId;
        const linkedName = `[${accountName}](${activateUri} "切换到 ${accountName}")`;
        const detailLine = formatTooltipDetailLine(account);

        if (isActive) {
          tooltip.appendMarkdown(`${formatActiveTooltipBlock(account, showEmail)}\n`);
        } else {
          const title = formatTooltipTitle(account, showEmail, linkedName);
          tooltip.appendMarkdown(`${TOOLTIP_ACCOUNT_INDENT}• ${title}  \n`);
          tooltip.appendMarkdown(`${TOOLTIP_ACCOUNT_DETAIL_INDENT}${formatQuotaSummary(account.quota, 8)}  \n`);
          if (detailLine) {
            const refreshLine = formatTooltipRefreshLine(account);
            const suffix = refreshLine ? ` · ${refreshLine}` : "";
            tooltip.appendMarkdown(`${TOOLTIP_ACCOUNT_DETAIL_INDENT}${escapeMarkdown(detailLine)}${suffix}  \n`);
          } else {
            const refreshLine = formatTooltipRefreshLine(account);
            if (refreshLine) {
              tooltip.appendMarkdown(`${TOOLTIP_ACCOUNT_DETAIL_INDENT}${refreshLine}  \n`);
            }
          }
        }

        if (index < orderedAccounts.length - 1) {
          tooltip.appendMarkdown("\n---\n\n");
        } else {
          tooltip.appendMarkdown("\n");
        }
      });
    }

    tooltip.appendMarkdown("\n---\n\n");
    tooltip.appendMarkdown(formatGrokTooltipBlock(grokSnapshot));

    // 精简操作菜单（原「快速访问」）
    tooltip.appendMarkdown("---\n\n");
    tooltip.appendMarkdown("**操作**  \n");
    tooltip.appendMarkdown(
      "[打开菜单](command:codexAccountManager.manageAccounts) · " +
      "[刷新额度](command:codexAccountManager.refreshQuotasFromTooltip) · " +
      "[切换账号](command:codexAccountManager.switchAccount) · " +
      "[健康检查](command:codexAccountManager.showAccountHealth) · " +
      "[配置](command:codexAccountManager.openSettings)\n",
    );

    return tooltip;
  }

  dispose(): void {
    this.quotaItem.dispose();
    this.menuItem.dispose();
  }
}
