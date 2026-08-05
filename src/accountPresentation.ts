import { AccountProfile, GrokPeriodSnapshot, QuotaSnapshot, QuotaWindow } from "./types";

export type QuotaTone = "good" | "warning" | "low" | "critical" | "unknown";
export type AutoSwitchPriority = "lowest-window-first" | "primary-first" | "secondary-first";

const DEFAULT_QUOTA_BAR_LENGTH = 10;
const DEFAULT_AUTO_SWITCH_PRIORITY: AutoSwitchPriority = "lowest-window-first";


function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function titleCaseWords(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function formatAccountLevel(planType: string | undefined): string | undefined {
  const raw = planType?.trim();
  if (!raw) {
    return undefined;
  }

  const normalized = raw.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.includes("enterprise")) {
    return "Enterprise";
  }
  if (normalized.includes("business")) {
    return "Business";
  }
  if (normalized.includes("team")) {
    return "Team";
  }
  if (normalized.includes("edu") || normalized.includes("student")) {
    return "Edu";
  }
  if (normalized.includes("pro")) {
    return "Pro";
  }
  if (normalized.includes("plus")) {
    return "Plus";
  }
  if (normalized.includes("free")) {
    return "Free";
  }
  if (normalized.includes("personal")) {
    return "Personal";
  }
  if (normalized.includes("paid")) {
    return "Paid";
  }

  return titleCaseWords(raw);
}

export function getQuotaAvailablePercent(window: QuotaWindow | undefined): number | undefined {
  if (!window || !Number.isFinite(window.availablePercent)) {
    return undefined;
  }

  return clampPercent(window.availablePercent);
}

export function getEffectiveQuotaAvailablePercent(quota: QuotaSnapshot | undefined): number | undefined {
  const values = [
    getQuotaAvailablePercent(quota?.primary),
    getQuotaAvailablePercent(quota?.secondary),
  ].filter((value): value is number => value !== undefined);

  if (values.length === 0) {
    return undefined;
  }

  return Math.min(...values);
}

export function getQuotaTone(window: QuotaWindow | undefined): QuotaTone {
  const availablePercent = getQuotaAvailablePercent(window);
  if (availablePercent === undefined) {
    return "unknown";
  }

  if (availablePercent < 5) {
    return "critical";
  }

  if (availablePercent < 20) {
    return "low";
  }

  if (availablePercent < 50) {
    return "warning";
  }

  return "good";
}

const QUOTA_TONE_COLOR: Record<QuotaTone, string> = {
  good: "#3fb950",
  warning: "#d29922",
  low: "#db6d28",
  critical: "#f85149",
  unknown: "#8b949e",
};

function quotaToneColor(window: QuotaWindow | undefined): string {
  return QUOTA_TONE_COLOR[getQuotaTone(window)];
}

export function getQuotaToneIcon(window: QuotaWindow | undefined): string {
  switch (getQuotaTone(window)) {
    case "good":
      return "🟩";
    case "warning":
      return "🟨";
    case "low":
      return "🟧";
    case "critical":
      return "🟥";
    default:
      return "⬜";
  }
}

function buildQuotaBar(window: QuotaWindow | undefined, barLength: number): string {
  const availablePercent = getQuotaAvailablePercent(window);
  if (availablePercent === undefined) {
    return "░".repeat(barLength);
  }

  const filled = Math.max(0, Math.min(barLength, Math.round((availablePercent / 100) * barLength)));
  const color = quotaToneColor(window);
  const filledPart = filled > 0
    ? `<span style="color:${color};">${"█".repeat(filled)}</span>`
    : "";
  const emptyPart = barLength - filled > 0
    ? `<span style="color:#30363d;">${"░".repeat(barLength - filled)}</span>`
    : "";
  return `${filledPart}${emptyPart}`;
}

export function formatQuotaPercentage(window: QuotaWindow | undefined): string {
  const availablePercent = getQuotaAvailablePercent(window);
  return availablePercent === undefined ? "--" : `${availablePercent.toFixed(1)}%`;
}

export function formatQuotaBadge(label: string, window: QuotaWindow | undefined): string {
  return `${label} ${getQuotaToneIcon(window)} ${formatQuotaPercentage(window)}`;
}

/** 状态栏 Grok 占位：始终带 Grok 标记 */
export function formatGrokPlaceholder(reason?: string): string {
  const detail = reason?.trim();
  if (!detail) {
    return "Grok —";
  }
  // 状态栏保持短；常见未登录单独压缩
  if (/未登录|no login|not logged/i.test(detail)) {
    return "Grok 未登录";
  }
  return "Grok —";
}

/** 状态栏紧凑 Grok 段：`Grok 7d 🟩51%` 或占位 */
export function formatGrokCompactSegment(snapshot: GrokPeriodSnapshot | undefined): string {
  if (!snapshot) {
    return formatGrokPlaceholder("暂无数据");
  }
  if (!snapshot.window || snapshot.error) {
    return formatGrokPlaceholder(snapshot.error);
  }

  const label = snapshot.periodLabel?.trim();
  const percentage = formatQuotaPercentage(snapshot.window).replace(/\.0%$/, "%");
  const icon = getQuotaToneIcon(snapshot.window);
  return label
    ? `Grok ${label} ${icon}${percentage}`
    : `Grok ${icon}${percentage}`;
}

/** 悬停用 Grok 额度行（进度条风格，与 Codex 一致） */
export function formatGrokQuotaProgress(snapshot: GrokPeriodSnapshot | undefined, barLength = DEFAULT_QUOTA_BAR_LENGTH): string {
  if (!snapshot?.window || snapshot.error) {
    return `Grok ${snapshot?.error?.trim() ? "暂不可用" : "暂不可用"}`;
  }
  const label = snapshot.periodLabel ? `Grok ${snapshot.periodLabel}` : "Grok";
  return formatQuotaProgress(label, snapshot.window, barLength);
}

export function formatQuotaProgress(label: string, window: QuotaWindow | undefined, barLength = DEFAULT_QUOTA_BAR_LENGTH): string {
  if (!window) {
    return `${label} 暂不可用`;
  }

  return `${label} ${buildQuotaBar(window, barLength)} ${formatQuotaPercentage(window)}`;
}

export function formatQuotaSummary(quota: QuotaSnapshot | undefined, barLength = DEFAULT_QUOTA_BAR_LENGTH): string {
  return `${formatQuotaProgress("5h", quota?.primary, barLength)} · ${formatQuotaProgress("7d", quota?.secondary, barLength)}`;
}

/** 纯文本版本的额度摘要，不含 HTML 标签，适用于 QuickPick 等不支持 HTML 的场景 */
export function formatQuotaSummaryPlain(quota: QuotaSnapshot | undefined, barLength = DEFAULT_QUOTA_BAR_LENGTH): string {
  return `${formatQuotaProgressPlain("5h", quota?.primary, barLength)} · ${formatQuotaProgressPlain("7d", quota?.secondary, barLength)}`;
}

function buildQuotaBarPlain(window: QuotaWindow | undefined, barLength: number): string {
  const availablePercent = getQuotaAvailablePercent(window);
  if (availablePercent === undefined) {
    return "░".repeat(barLength);
  }

  const filled = Math.max(0, Math.min(barLength, Math.round((availablePercent / 100) * barLength)));
  const filledPart = "█".repeat(filled);
  const emptyPart = "░".repeat(barLength - filled);
  return `${filledPart}${emptyPart}`;
}

function formatQuotaProgressPlain(label: string, window: QuotaWindow | undefined, barLength = DEFAULT_QUOTA_BAR_LENGTH): string {
  if (!window) {
    return `${label} 暂不可用`;
  }

  return `${label} ${buildQuotaBarPlain(window, barLength)} ${formatQuotaPercentage(window)}`;
}

export function normalizeAutoSwitchPriority(value: string | undefined): AutoSwitchPriority {
  switch (value) {
    case "primary-first":
    case "secondary-first":
    case "lowest-window-first":
      return value;
    default:
      return DEFAULT_AUTO_SWITCH_PRIORITY;
  }
}

export function formatAutoSwitchPriority(priority: AutoSwitchPriority): string {
  switch (priority) {
    case "primary-first":
      return "5h 优先";
    case "secondary-first":
      return "7d 优先";
    default:
      return "最低窗口优先";
  }
}

function getQuotaComparatorValues(account: AccountProfile, priority: AutoSwitchPriority): number[] {
  const effective = getEffectiveQuotaAvailablePercent(account.quota) ?? -1;
  const primary = getQuotaAvailablePercent(account.quota?.primary) ?? -1;
  const secondary = getQuotaAvailablePercent(account.quota?.secondary) ?? -1;

  switch (priority) {
    case "primary-first":
      return [primary, secondary, effective];
    case "secondary-first":
      return [secondary, primary, effective];
    default:
      return [effective, primary, secondary];
  }
}

export function compareAccountsByAvailableQuota(
  left: AccountProfile,
  right: AccountProfile,
  priority: AutoSwitchPriority = DEFAULT_AUTO_SWITCH_PRIORITY,
): number {
  const leftValues = getQuotaComparatorValues(left, priority);
  const rightValues = getQuotaComparatorValues(right, priority);

  for (let index = 0; index < leftValues.length; index += 1) {
    if (leftValues[index] !== rightValues[index]) {
      return rightValues[index] - leftValues[index];
    }
  }

  return left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" });
}

