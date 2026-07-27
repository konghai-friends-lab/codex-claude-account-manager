import {
  AutoSwitchPriority,
  formatAccountLevel,
  formatAutoSwitchPriority,
  formatQuotaSummaryPlain as formatQuotaSummary,
  getEffectiveQuotaAvailablePercent,
} from "./accountPresentation";

import { AccountProfile, AuthData } from "./types";


export type AccountHealthSeverity = "healthy" | "warning" | "error";

export interface AccountHealthCheck {
  accountId: string;
  accountName: string;
  isActive: boolean;
  severity: AccountHealthSeverity;
  summary: string;
  email?: string;
  planType?: string;
  quotaSummary: string;
  lastQuotaUpdate?: string;
  tokenSummary: string;
  recoverySummary: string[];
  issues: string[];
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
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

function summarizeRecoveryState(account: AccountProfile): string[] {
  const tokenHealth = account.tokenHealth;
  const details: string[] = [];

  if (tokenHealth?.lastRecoveryAttemptAt) {
    details.push(`最近尝试：${formatTimestamp(tokenHealth.lastRecoveryAttemptAt) || tokenHealth.lastRecoveryAttemptAt}`);
  }

  if (tokenHealth?.lastRecoverySucceededAt) {
    details.push(`最近成功：${formatTimestamp(tokenHealth.lastRecoverySucceededAt) || tokenHealth.lastRecoverySucceededAt}`);
  }

  if (tokenHealth?.lastRecoveryFailedAt) {
    details.push(`最近失败：${formatTimestamp(tokenHealth.lastRecoveryFailedAt) || tokenHealth.lastRecoveryFailedAt}`);
  }

  const failureCount = tokenHealth?.consecutiveRecoveryFailures ?? 0;
  if (failureCount > 0) {
    details.push(`连续失败：${failureCount} 次`);
  }

  if (tokenHealth?.lastRecoveryError) {
    details.push(`最近错误：${tokenHealth.lastRecoveryError}`);
  }

  if (details.length === 0) {
    details.push("还没有自动恢复记录");
  }

  return details;
}

function getMaxSeverity(current: AccountHealthSeverity, next: AccountHealthSeverity): AccountHealthSeverity {
  const score: Record<AccountHealthSeverity, number> = {
    healthy: 0,
    warning: 1,
    error: 2,
  };

  return score[next] > score[current] ? next : current;
}

export function evaluateAccountHealth(
  account: AccountProfile,
  authData: AuthData | null,
  refreshIntervalMinutes: number,
  isActive: boolean,
  autoSwitchThresholdPercent: number,
  autoSwitchPriority: AutoSwitchPriority,
): AccountHealthCheck {

  const issues: string[] = [];
  let severity: AccountHealthSeverity = "healthy";

  if (!authData) {
    issues.push("本地安全存储里的令牌已缺失，需要重新导入账号");
    severity = "error";
  }

  const hasRefreshToken = authData?.refreshToken?.trim().length
    ? true
    : account.tokenHealth?.hasRefreshToken ?? false;

  if (!hasRefreshToken) {
    issues.push("缺少 refresh token，access token 过期后无法自动恢复");
    severity = getMaxSeverity(severity, "warning");
  }

  const consecutiveFailures = account.tokenHealth?.consecutiveRecoveryFailures ?? 0;
  if (consecutiveFailures > 0) {
    issues.push(`最近连续自动恢复失败 ${consecutiveFailures} 次`);
    severity = getMaxSeverity(severity, consecutiveFailures >= 3 ? "error" : "warning");
  }

  if (account.quota?.error) {
    issues.push(`最近额度请求异常：${account.quota.error}`);
    severity = getMaxSeverity(severity, looksAuthRelatedError(account.quota.error) ? "error" : "warning");
  }

  if (!account.quota?.fetchedAt) {
    issues.push("还没有拿到额度快照");
    severity = getMaxSeverity(severity, "warning");
  } else {
    const fetchedAt = new Date(account.quota.fetchedAt);
    if (!Number.isNaN(fetchedAt.getTime())) {
      const staleMinutes = Math.floor((Date.now() - fetchedAt.getTime()) / 60000);
      if (staleMinutes > refreshIntervalMinutes * 3) {
        issues.push(`额度快照已 ${staleMinutes} 分钟未更新`);
        severity = getMaxSeverity(severity, "warning");
      }
    }
  }

  const effectiveAvailable = getEffectiveQuotaAvailablePercent(account.quota);
  if (isActive && autoSwitchThresholdPercent > 0 && effectiveAvailable !== undefined && effectiveAvailable < autoSwitchThresholdPercent) {
    issues.push(
      `当前账号最低可用额度仅剩 ${effectiveAvailable.toFixed(1)}%，低于自动切号阈值 ${autoSwitchThresholdPercent}%，下次刷新后会按${formatAutoSwitchPriority(autoSwitchPriority)}切到更优账号`,

    );
    severity = getMaxSeverity(severity, "warning");
  }


  const summary = issues.length > 0

    ? issues.slice(0, 2).join("；")
    : "最近状态正常，可自动刷新额度";

  return {
    accountId: account.id,
    accountName: account.name,
    isActive,
    severity,
    summary,
    email: account.email,
    planType: account.planType,
    quotaSummary: formatQuotaSummary(account.quota, 8),
    lastQuotaUpdate: formatTimestamp(account.quota?.fetchedAt),

    tokenSummary: hasRefreshToken ? "已保存 refresh token，可自动恢复" : "缺少 refresh token，只能手动重新导入",
    recoverySummary: summarizeRecoveryState(account),
    issues,
  };
}

function severityLabel(severity: AccountHealthSeverity): string {
  switch (severity) {
    case "error":
      return "异常";
    case "warning":
      return "提醒";
    default:
      return "健康";
  }
}

function buildQuickFixSummary(check: AccountHealthCheck): string {
  if (check.issues.some((issue) => issue.includes("最低可用额度仅剩"))) {
    return check.isActive
      ? "当前账号快见底了，下一次刷新会自动切走；如果你想手动控制，也可以现在就切到剩余额度更高的账号"
      : "这个账号额度偏低，继续保留没问题，但更适合当备用号而不是主力号"
  }

  if (check.issues.some((issue) => issue.includes("缺少 refresh token") || issue.includes("自动恢复失败"))) {
    return check.isActive
      ? "优先从当前 auth.json 或文件重新导入当前账号，然后再重试刷新额度"
      : "优先切换到这个账号后重试刷新；如果还是不行，直接从文件重新导入它"
  }


  if (check.issues.some((issue) => issue.includes("额度请求异常") || issue.includes("额度快照"))) {
    return check.isActive
      ? "先重试刷新额度；如果仍然报鉴权错误，再重新导入当前账号"
      : "先切换到这个账号并重试刷新额度，必要时打开 auth.json 做手动检查"
  }

  return check.isActive
    ? "状态基本正常，必要时手动重试刷新额度"
    : "状态基本正常，如需排查可先切换到这个账号再重试刷新"
}

export function renderAccountHealthMarkdown(
  checks: AccountHealthCheck[],
  generatedAt: string,
  refreshIntervalMinutes: number,
  autoSwitchThresholdPercent: number,
  autoSwitchPriority: AutoSwitchPriority,
): string {

  const counts = checks.reduce(
    (result, check) => {
      result[check.severity] += 1;
      return result;
    },
    { healthy: 0, warning: 0, error: 0 },
  );

  const autoSwitchSummary = autoSwitchThresholdPercent > 0
    ? `低于 ${autoSwitchThresholdPercent}% 时触发（${formatAutoSwitchPriority(autoSwitchPriority)}）`
    : "已关闭";

  const lines: string[] = [
    "# Codex 账号健康检查",
    "",
    `- 生成时间：${formatTimestamp(generatedAt) || generatedAt}`,
    `- 自动刷新周期：${refreshIntervalMinutes} 分钟`,
    `- 自动切号策略：${autoSwitchSummary}`,
    `- 账号总数：${checks.length}`,
    `- 健康：${counts.healthy} · 提醒：${counts.warning} · 异常：${counts.error}`,
    "",
  ];


  if (checks.length === 0) {
    lines.push("当前还没有导入任何账号。", "");
    return lines.join("\n");
  }

  for (const check of checks) {
    const titleSuffix = check.isActive ? "（当前账号）" : "";
    lines.push(`## ${escapeMarkdown(check.accountName)}${titleSuffix}`);
    lines.push("");
    lines.push(`- 健康状态：${severityLabel(check.severity)}`);
    lines.push(`- 快速结论：${escapeMarkdown(check.summary)}`);
    lines.push(`- 额度概览：${escapeMarkdown(check.quotaSummary)}`);

    if (check.lastQuotaUpdate) {
      lines.push(`- 最近刷新：${escapeMarkdown(check.lastQuotaUpdate)}`);
    }

    lines.push(`- 令牌状态：${escapeMarkdown(check.tokenSummary)}`);

    if (check.email) {
      lines.push(`- 邮箱：${escapeMarkdown(check.email)}`);
    }

    const levelLabel = formatAccountLevel(check.planType);
    if (levelLabel) {
      lines.push(`- 账号级别：${escapeMarkdown(levelLabel)}`);
    }


    lines.push("- 自动恢复记录：");
    for (const item of check.recoverySummary) {
      lines.push(`  - ${escapeMarkdown(item)}`);
    }

    if (check.issues.length > 0) {
      lines.push("- 当前问题：");
      for (const issue of check.issues) {
        lines.push(`  - ${escapeMarkdown(issue)}`);
      }
    }

    lines.push(`- 建议动作：${escapeMarkdown(buildQuickFixSummary(check))}`);
    lines.push("");
  }

  lines.push(
    "---",
    "",
    "提示：如果某个账号显示缺少 refresh token 或连续恢复失败，最省事的修法通常就是重新导入一次该账号。",
    "也可以直接运行命令 `Codex 账号：快速修复问题账号`，按账号逐个执行切换、重试刷新、重新导入或打开 auth.json。",
    "",
  );
  return lines.join("\n");
}

