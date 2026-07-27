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

