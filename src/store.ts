import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { AccountProfile, AccountsFile, AuthData, AuthTokens, QuotaSnapshot, TokenHealthSnapshot } from "./types";

const ACCOUNTS_FILENAME = "accounts.json";
const ACTIVE_ACCOUNT_KEY = "codexAccountManager.activeAccountId";
const LAST_ACCOUNT_KEY = "codexAccountManager.lastAccountId";
const SECRET_PREFIX = "codexAccountManager.account.";
const ACCOUNTS_READ_RETRY_DELAYS_MS = [40, 120, 240];

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildImportedTokenHealth(current: TokenHealthSnapshot | undefined, authData: AuthData): TokenHealthSnapshot {
  return {
    ...current,
    hasRefreshToken: Boolean(authData.refreshToken),
    consecutiveRecoveryFailures: 0,
    lastRecoveryError: undefined,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type AccountsMutationResult<T> = {
  result: T;
  changed: boolean;
};

export class AccountStore {
  private accountsFileCache: AccountsFile | undefined;
  private accountsMutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get storageDir(): string {
    return this.context.globalStorageUri.fsPath;
  }

  private get accountsPath(): string {
    return path.join(this.storageDir, ACCOUNTS_FILENAME);
  }

  private secretKey(accountId: string): string {
    return `${SECRET_PREFIX}${accountId}`;
  }

  private async ensureStorageDir(): Promise<void> {
    await fs.promises.mkdir(this.storageDir, { recursive: true });
  }

  private createEmptyAccountsFile(): AccountsFile {
    return {
      version: 1,
      accounts: [],
    };
  }

  private cloneAccountsFile(data: AccountsFile): AccountsFile {
    return JSON.parse(JSON.stringify(data)) as AccountsFile;
  }

  private normalizeEmail(email: string | undefined): string {
    return String(email || "").trim().toLowerCase();
  }

  private normalizeIdentity(value: string | undefined): string {
    return String(value || "").trim();
  }

  private compareIdentityField(profileValue: string | undefined, authValue: string | undefined): boolean | undefined {
    const profileIdentity = this.normalizeIdentity(profileValue);
    const authIdentity = this.normalizeIdentity(authValue);

    if (!profileIdentity || !authIdentity) {
      return undefined;
    }

    return profileIdentity === authIdentity;
  }

  private matchesAuth(profile: AccountProfile, authData: AuthData): boolean {
    const hasProfileOrgId = Boolean(this.normalizeIdentity(profile.defaultOrganizationId));
    const hasAuthOrgId = Boolean(this.normalizeIdentity(authData.defaultOrganizationId));
    const organizationIdMatch = this.compareIdentityField(profile.defaultOrganizationId, authData.defaultOrganizationId);

    const identityMatches = [
      this.compareIdentityField(profile.chatgptUserId, authData.chatgptUserId),
      this.compareIdentityField(profile.userId, authData.userId),
      this.compareIdentityField(profile.subject, authData.subject),
    ].filter((value): value is boolean => value !== undefined);

    if (identityMatches.length > 0) {
      if (identityMatches.some((value) => !value)) {
        return false;
      }

      if (hasProfileOrgId || hasAuthOrgId) {
        if (organizationIdMatch === undefined) {
          return false;
        }

        return organizationIdMatch;
      }

      return true;
    }

    const profileEmail = this.normalizeEmail(profile.email);
    const authEmail = this.normalizeEmail(authData.email);
    const hasComparableEmail = Boolean(profileEmail) && Boolean(authEmail) && profileEmail !== "unknown" && authEmail !== "unknown";
    const hasComparableAccountId = Boolean(authData.accountId) && Boolean(profile.accountId);
    const accountIdMatch = hasComparableAccountId ? authData.accountId === profile.accountId : false;
    const hasComparableOrganizationId = organizationIdMatch !== undefined;

    if ((hasProfileOrgId || hasAuthOrgId) && !hasComparableOrganizationId) {
      return false;
    }

    if (hasComparableEmail && hasComparableAccountId && hasComparableOrganizationId) {
      return profileEmail === authEmail && accountIdMatch && organizationIdMatch === true;
    }

    if (hasComparableEmail && hasComparableOrganizationId) {
      return profileEmail === authEmail && organizationIdMatch === true;
    }

    if (hasComparableEmail && hasComparableAccountId) {
      return profileEmail === authEmail && accountIdMatch;
    }

    if (hasComparableAccountId && hasComparableOrganizationId) {
      return accountIdMatch && organizationIdMatch === true;
    }

    if (hasComparableEmail) {
      return profileEmail === authEmail;
    }

    return false;
  }

  private sortAccounts(accounts: AccountProfile[]): AccountProfile[] {
    return [...accounts].sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" }));
  }

  private async readAccountsFile(): Promise<AccountsFile> {
    await this.ensureStorageDir();

    const cached = this.accountsFileCache ? this.cloneAccountsFile(this.accountsFileCache) : undefined;

    for (let attempt = 0; attempt <= ACCOUNTS_READ_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const raw = await fs.promises.readFile(this.accountsPath, "utf8");
        if (!raw.trim()) {
          throw new Error("accounts.json is temporarily empty");
        }

        const parsed = JSON.parse(raw) as Partial<AccountsFile>;
        if (parsed.version === 1 && Array.isArray(parsed.accounts)) {
          const resolved: AccountsFile = {
            version: 1,
            accounts: parsed.accounts,
          };
          this.accountsFileCache = this.cloneAccountsFile(resolved);
          return this.cloneAccountsFile(resolved);
        }
      } catch {
        // retry below; if all retries fail, fall back to cache or empty structure
      }

      if (attempt < ACCOUNTS_READ_RETRY_DELAYS_MS.length) {
        await delay(ACCOUNTS_READ_RETRY_DELAYS_MS[attempt]);
      }
    }

    if (cached) {
      return cached;
    }

    return this.createEmptyAccountsFile();
  }

  private async writeAccountsFile(data: AccountsFile): Promise<void> {
    await this.ensureStorageDir();

    const payload = this.cloneAccountsFile(data);
    const tempPath = path.join(this.storageDir, `${ACCOUNTS_FILENAME}.tmp.${process.pid}.${Date.now()}`);
    await fs.promises.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");

    try {
      await fs.promises.rename(tempPath, this.accountsPath);
    } catch {
      await fs.promises.copyFile(tempPath, this.accountsPath);
    } finally {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // ignore temporary cleanup failures
      }
    }

    this.accountsFileCache = this.cloneAccountsFile(payload);
  }

  private async mutateAccountsFile<T>(
    mutator: (file: AccountsFile) => Promise<AccountsMutationResult<T>> | AccountsMutationResult<T>,
  ): Promise<T> {
    let result: T | undefined;

    const task = this.accountsMutationQueue.then(async () => {
      const currentFile = await this.readAccountsFile();
      const workingCopy = this.cloneAccountsFile(currentFile);
      const mutation = await mutator(workingCopy);

      if (mutation.changed) {
        await this.writeAccountsFile(workingCopy);
      }

      result = mutation.result;
    });

    this.accountsMutationQueue = task.then(
      () => undefined,
      () => undefined,
    );

    await task;
    return result as T;
  }

  async listAccounts(): Promise<AccountProfile[]> {
    const file = await this.readAccountsFile();
    return this.sortAccounts(file.accounts);
  }

  async getAccount(accountId: string): Promise<AccountProfile | undefined> {
    const file = await this.readAccountsFile();
    return file.accounts.find((account) => account.id === accountId);
  }

  async getActiveAccountId(): Promise<string | undefined> {
    return this.context.globalState.get<string>(ACTIVE_ACCOUNT_KEY);
  }

  async setActiveAccountId(accountId: string | undefined): Promise<void> {
    const previous = await this.getActiveAccountId();

    if (previous && accountId && previous !== accountId) {
      await this.context.globalState.update(LAST_ACCOUNT_KEY, previous);
    }

    await this.context.globalState.update(ACTIVE_ACCOUNT_KEY, accountId);
  }

  async getLastAccountId(): Promise<string | undefined> {
    return this.context.globalState.get<string>(LAST_ACCOUNT_KEY);
  }

  async loadTokens(accountId: string): Promise<AuthTokens | null> {
    let raw: string | undefined;

    try {
      raw = await this.context.secrets.get(this.secretKey(accountId));
    } catch {
      return null;
    }

    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as AuthTokens;
    } catch {
      return null;
    }
  }


  private async saveTokens(accountId: string, authData: AuthData): Promise<void> {
    const payload: AuthTokens = {
      idToken: authData.idToken,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
      accountId: authData.accountId,
      authJson: authData.authJson,
    };

    await this.context.secrets.store(this.secretKey(accountId), JSON.stringify(payload));
  }

  async loadAuthData(accountId: string): Promise<AuthData | null> {
    const account = await this.getAccount(accountId);
    if (!account) {
      return null;
    }

    const tokens = await this.loadTokens(accountId);
    if (!tokens) {
      return null;
    }

    return {
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accountId: tokens.accountId || account.accountId,
      authJson: tokens.authJson,
      defaultOrganizationId: account.defaultOrganizationId,
      defaultOrganizationTitle: account.defaultOrganizationTitle,
      chatgptUserId: account.chatgptUserId,
      userId: account.userId,
      subject: account.subject,
      email: account.email,
      planType: account.planType,
    };
  }

  async findDuplicateAccount(authData: AuthData): Promise<AccountProfile | undefined> {
    const file = await this.readAccountsFile();
    return file.accounts.find((account) => this.matchesAuth(account, authData));
  }

  async upsertAccountFromAuth(authData: AuthData, preferredName?: string): Promise<{ account: AccountProfile; created: boolean }> {
    const result = await this.mutateAccountsFile<{ account: AccountProfile; created: boolean }>((file) => {
      const now = new Date().toISOString();
      const resolvedName = preferredName?.trim() || authData.email?.split("@")[0] || `账号-${file.accounts.length + 1}`;
      const duplicateIndex = file.accounts.findIndex((account) => this.matchesAuth(account, authData));

      if (duplicateIndex >= 0) {
        const current = file.accounts[duplicateIndex];
        const updated: AccountProfile = {
          ...current,
          name: resolvedName || current.name,
          email: authData.email || current.email,
          planType: authData.planType || current.planType,
          accountId: authData.accountId || current.accountId,
          defaultOrganizationId: authData.defaultOrganizationId || current.defaultOrganizationId,
          defaultOrganizationTitle: authData.defaultOrganizationTitle || current.defaultOrganizationTitle,
          chatgptUserId: authData.chatgptUserId || current.chatgptUserId,
          userId: authData.userId || current.userId,
          subject: authData.subject || current.subject,
          tokenHealth: buildImportedTokenHealth(current.tokenHealth, authData),
          updatedAt: now,
        };

        file.accounts[duplicateIndex] = updated;
        return {
          changed: true,
          result: { account: updated, created: false },
        };
      }

      const createdAccount: AccountProfile = {
        id: randomUUID(),
        name: resolvedName,
        email: asOptionalString(authData.email),
        planType: asOptionalString(authData.planType),
        accountId: asOptionalString(authData.accountId),
        defaultOrganizationId: asOptionalString(authData.defaultOrganizationId),
        defaultOrganizationTitle: asOptionalString(authData.defaultOrganizationTitle),
        chatgptUserId: asOptionalString(authData.chatgptUserId),
        userId: asOptionalString(authData.userId),
        subject: asOptionalString(authData.subject),
        tokenHealth: buildImportedTokenHealth(undefined, authData),
        createdAt: now,
        updatedAt: now,
      };

      file.accounts.push(createdAccount);
      return {
        changed: true,
        result: { account: createdAccount, created: true },
      };
    });

    await this.saveTokens(result.account.id, authData);
    return result;
  }

  async renameAccount(accountId: string, nextName: string): Promise<boolean> {
    return this.mutateAccountsFile<boolean>((file) => {
      const index = file.accounts.findIndex((account) => account.id === accountId);
      if (index < 0) {
        return {
          changed: false,
          result: false,
        };
      }

      file.accounts[index] = {
        ...file.accounts[index],
        name: nextName.trim(),
        updatedAt: new Date().toISOString(),
      };

      return {
        changed: true,
        result: true,
      };
    });
  }

  async replaceAuthData(accountId: string, authData: AuthData): Promise<boolean> {
    const updated = await this.mutateAccountsFile<boolean>((file) => {
      const index = file.accounts.findIndex((account) => account.id === accountId);
      if (index < 0) {
        return {
          changed: false,
          result: false,
        };
      }

      const current = file.accounts[index];
      file.accounts[index] = {
        ...current,
        email: authData.email || current.email,
        planType: authData.planType || current.planType,
        accountId: authData.accountId || current.accountId,
        defaultOrganizationId: authData.defaultOrganizationId || current.defaultOrganizationId,
        defaultOrganizationTitle: authData.defaultOrganizationTitle || current.defaultOrganizationTitle,
        chatgptUserId: authData.chatgptUserId || current.chatgptUserId,
        userId: authData.userId || current.userId,
        subject: authData.subject || current.subject,
        tokenHealth: {
          ...current.tokenHealth,
          hasRefreshToken: Boolean(authData.refreshToken),
        },
        updatedAt: new Date().toISOString(),
      };

      return {
        changed: true,
        result: true,
      };
    });

    if (!updated) {
      return false;
    }

    await this.saveTokens(accountId, authData);
    return true;
  }

  /**
   * 与 replaceAuthData 相同，但额外写入 planTypeRefreshedAt 时间戳。
   * 用于主动用 refresh_token 换新 token 后更新 planType 的场景。
   */
  async replaceAuthDataWithPlanTypeTimestamp(accountId: string, authData: AuthData, planTypeRefreshedAt: string): Promise<boolean> {
    const updated = await this.mutateAccountsFile<boolean>((file) => {
      const index = file.accounts.findIndex((account) => account.id === accountId);
      if (index < 0) {
        return {
          changed: false,
          result: false,
        };
      }

      const current = file.accounts[index];
      file.accounts[index] = {
        ...current,
        email: authData.email || current.email,
        planType: authData.planType || current.planType,
        planTypeRefreshedAt,
        accountId: authData.accountId || current.accountId,
        defaultOrganizationId: authData.defaultOrganizationId || current.defaultOrganizationId,
        defaultOrganizationTitle: authData.defaultOrganizationTitle || current.defaultOrganizationTitle,
        chatgptUserId: authData.chatgptUserId || current.chatgptUserId,
        userId: authData.userId || current.userId,
        subject: authData.subject || current.subject,
        tokenHealth: {
          ...current.tokenHealth,
          hasRefreshToken: Boolean(authData.refreshToken),
        },
        updatedAt: new Date().toISOString(),
      };

      return {
        changed: true,
        result: true,
      };
    });

    if (!updated) {
      return false;
    }

    await this.saveTokens(accountId, authData);
    return true;
  }

  async recordTokenRecoverySuccess(accountId: string, authData: AuthData): Promise<boolean> {
    return this.mutateAccountsFile<boolean>((file) => {
      const index = file.accounts.findIndex((account) => account.id === accountId);
      if (index < 0) {
        return {
          changed: false,
          result: false,
        };
      }

      const now = new Date().toISOString();
      file.accounts[index] = {
        ...file.accounts[index],
        tokenHealth: {
          ...file.accounts[index].tokenHealth,
          hasRefreshToken: Boolean(authData.refreshToken),
          lastRecoveryAttemptAt: now,
          lastRecoverySucceededAt: now,
          consecutiveRecoveryFailures: 0,
          lastRecoveryError: undefined,
        },
        updatedAt: now,
      };

      return {
        changed: true,
        result: true,
      };
    });
  }

  async recordTokenRecoveryFailure(accountId: string, authData: AuthData, errorMessage: string): Promise<boolean> {
    return this.mutateAccountsFile<boolean>((file) => {
      const index = file.accounts.findIndex((account) => account.id === accountId);
      if (index < 0) {
        return {
          changed: false,
          result: false,
        };
      }

      const now = new Date().toISOString();
      const current = file.accounts[index];
      file.accounts[index] = {
        ...current,
        tokenHealth: {
          ...current.tokenHealth,
          hasRefreshToken: Boolean(authData.refreshToken),
          lastRecoveryAttemptAt: now,
          lastRecoveryFailedAt: now,
          lastRecoveryError: errorMessage,
          consecutiveRecoveryFailures: (current.tokenHealth?.consecutiveRecoveryFailures ?? 0) + 1,
        },
        updatedAt: now,
      };

      return {
        changed: true,
        result: true,
      };
    });
  }

  async updateQuota(accountId: string, quota: QuotaSnapshot): Promise<boolean> {
    return this.mutateAccountsFile<boolean>((file) => {
      const index = file.accounts.findIndex((account) => account.id === accountId);
      if (index < 0) {
        return {
          changed: false,
          result: false,
        };
      }

      file.accounts[index] = {
        ...file.accounts[index],
        quota,
        updatedAt: new Date().toISOString(),
      };

      return {
        changed: true,
        result: true,
      };
    });
  }

  async deleteAccount(accountId: string): Promise<boolean> {
    const [activeAccountId, lastAccountId] = await Promise.all([
      this.getActiveAccountId(),
      this.getLastAccountId(),
    ]);

    const deleted = await this.mutateAccountsFile<boolean>((file) => {
      const originalLength = file.accounts.length;
      file.accounts = file.accounts.filter((account) => account.id !== accountId);

      return {
        changed: file.accounts.length !== originalLength,
        result: file.accounts.length !== originalLength,
      };
    });

    if (!deleted) {
      return false;
    }

    await this.context.secrets.delete(this.secretKey(accountId));

    if (activeAccountId === accountId) {
      await this.setActiveAccountId(undefined);
    }

    if (lastAccountId === accountId) {
      await this.context.globalState.update(LAST_ACCOUNT_KEY, undefined);
    }

    return true;
  }
}
