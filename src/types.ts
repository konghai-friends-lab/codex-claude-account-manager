export interface AuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  authJson?: unknown;
}

export interface AuthData extends AuthTokens {
  defaultOrganizationId?: string;
  defaultOrganizationTitle?: string;
  chatgptUserId?: string;
  userId?: string;
  subject?: string;
  email?: string;
  planType?: string;
}

export interface QuotaWindow {
  usedPercent: number;
  availablePercent: number;
  windowMinutes?: number;
  resetAfterSeconds?: number;
}

export interface QuotaSnapshot {
  primary?: QuotaWindow;
  secondary?: QuotaWindow;
  fetchedAt: string;
  statusCode?: number;
  error?: string;
}

/** 本机当前 Grok 登录的周期剩余快照（与 Codex multi-account quota 分离） */
export interface GrokPeriodSnapshot {
  /** 有真实周期数据时的窗口；不可用时省略 */
  window?: QuotaWindow;
  /** 周期标签，如 7d / 30d；未知时省略 */
  periodLabel?: string;
  /** 产品标识，如 GrokBuild */
  product?: string;
  /**
   * 周期结束绝对时间（ISO）。
   * 展示重置倒计时应以本字段现算，避免冻结 resetAfterSeconds。
   */
  periodEndAt?: string;
  fetchedAt: string;
  statusCode?: number;
  /** 不可用原因（未登录 / 解析失败 / 网络错误等），供占位展示 */
  error?: string;
}

/**
 * 本机当前 Claude Code 登录的 5h / 7d 用量快照。
 * 与 Grok 同属「只读单一本机登录」模型，不存凭据、不切账号。
 */
export interface ClaudeUsageSnapshot {
  /** 5 小时窗口；不可用时省略（不要填 0，占位由展示层输出「暂不可用」） */
  fiveHour?: QuotaWindow;
  /**
   * 5h 窗口重置的绝对时间（ISO）。
   * 展示倒计时必须以本字段现算，避免冻结 resetAfterSeconds。
   */
  fiveHourResetAt?: string;
  /** 7 天窗口；不可用时省略 */
  sevenDay?: QuotaWindow;
  /** 7d 窗口重置的绝对时间（ISO），语义同 fiveHourResetAt */
  sevenDayResetAt?: string;
  fetchedAt: string;
  statusCode?: number;
  /** 不可用原因（未登录 / 鉴权失败 / 解析失败 / 网络错误等），供占位展示 */
  error?: string;
}

export interface TokenHealthSnapshot {
  hasRefreshToken: boolean;
  lastRecoveryAttemptAt?: string;
  lastRecoverySucceededAt?: string;
  lastRecoveryFailedAt?: string;
  lastRecoveryError?: string;
  consecutiveRecoveryFailures?: number;
}

export interface AccountProfile {
  id: string;
  name: string;
  email?: string;
  planType?: string;
  planTypeRefreshedAt?: string;
  accountId?: string;
  defaultOrganizationId?: string;
  defaultOrganizationTitle?: string;
  chatgptUserId?: string;
  userId?: string;
  subject?: string;
  quota?: QuotaSnapshot;
  tokenHealth?: TokenHealthSnapshot;
  createdAt: string;
  updatedAt: string;
}

export type ExternalAuthNotice = {
  kind: "detected-new-auth";
  title: string;
  detail?: string;
};


export interface AccountsFile {

  version: 1;
  accounts: AccountProfile[];
}

export interface ExportedAccountItem {
  name: string;
  isActive?: boolean;
  quota?: QuotaSnapshot;
  auth: AuthData;
}

export interface AccountsExportFile {
  version: 1;
  exportedAt: string;
  accounts: ExportedAccountItem[];
}

