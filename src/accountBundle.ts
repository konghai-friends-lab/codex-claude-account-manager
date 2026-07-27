import { AccountsExportFile, AuthData, ExportedAccountItem, QuotaSnapshot, QuotaWindow } from "./types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asRequiredString(value: unknown, fieldName: string): string {
  const resolved = asOptionalString(value);
  if (!resolved) {
    throw new Error(`导入文件缺少有效字段：${fieldName}`);
  }

  return resolved;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeQuotaWindow(value: unknown): QuotaWindow | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const usedPercent = asOptionalNumber(value.usedPercent);
  const availablePercent = asOptionalNumber(value.availablePercent);
  if (usedPercent === undefined || availablePercent === undefined) {
    return undefined;
  }

  return {
    usedPercent,
    availablePercent,
    windowMinutes: asOptionalNumber(value.windowMinutes),
    resetAfterSeconds: asOptionalNumber(value.resetAfterSeconds),
  };
}

function sanitizeQuotaSnapshot(value: unknown): QuotaSnapshot | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const fetchedAt = asRequiredString(value.fetchedAt, "accounts[].quota.fetchedAt");
  return {
    primary: sanitizeQuotaWindow(value.primary),
    secondary: sanitizeQuotaWindow(value.secondary),
    fetchedAt,
    statusCode: asOptionalNumber(value.statusCode),
    error: asOptionalString(value.error),
  };
}

function sanitizeAuthData(value: unknown): AuthData {
  if (!isObject(value)) {
    throw new Error("导入文件中的 auth 数据格式不正确");
  }

  return {
    idToken: asRequiredString(value.idToken, "accounts[].auth.idToken"),
    accessToken: asRequiredString(value.accessToken, "accounts[].auth.accessToken"),
    refreshToken: asOptionalString(value.refreshToken),
    accountId: asOptionalString(value.accountId),
    authJson: value.authJson,
    defaultOrganizationId: asOptionalString(value.defaultOrganizationId),
    defaultOrganizationTitle: asOptionalString(value.defaultOrganizationTitle),
    chatgptUserId: asOptionalString(value.chatgptUserId),
    userId: asOptionalString(value.userId),
    subject: asOptionalString(value.subject),
    email: asOptionalString(value.email),
    planType: asOptionalString(value.planType),
  };
}

function sanitizeExportedAccount(value: unknown): ExportedAccountItem {
  if (!isObject(value)) {
    throw new Error("导入文件中的账号项格式不正确");
  }

  return {
    name: asRequiredString(value.name, "accounts[].name"),
    isActive: value.isActive === true,
    quota: value.quota === undefined ? undefined : sanitizeQuotaSnapshot(value.quota),
    auth: sanitizeAuthData(value.auth),
  };
}

export function createAccountsExportFile(accounts: ExportedAccountItem[]): AccountsExportFile {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts,
  };
}

export function serializeAccountsExportFile(bundle: AccountsExportFile): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function parseAccountsExportFile(content: string): AccountsExportFile {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error("导入文件不是合法的 JSON");
  }

  if (!isObject(parsed)) {
    throw new Error("导入文件格式不正确");
  }

  if (parsed.version !== 1) {
    throw new Error(`暂不支持的导入版本：${String(parsed.version ?? "unknown")}`);
  }

  if (!Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
    throw new Error("导入文件里没有可恢复的账号");
  }

  return {
    version: 1,
    exportedAt: asOptionalString(parsed.exportedAt) ?? new Date().toISOString(),
    accounts: parsed.accounts.map((account) => sanitizeExportedAccount(account)),
  };
}
