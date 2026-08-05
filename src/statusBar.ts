import * as vscode from "vscode";
import {
  formatAccountLevel,
  formatGrokCompactSegment,
  formatGrokQuotaProgress,
  formatQuotaPercentage,
  formatQuotaSummary,
  getGrokResetAfterSeconds,
  getQuotaAvailablePercent,
  getQuotaToneIcon,
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

function pickStatusBarQuotaWindow(quota: QuotaSnapshot | undefined): { label: "5h" | "7d" | undefined; window: QuotaWindow | undefined } {
  const primaryPercent = getQuotaAvailablePercent(quota?.primary);
  const secondaryPercent = getQuotaAvailablePercent(quota?.secondary);

  if (primaryPercent === undefined && secondaryPercent === undefined) {
    return { label: undefined, window: undefined };
  }

  if (primaryPercent === undefined) {
    return { label: "7d", window: quota?.secondary };
  }

  if (secondaryPercent === undefined) {
    return { label: "5h", window: quota?.primary };
  }

  return secondaryPercent < primaryPercent
    ? { label: "7d", window: quota?.secondary }
    : { label: "5h", window: quota?.primary };
}

function formatCompactQuota(quota: QuotaSnapshot | undefined): string {
  const { label, window } = pickStatusBarQuotaWindow(quota);
  const percentage = formatQuotaPercentage(window).replace(/\.0%$/, "%");
  return `${label ? `${label} ` : ""}${getQuotaToneIcon(window)}${percentage}`;
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
    return "$(account)";
  }

  switch (getAccountHealthState(account)) {
    case "error":
      return "$(error)";
    case "warning":
      return "$(warning)";
    default:
      return "$(account)";
  }
}

function getNoticeIcon(notice: ExternalAuthNotice | undefined): string {
  if (!notice) {
    return "$(account)";
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


export class StatusBarController implements vscode.Disposable {
  private item: vscode.StatusBarItem;
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

    this.item = this.createItem();
    this.showLoading();

    this.configChangeListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codexAccountManager.accountSortBy") ||
          e.affectsConfiguration("codexAccountManager.accountSortOrder")) {
        const cfg = vscode.workspace.getConfiguration("codexAccountManager");
        this.sortBy = cfg.get<AccountSortBy>("accountSortBy", "smart");
        this.sortOrder = cfg.get<AccountSortOrder>("accountSortOrder", "desc");
        this.forceTooltipRefresh();
      }
    });

    context.subscriptions.push(this.configChangeListener);
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
    this.renderInto(this.item);
  }


  forceTooltipRefresh(): void {
    this.renderNonce += 1;
    this.item.dispose();
    this.item = this.createItem();
    this.renderInto(this.item);
  }

  showLoading(message = "Codex 加载中"): void {
    const invisibleRefreshMarker = this.renderNonce % 2 === 0 ? "\u200B" : "\u200C";
    this.item.text = `$(sync~spin) ${message}${invisibleRefreshMarker}`;
    this.item.tooltip = "Codex Account Manager 正在初始化。";
  }

  showWarning(message: string, detail?: string): void {
    const invisibleRefreshMarker = this.renderNonce % 2 === 0 ? "\u200B" : "\u200C";
    this.item.text = `$(warning) ${message}${invisibleRefreshMarker}`;
    this.item.tooltip = detail ? `${message}\n${detail}` : message;
  }

  private createItem(): vscode.StatusBarItem {
    let item: vscode.StatusBarItem;

    try {
      item = (vscode.window.createStatusBarItem as unknown as (id: string, alignment?: vscode.StatusBarAlignment, priority?: number) => vscode.StatusBarItem)(
        "codex-account-manager.status",
        vscode.StatusBarAlignment.Right,
        100,
      );
    } catch {
      item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    }

    item.command = "codexAccountManager.manageAccounts";
    item.show();
    return item;
  }


  private renderInto(item: vscode.StatusBarItem): void {
    const { accounts, activeAccountId, refreshing, showEmail, notice, grokSnapshot } = this.lastRenderState;
    const activeAccount = accounts.find((account) => account.id === activeAccountId);
    const invisibleRefreshMarker = this.renderNonce % 2 === 0 ? "\u200B" : "\u200C";
    const noticeText = formatNoticeText(notice);
    const grokSegment = formatGrokCompactSegment(grokSnapshot);

    if (noticeText) {
      // 外部 auth 通知时仍保留 Grok peer 段（审查 #1 / KTD5）
      item.text = `${getNoticeIcon(notice)} ${noticeText} · ${grokSegment}${invisibleRefreshMarker}`;
      item.tooltip = this.buildTooltip(accounts, activeAccountId, showEmail, notice, grokSnapshot);
      return;
    }

    const leadingIcon = getLeadingIcon(activeAccount, refreshing);

    if (!activeAccount) {
      // Codex 未登录时仍保留 Grok peer 段（R1/R5）
      item.text = `${leadingIcon} Codex 未登录 · ${grokSegment}${invisibleRefreshMarker}`;
      item.tooltip = this.buildTooltip(accounts, undefined, showEmail, notice, grokSnapshot);
      return;
    }

    item.text = `${leadingIcon} ${formatStatusBarAccountName(activeAccount.name)} · ${formatCompactQuota(activeAccount.quota)} · ${grokSegment}${invisibleRefreshMarker}`;

    item.tooltip = this.buildTooltip(accounts, activeAccountId, showEmail, notice, grokSnapshot);
  }







  private buildTooltip(
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
        "codexAccountManager.importAuthFile",
        "codexAccountManager.openCurrentAuthPath",
        "codexAccountManager.exportAccounts",
        "codexAccountManager.importAccountBundle",
        "codexAccountManager.switchAccount",
        "codexAccountManager.switchToLastAccount",
        "codexAccountManager.refreshQuotas",
        "codexAccountManager.refreshQuotasFromTooltip",
        "codexAccountManager.showAccountHealth",
        "codexAccountManager.quickFixAccountHealth",
        "codexAccountManager.toggleAccountSortOrder",
        "codexAccountManager.setAccountSortBy",
        "codexAccountManager.renameAccount",
        "codexAccountManager.removeAccount",
        "codexAccountManager.loginNewAccount",
        "codexAccountManager.dismissExternalAuthNotice",
        "codexAccountManager.openSettings",
        "codexAccountManager.refreshSingleAccount",
        "chatgpt.openSidebar",
      ],
    };

    tooltip.appendMarkdown("**额度一览**\n\n");
    tooltip.appendMarkdown(formatGrokTooltipBlock(grokSnapshot));
    tooltip.appendMarkdown("\n---\n\n");
    tooltip.appendMarkdown("**Codex 账号列表**\n\n");

    if (notice) {
      const noticeTitle = escapeMarkdown(notice.title);
      const noticeDetail = notice.detail ? escapeMarkdown(notice.detail) : undefined;
      tooltip.appendMarkdown(`> $(warning) ${noticeTitle}  \n`);
      if (noticeDetail) {
        tooltip.appendMarkdown(`> ${noticeDetail}  \n`);
      }

      tooltip.appendMarkdown("> [立即导入当前 auth.json](command:codexAccountManager.importCurrentAuth) · [暂不提醒](command:codexAccountManager.dismissExternalAuthNotice)\n\n");
    }


    if (accounts.length === 0) {
      tooltip.appendMarkdown("还没有导入账号，先从当前 `auth.json` 或文件导入一个。\n\n");
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

    tooltip.appendMarkdown("---\n\n");
    tooltip.appendMarkdown("**快速访问**  \n");
    tooltip.appendMarkdown("账号：");
    tooltip.appendMarkdown("[管理](command:codexAccountManager.manageAccounts) · ");
    tooltip.appendMarkdown("[导入当前](command:codexAccountManager.importCurrentAuth) · ");
    tooltip.appendMarkdown("[登录新账号](command:codexAccountManager.loginNewAccount) · ");
    tooltip.appendMarkdown("[重命名](command:codexAccountManager.renameAccount) · ");
    tooltip.appendMarkdown("[删除](command:codexAccountManager.removeAccount)  \n");
    tooltip.appendMarkdown("额度：");
    tooltip.appendMarkdown("[刷新](command:codexAccountManager.refreshQuotasFromTooltip) · ");
    tooltip.appendMarkdown("[健康检查](command:codexAccountManager.showAccountHealth) · ");
    tooltip.appendMarkdown("[快速修复](command:codexAccountManager.quickFixAccountHealth)  \n");

    // 排序行：放在额度后面
    const sortArgs = encodeURIComponent(JSON.stringify([]));
    const sortByLabels: Record<AccountSortBy, string> = {
      "smart": "推荐",
      "min-quota": "额度",
      "reset-time": "重置时间",
      "name": "账号",
    };
    const sortByKeys: AccountSortBy[] = ["smart", "min-quota", "reset-time", "name"];
    const sortParts = sortByKeys.map((key) => {
      if (key === this.sortBy) {
        return sortByLabels[key];
      }
      return `[${sortByLabels[key]}](command:codexAccountManager.setAccountSortBy?${encodeURIComponent(JSON.stringify([key]))})`;
    });
    tooltip.appendMarkdown(`排序：${sortParts.join(" · ")} · `);
    // 升序/降序：当前方向为纯文本不可点，另一个为可点链接
    const orderAsc = this.sortOrder === "asc";
    tooltip.appendMarkdown(`${orderAsc ? "升序" : `[升序](command:codexAccountManager.toggleAccountSortOrder?${sortArgs})`} · ${!orderAsc ? "降序" : `[降序](command:codexAccountManager.toggleAccountSortOrder?${sortArgs})`}  \n`);

    tooltip.appendMarkdown("配置：");
    tooltip.appendMarkdown("[配置参数](command:codexAccountManager.openSettings) · ");
    tooltip.appendMarkdown("[导出账号包](command:codexAccountManager.exportAccounts) · ");
    tooltip.appendMarkdown("[导入账号包](command:codexAccountManager.importAccountBundle)");
    return tooltip;
  }


  dispose(): void {
    this.item.dispose();
  }
}
