import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { createAccountsExportFile, parseAccountsExportFile, serializeAccountsExportFile } from "./accountBundle";
import {
  AutoSwitchPriority,
  compareAccountsByAvailableQuota,
  formatAccountLevel,
  formatAutoSwitchPriority,
  formatQuotaSummaryPlain as formatQuotaSummary,
  getEffectiveQuotaAvailablePercent,
  normalizeAutoSwitchPriority,
} from "./accountPresentation";

import { AccountHealthCheck, evaluateAccountHealth, renderAccountHealthMarkdown } from "./accountHealth";
import { clearCodexAuthFile, getDefaultCodexAuthPath, getDefaultCodexSessionsPath, loadAuthDataFromFile, syncCodexAuthFile } from "./auth";

import { loadGrokAuthFromFile } from "./grokAuth";
import { GrokQuotaClient } from "./grokQuotaClient";
import { CodexQuotaClient } from "./quotaClient";
import { StatusBarController } from "./statusBar";
import { AccountStore } from "./store";
import { CodexTokenRecoveryClient, shouldAttemptTokenRecovery, isSessionRevokedError, isTokenExpiredAndUnrecoverableError, isUnrecoverableAuthError } from "./tokenRecovery";
import { AccountProfile, AuthData, ExportedAccountItem, ExternalAuthNotice, GrokPeriodSnapshot, QuotaSnapshot } from "./types";






interface ManageActionItem extends vscode.QuickPickItem {
  action:
    | "import-current"
    | "import-file"
    | "open-auth-path"
    | "export-bundle"
    | "import-bundle"
    | "health"
    | "quick-fix"
    | "switch"
    | "switch-last"
    | "login-new"
    | "rename"
    | "remove"
    | "refresh"
    | "settings";
}


interface AccountPickItem extends vscode.QuickPickItem {
  account?: AccountProfile;
}

interface ExportPickItem extends vscode.QuickPickItem {
  accountIds: string[];
}

interface HealthCheckPickItem extends vscode.QuickPickItem {
  account: AccountProfile;
  check: AccountHealthCheck;
}


interface HealthActionItem extends vscode.QuickPickItem {
  action:
    | "refresh-account"
    | "activate-account"
    | "reimport-current"
    | "reimport-file"
    | "open-auth-path"
    | "show-health-report";
}

interface ActivateAccountOptions {
  notify: boolean;
  refreshQuota?: boolean;
  allowReload?: boolean;
  notificationMessage?: string;
  /** 跳过"当前 auth.json 是否已导入"的确认检查（调用方已自行检查时传 true） */
  skipUnimportedCheck?: boolean;
}

interface ImportAuthOptions {
  allowReloadOnActivate?: boolean;
}

const OFFICIAL_CODEX_EXTENSION_ID = "openai.chatgpt";

const PENDING_LOGIN_NEW_ACCOUNT_SIDEBAR_KEY = "pendingLoginNewAccountSidebar";
const MANUAL_SWITCH_OVERRIDE_ACCOUNT_ID_KEY = "manualSwitchOverrideAccountId";



interface AutoSwitchOutcomeBase {
  from: AccountProfile;
  to: AccountProfile;
  fromPercent: number;
  toPercent: number;
  thresholdPercent: number;
  priorityLabel: string;
}

interface AutoSwitchCompletedOutcome extends AutoSwitchOutcomeBase {
  status: "switched";
}

interface AutoSwitchDeferredOutcome extends AutoSwitchOutcomeBase {
  status: "deferred-busy";
  idleThresholdSeconds: number;
  lastActivityAt?: string;
  lastActivityPath?: string;
}

type AutoSwitchOutcome = AutoSwitchCompletedOutcome | AutoSwitchDeferredOutcome;


export class CodexAccountManager implements vscode.Disposable {




  private readonly store: AccountStore;
  private readonly statusBar: StatusBarController;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly disposables: vscode.Disposable[] = [];

  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private externalAuthNotice: ExternalAuthNotice | undefined;
  private lastDetectedExternalAuthFingerprint: string | undefined;
  /** 本机当前 Grok 登录的周期剩余快照（与 Codex 账号 store 分离） */
  private grokSnapshot: GrokPeriodSnapshot | undefined;
  /** 每次手动切号时递增，供 maybeAutoSwitchLowQuotaAccount 检测是否被抢先 */
  private manualSwitchGeneration = 0;
  private readonly authPath = getDefaultCodexAuthPath();


  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = new AccountStore(context);
    this.statusBar = new StatusBarController(context);
    this.outputChannel = vscode.window.createOutputChannel("Codex Account Manager");
    this.disposables.push(this.outputChannel);
  }


  async activate(): Promise<void> {
    this.statusBar.showLoading();
    this.tsLog("activate:start");

    this.registerCommands();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("codexAccountManager")) {
          void this.runGuarded("刷新状态栏", async () => {
            await this.refreshStatusBar();
            this.restartAutoRefresh();
          }, true);
        }

        if (
          event.affectsConfiguration("codexAccountManager.requestTimeoutSeconds") ||
          event.affectsConfiguration("chatgpt.runCodexInWindowsSubsystemForLinux")
        ) {
          void this.runGuarded("恢复当前活动账号", () => this.restoreActiveAccountAuth(), true);
        }
      }),
    );

    await this.runGuarded("恢复当前活动账号", () => this.restoreActiveAccountAuth(), true);
    await this.runGuarded("处理待登录侧边栏", () => this.consumePendingLoginNewAccountSidebar(), true);
    await this.runGuarded("刷新状态栏", () => this.refreshStatusBar(), true);
    await this.runGuarded("刷新账号额度", () => this.refreshAllQuotas(true), true);
    this.restartAutoRefresh();
    this.tsLog("activate:ready");
  }



  private formatErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.stack || error.message;
    }

    return String(error || "未知错误");
  }

  private getConfig<T>(key: string, defaultValue: T): T {
    return vscode.workspace.getConfiguration("codexAccountManager").get<T>(key, defaultValue);
  }

  private tsLog(message: string): void {
    this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private getErrorMessage(error: unknown, fallback = "未知错误"): string {
    return error instanceof Error ? error.message : fallback;
  }

  private async loadAccountContext(): Promise<{ accounts: AccountProfile[]; activeAccountId: string | undefined }> {
    const [accounts, activeAccountId] = await Promise.all([
      this.store.listAccounts(),
      this.store.getActiveAccountId(),
    ]);
    return { accounts, activeAccountId };
  }

  private async loadCurrentAuthAndMatch(): Promise<{ authData: AuthData; matchedAccount: AccountProfile | undefined } | undefined> {
    const authData = await loadAuthDataFromFile(this.authPath);
    if (!authData) return undefined;
    const matchedAccount = await this.store.findDuplicateAccount(authData);
    return { authData, matchedAccount };
  }

  private async requireAccounts(accounts: AccountProfile[], purpose: string): Promise<boolean> {
    if (accounts.length > 0) return true;
    void vscode.window.showWarningMessage(`还没有${purpose}的账号，先导入一个吧。`);
    return false;
  }

  private findActiveAccount(accounts: AccountProfile[], activeAccountId: string | undefined): AccountProfile | undefined {
    return activeAccountId ? accounts.find((a) => a.id === activeAccountId) : undefined;
  }

  private async reloadOrRestartExtensionHost(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
      return true;
    } catch (error) {
      const message = this.getErrorMessage(error);
      void vscode.window.showWarningMessage(
        `自动重启扩展宿主失败：${message}。你也可以手动执行"Developer: Restart Extension Host"。`,
      );
      return false;
    }
  }

  private async runGuarded(step: string, action: () => Promise<void>, statusBarFallback = false): Promise<boolean> {
    this.tsLog(`${step}:start`);

    try {
      await action();
      this.tsLog(`${step}:ok`);
      return true;
    } catch (error) {
      const detail = this.formatErrorMessage(error);
      this.tsLog(`${step}:failed`);
      this.outputChannel.appendLine(detail);
      this.outputChannel.appendLine("");

      if (statusBarFallback) {
        this.statusBar.showWarning("Codex 启动异常", `${step}失败，可在"输出 -> Codex Account Manager"查看详情。`);
      }

      void vscode.window.showWarningMessage(`Codex Account Manager ${step}失败：${this.getErrorMessage(error)}`);
      return false;
    }
  }


  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    this.statusBar.dispose();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }


  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand("codexAccountManager.manageAccounts", () => this.manageAccounts()),
      vscode.commands.registerCommand("codexAccountManager.importCurrentAuth", () => this.importCurrentAuth()),
      vscode.commands.registerCommand("codexAccountManager.importAuthFile", () => this.importAuthFile()),
      vscode.commands.registerCommand("codexAccountManager.openCurrentAuthPath", () => this.openCurrentAuthPath()),
      vscode.commands.registerCommand("codexAccountManager.exportAccounts", () => this.exportAccounts()),
      vscode.commands.registerCommand("codexAccountManager.importAccountBundle", () => this.importAccountBundle()),
      vscode.commands.registerCommand("codexAccountManager.showAccountHealth", () => this.showAccountHealth()),
      vscode.commands.registerCommand("codexAccountManager.quickFixAccountHealth", (accountId?: string) => this.quickFixAccountHealth(accountId)),
      vscode.commands.registerCommand("codexAccountManager.switchAccount", () => this.switchAccount()),
      vscode.commands.registerCommand("codexAccountManager.switchToLastAccount", () => this.switchToLastAccount()),
      vscode.commands.registerCommand("codexAccountManager.refreshQuotas", () => this.refreshAllQuotas(false)),
      vscode.commands.registerCommand("codexAccountManager.refreshQuotasFromTooltip", () => this.refreshQuotasFromTooltip()),
      vscode.commands.registerCommand("codexAccountManager.loginNewAccount", () => this.loginNewAccount()),
      vscode.commands.registerCommand("codexAccountManager.dismissExternalAuthNotice", () => this.dismissExternalAuthNotice()),
      vscode.commands.registerCommand("codexAccountManager.renameAccount", () => this.renameAccount()),
      vscode.commands.registerCommand("codexAccountManager.removeAccount", () => this.removeAccount()),
      vscode.commands.registerCommand("codexAccountManager.activateAccount", (accountId?: string) => this.activateAccountManually(accountId, { notify: true })),
      vscode.commands.registerCommand("codexAccountManager.openSettings", () => this.openSettings()),
      vscode.commands.registerCommand("codexAccountManager.refreshSingleAccount", (accountId?: string) => this.refreshSingleAccount(accountId)),
      vscode.commands.registerCommand("codexAccountManager.toggleAccountSortOrder", async () => {
        await this.statusBar.toggleSortOrder();
      }),
      vscode.commands.registerCommand("codexAccountManager.setAccountSortBy", async (sortBy?: string) => {
        if (sortBy) {
          await this.statusBar.setSortBy(sortBy);
        }
      }),


    );
  }

  private get refreshIntervalMinutes(): number {
    return this.getConfig<number>("refreshIntervalMinutes", 5);
  }

  private get requestTimeoutMs(): number {
    const seconds = Math.max(5, this.getConfig<number>("requestTimeoutSeconds", 20));

    return seconds * 1000;
  }


  private get shouldRestartExtensionHostAfterSwitch(): boolean {
    return this.getConfig<boolean>("restartExtensionHostAfterSwitch", true);
  }

  private get shouldAutoSwitchRequireCodexIdle(): boolean {
    return this.getConfig<boolean>("autoSwitchRequiresCodexIdle", true);
  }

  private get shouldRestartCodexAppAfterSwitch(): boolean {
    return this.getConfig<boolean>("restartCodexAppAfterSwitch", false);
  }

  private get codexIdleThresholdSeconds(): number {
    const configured = this.getConfig<number>("codexIdleThresholdSeconds", 30);

    if (!Number.isFinite(configured)) {
      return 30;
    }

    return Math.max(15, Math.min(600, Math.round(configured)));
  }

  private get showEmailInTooltip(): boolean {
    return this.getConfig<boolean>("showEmailInTooltip", true);
  }


  private get autoSwitchThresholdPercent(): number {
    const configured = this.getConfig<number>("autoSwitchThresholdPercent", 5);

    if (!Number.isFinite(configured)) {
      return 5;
    }

    return Math.max(0, Math.min(100, configured));
  }

  private get autoSwitchPriority(): AutoSwitchPriority {
    const configured = this.getConfig<string>("autoSwitchPriority", "lowest-window-first");

    return normalizeAutoSwitchPriority(configured);
  }

  private get autoSwitchSummary(): string {
    if (this.autoSwitchThresholdPercent <= 0) {
      return "自动切号已关闭";
    }

    const idleGuard = this.shouldAutoSwitchRequireCodexIdle
      ? `，仅 Codex 空闲 ${this.codexIdleThresholdSeconds} 秒后切换`
      : "";

    return `低于 ${this.autoSwitchThresholdPercent}% 时自动切号（${formatAutoSwitchPriority(this.autoSwitchPriority)}${idleGuard}）`;
  }

  private buildAuthFingerprint(authData: AuthData): string {
    return [
      authData.email,
      authData.accountId,
      authData.chatgptUserId,
      authData.userId,
      authData.subject,
      authData.defaultOrganizationId,
    ]
      .map((value) => String(value || "").trim())
      .join("::");
  }

  private buildDetectedAuthNotice(authData: AuthData): ExternalAuthNotice {
    const detail = [authData.email, formatAccountLevel(authData.planType)]
      .filter((value): value is string => Boolean(value))
      .join(" · ");

    return {
      kind: "detected-new-auth",
      title: `Codex 新账号已登录：${this.deriveDefaultName(authData)}`,
      detail: detail || "当前 auth.json 已变成一个插件里还没保存的新账号",
    };
  }

  private clearExternalAuthNotice(): void {


    this.externalAuthNotice = undefined;
    this.lastDetectedExternalAuthFingerprint = undefined;
  }

  private async reconcileCurrentAuthFile(promptImport: boolean): Promise<boolean> {
    const result = await this.loadCurrentAuthAndMatch();
    if (!result) {
      if (this.externalAuthNotice?.kind === "detected-new-auth") {
        this.clearExternalAuthNotice();
      }
      return false;
    }

    const { authData: currentAuthData, matchedAccount } = result;
    if (matchedAccount) {
      await this.store.replaceAuthData(matchedAccount.id, currentAuthData);
      await this.store.setActiveAccountId(matchedAccount.id);
      this.clearExternalAuthNotice();
      return true;
    }

    const fingerprint = this.buildAuthFingerprint(currentAuthData);
    const shouldPrompt = promptImport && this.lastDetectedExternalAuthFingerprint !== fingerprint;
    this.externalAuthNotice = this.buildDetectedAuthNotice(currentAuthData);
    this.lastDetectedExternalAuthFingerprint = fingerprint;
    await this.store.setActiveAccountId(undefined);

    if (shouldPrompt) {
      this.promptImportForDetectedAuth(currentAuthData, fingerprint);
    }

    return true;
  }

  private promptImportForDetectedAuth(authData: AuthData, fingerprint: string): void {
    void (async () => {
      try {
        const action = await vscode.window.showWarningMessage(
          `检测到当前 Codex 已登录未导入的新账号"${this.deriveDefaultName(authData)}"，为避免把它覆盖掉，是否现在立即导入？`,
          "立即导入",
          "稍后提醒",
        );

        if (action !== "立即导入" || this.lastDetectedExternalAuthFingerprint !== fingerprint) {
          return;
        }

        await this.importAuthData(authData, { allowReloadOnActivate: false });

      } catch (error) {
        this.tsLog("检测新账号提示失败");
        this.outputChannel.appendLine(this.formatErrorMessage(error));
        this.outputChannel.appendLine("");
      }
    })();
  }


  private async dismissExternalAuthNotice(): Promise<void> {
    this.externalAuthNotice = undefined;
    await this.refreshStatusBar();
  }

  private restartAutoRefresh(): void {


    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    const interval = this.refreshIntervalMinutes;
    if (interval <= 0) {
      return;
    }

    this.refreshTimer = setInterval(() => {
      void this.refreshAllQuotas(true);
    }, interval * 60 * 1000);
  }

  private async refreshStatusBar(): Promise<void> {
    const { accounts, activeAccountId } = await this.loadAccountContext();
    this.statusBar.update(
      accounts,
      activeAccountId,
      this.refreshing,
      this.showEmailInTooltip,
      this.externalAuthNotice,
      this.grokSnapshot,
    );
  }

  /** 刷新本机 Grok 周期剩余；失败只写占位快照，不抛错、不打断 Codex 流程 */
  private async refreshGrokPeriodRemaining(): Promise<void> {
    const fetchedAt = new Date().toISOString();
    const auth = loadGrokAuthFromFile();
    if (!auth) {
      this.grokSnapshot = {
        fetchedAt,
        error: "未登录",
      };
      return;
    }

    try {
      const client = new GrokQuotaClient(auth, this.requestTimeoutMs);
      this.grokSnapshot = await client.fetchPeriodRemaining();
    } catch (error) {
      this.grokSnapshot = {
        fetchedAt,
        error: error instanceof Error ? error.message : "刷新 Grok 周期额度失败",
      };
    }
  }


  private async refreshQuotasFromTooltip(): Promise<void> {
    await this.refreshAllQuotas(false);
    this.statusBar.forceTooltipRefresh();
  }

  private async refreshSingleAccount(accountId?: string): Promise<void> {
    if (!accountId) {
      return;
    }
    const account = await this.store.getAccount(accountId);
    if (!account) {
      return;
    }
    const ok = await this.refreshQuotaForAccount(accountId, true);
    await this.statusBar.forceTooltipRefresh();
    // 刷新结果通过 tooltip 和状态栏即可体现，不弹通知
  }

  private buildAccountDescription(account: AccountProfile): string {

    const levelLabel = formatAccountLevel(account.planType);
    return [account.email, levelLabel]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }

  private buildAccountQuotaDetail(account: AccountProfile): string {
    const base = formatQuotaSummary(account.quota, 6);
    const parts: string[] = [base];

    // 额度刷新错误提示
    if (account.quota?.error) {
      const err = account.quota.error.toLowerCase();
      const isAuthErr = ["401", "403", "unauthorized", "forbidden", "expired", "invalid token", "invalid_token"].some(
        (kw) => err.includes(kw),
      );
      parts.push(isAuthErr ? "⚠ 令牌失效" : "⚠ 刷新失败");
    }

    // 令牌健康状态提示
    const failures = account.tokenHealth?.consecutiveRecoveryFailures ?? 0;
    if (failures > 0) {
      parts.push(`恢复失败 ${failures} 次`);
    } else if (account.tokenHealth?.hasRefreshToken === false) {
      parts.push("无自动恢复");
    }

    // 多个额外 part 用 " · " 连接，首个 part（base）直接空格分隔
    if (parts.length === 1) {
      return base;
    }
    const [first, ...rest] = parts;
    return `${first}  ·  ${rest.join(" · ")}`;
  }

  private buildAccountPickItems(accounts: AccountProfile[], activeAccountId: string | undefined): AccountPickItem[] {
    return [...accounts]
      .sort((left, right) => {
        if (left.id === activeAccountId && right.id !== activeAccountId) {
          return -1;
        }
        if (left.id !== activeAccountId && right.id === activeAccountId) {
          return 1;
        }
        return 0;
      })
      .map((account) => ({
        label: account.name,
        description: this.buildAccountDescription(account),
        detail: this.buildAccountQuotaDetail(account),
        account,
      }));
  }

  private async showAccountQuickPick(
    items: AccountPickItem[],
    placeHolder: string,
    activeAccountId: string | undefined,
  ): Promise<AccountPickItem | undefined> {
    const quickPick = vscode.window.createQuickPick<AccountPickItem>();
    quickPick.placeholder = placeHolder;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.items = items;

    const activeItem = items.find((item) => item.account?.id === activeAccountId);
    if (activeItem) {
      quickPick.activeItems = [activeItem];
    }

    return await new Promise<AccountPickItem | undefined>((resolve) => {
      let settled = false;
      const finish = (value: AccountPickItem | undefined) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
        quickPick.dispose();
      };

      quickPick.onDidAccept(() => finish(quickPick.selectedItems[0] ?? quickPick.activeItems[0]));

      quickPick.onDidHide(() => finish(undefined));
      quickPick.show();
    });
  }

  private async listChildDirectoriesSortedDescending(directoryPath: string): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
    } catch {
      return [];
    }
  }

  private async getLatestCodexSessionActivity(): Promise<{ lastActivityAt: string; lastActivityPath: string } | undefined> {
    const sessionsPath = getDefaultCodexSessionsPath();
    const years = await this.listChildDirectoriesSortedDescending(sessionsPath);

    for (const year of years) {
      const yearPath = path.join(sessionsPath, year);
      const months = await this.listChildDirectoriesSortedDescending(yearPath);

      for (const month of months) {
        const monthPath = path.join(yearPath, month);
        const days = await this.listChildDirectoriesSortedDescending(monthPath);

        for (const day of days) {
          const dayPath = path.join(monthPath, day);

          try {
            const entries = await fs.promises.readdir(dayPath, { withFileTypes: true });
            let latestMatch: { lastActivityAt: string; lastActivityPath: string; mtimeMs: number } | undefined;

            for (const entry of entries) {
              if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
                continue;
              }

              const candidatePath = path.join(dayPath, entry.name);
              const stats = await fs.promises.stat(candidatePath);
              if (!stats.isFile()) {
                continue;
              }

              if (!latestMatch || stats.mtimeMs > latestMatch.mtimeMs) {
                latestMatch = {
                  lastActivityAt: new Date(stats.mtimeMs).toISOString(),
                  lastActivityPath: candidatePath,
                  mtimeMs: stats.mtimeMs,
                };
              }
            }

            if (latestMatch) {
              return latestMatch;
            }
          } catch {
            // ignore session scan failures and fall back to trying older directories
          }
        }
      }
    }

    return undefined;
  }

  private async canAutoSwitchNow(): Promise<{ canSwitch: boolean; lastActivityAt?: string; lastActivityPath?: string }> {
    if (!this.shouldAutoSwitchRequireCodexIdle || !this.hasOfficialCodexExtensionInstalled()) {
      return { canSwitch: true };
    }

    const latestActivity = await this.getLatestCodexSessionActivity();
    if (!latestActivity) {
      return { canSwitch: true };
    }

    const idleForMs = Date.now() - new Date(latestActivity.lastActivityAt).getTime();
    return {
      canSwitch: idleForMs >= this.codexIdleThresholdSeconds * 1000,
      lastActivityAt: latestActivity.lastActivityAt,
      lastActivityPath: latestActivity.lastActivityPath,
    };
  }

  private formatElapsedMinutes(isoTimestamp: string | undefined): string | undefined {
    if (!isoTimestamp) {
      return undefined;
    }

    const elapsedMs = Date.now() - new Date(isoTimestamp).getTime();
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
      return undefined;
    }

    if (elapsedMs < 60_000) {
      return "刚刚";
    }

    const minutes = Math.round(elapsedMs / 60_000);
    if (minutes < 60) {
      return `${minutes} 分钟前`;
    }

    const hours = Math.round(minutes / 60);
    return `${hours} 小时前`;
  }

  /**
   * 刷新额度完成后，顺带把当前激活账号的 planType 与最新 token 对齐。
   *
   * planType 存在于 id_token 的 JWT payload 里；升套餐后必须用 refresh_token 换一次
   * 新的 id_token，才能拿到更新后的 planType（比如 free → plus）。
   *
   * 策略：
   * 1. 先对比 auth.json 里的 planType 与 store 里的，若已经不同就直接写入（快路径）。
   * 2. 若 auth.json 里的 planType 与 store 里相同，但当前账号有 refresh_token，且
   *    距上次主动刷新超过 1 小时，则用 refresh_token 换一次新 token，从新 id_token
   *    里解析 planType，若有变化则写入 store、安全存储和 auth.json。
   * 3. 整个过程不弹任何 UI 提示，失败只记日志，不影响主流程。
   */
  private async maybeSyncActivePlanType(): Promise<void> {
    const PLAN_TYPE_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 小时节流
    try {
      const activeAccountId = await this.store.getActiveAccountId();
      if (!activeAccountId) {
        return;
      }

      const loadResult = await this.loadCurrentAuthAndMatch();
      if (!loadResult) return;

      const { authData: currentAuthData, matchedAccount } = loadResult;
      if (!matchedAccount || matchedAccount.id !== activeAccountId) {
        // auth.json 对应的不是当前激活账号，跳过，避免误覆盖
        return;
      }

      // 快路径：auth.json 里的 planType 与 store 里的不同，直接写入
      if (currentAuthData.planType && matchedAccount.planType !== currentAuthData.planType) {
        this.tsLog(`planType sync (fast): ${matchedAccount.planType ?? "(none)"} → ${currentAuthData.planType} for accountId=${activeAccountId}`);
        await this.store.replaceAuthData(matchedAccount.id, currentAuthData);
        await this.refreshStatusBar();
        return;
      }

      // 慢路径：auth.json 里的 planType 和 store 一致，但可能是旧 token 未更新
      // 用 refresh_token 主动换新 token，节流 1 小时一次
      if (!currentAuthData.refreshToken) {
        return;
      }

      const lastRefreshedAt = matchedAccount.planTypeRefreshedAt;
      const nowMs = Date.now();
      if (lastRefreshedAt) {
        const elapsed = nowMs - new Date(lastRefreshedAt).getTime();
        if (elapsed < PLAN_TYPE_REFRESH_INTERVAL_MS) {
          return;
        }
      }

      this.tsLog(`planType refresh: using refresh_token to fetch latest id_token for accountId=${activeAccountId}`);

      const recoveryClient = new CodexTokenRecoveryClient(currentAuthData, this.requestTimeoutMs);
      const refreshedAuthData = await recoveryClient.refreshAuthData();

      const refreshedAt = new Date().toISOString();

      // 无论 planType 是否变化，都更新 token 和 planTypeRefreshedAt 时间戳
      if (refreshedAuthData.planType && refreshedAuthData.planType !== matchedAccount.planType) {
        this.tsLog(`planType sync (refresh): ${matchedAccount.planType ?? "(none)"} → ${refreshedAuthData.planType} for accountId=${activeAccountId}`);
      }

      await this.store.replaceAuthDataWithPlanTypeTimestamp(matchedAccount.id, refreshedAuthData, refreshedAt);

      // 如果当前激活账号的 auth.json 就是这个账号，同步写回磁盘
      await syncCodexAuthFile(this.authPath, refreshedAuthData);

      await this.refreshStatusBar();

    } catch (error) {
      // planType 同步是可选优化，失败时只记录日志，不影响主流程
      this.tsLog(`maybeSyncActivePlanType failed: ${this.getErrorMessage(error, String(error))}`);
    }
  }

  private async maybeAutoSwitchLowQuotaAccount(): Promise<AutoSwitchOutcome | undefined> {
    // 记录进入时的手动切换序列号；若用户在等待期间手动切号，序列号会变化，直接放弃本轮
    const generationAtStart = this.manualSwitchGeneration;

    const thresholdPercent = this.autoSwitchThresholdPercent;
    if (thresholdPercent <= 0) {
      return undefined;
    }

    const priority = this.autoSwitchPriority;
    const { accounts, activeAccountId } = await this.loadAccountContext();
    const manualOverrideAccountId = this.context.globalState.get<string | undefined>(MANUAL_SWITCH_OVERRIDE_ACCOUNT_ID_KEY);
    const activeAccount = this.findActiveAccount(accounts, activeAccountId);

    if (!activeAccount || activeAccount.quota?.error) {
      return undefined;
    }

    // 当前活跃账号就是用户刚手动指定的账号时，autoSwitch 不应立即把它抢走；
    // 这个标记保存在 globalState 里，哪怕 Extension Host 为了同步 Codex 扩展而重启，
    // 重新激活后的首轮 refreshAllQuotas 也仍然会尊重用户这次手选。
    if (manualOverrideAccountId && manualOverrideAccountId === activeAccount.id) {
      // 手动切号的持久化覆盖标记只负责挡住"重启后首轮自动切换"；
      // 一旦成功保护过这一次，就立刻消费掉，后续定时刷新仍可正常自动切换。
      await this.context.globalState.update(MANUAL_SWITCH_OVERRIDE_ACCOUNT_ID_KEY, undefined);
      this.tsLog(`autoSwitch:skip-once-manual-override accountId=${activeAccount.id}`);
      return undefined;
    }



    const activePercent = getEffectiveQuotaAvailablePercent(activeAccount.quota);
    if (activePercent === undefined || activePercent >= thresholdPercent) {
      return undefined;
    }

    const candidate = accounts
      .filter((account) => account.id !== activeAccount.id && !account.quota?.error && getEffectiveQuotaAvailablePercent(account.quota) !== undefined)
      .sort((left, right) => compareAccountsByAvailableQuota(left, right, priority))[0];

    if (!candidate) {
      return undefined;
    }

    const candidatePercent = getEffectiveQuotaAvailablePercent(candidate.quota);
    if (candidatePercent === undefined || compareAccountsByAvailableQuota(candidate, activeAccount, priority) >= 0) {
      return undefined;
    }

    const autoSwitchGuard = await this.canAutoSwitchNow();
    if (!autoSwitchGuard.canSwitch) {
      return {
        status: "deferred-busy",
        from: activeAccount,
        to: candidate,
        fromPercent: activePercent,
        toPercent: candidatePercent,
        thresholdPercent,
        priorityLabel: formatAutoSwitchPriority(priority),
        idleThresholdSeconds: this.codexIdleThresholdSeconds,
        lastActivityAt: autoSwitchGuard.lastActivityAt,
        lastActivityPath: autoSwitchGuard.lastActivityPath,
      };
    }

    // 最终执行前再检查一次序列号，避免手动切号已经发生时我们再覆盖回去
    if (this.manualSwitchGeneration !== generationAtStart) {
      return undefined;
    }

    // 自动切换前检查当前 auth.json 是否有未导入的账号：
    // 未导入账号不在候选池里，不能简单用"已导入最优"替换，静默跳过本轮自动切换
    const currentAuthCheck = await this.loadCurrentAuthAndMatch();
    if (currentAuthCheck && !currentAuthCheck.matchedAccount) {
      this.tsLog("自动切换跳过：当前 auth.json 为未导入账号");
      return undefined;
    }

    await this.activateAccountById(candidate.id, {
      notify: false,
      refreshQuota: false,
      allowReload: true,
    });

    return {
      status: "switched",
      from: activeAccount,
      to: candidate,
      fromPercent: activePercent,
      toPercent: candidatePercent,
      thresholdPercent,
      priorityLabel: formatAutoSwitchPriority(priority),
    };
  }



  private async restoreActiveAccountAuth(): Promise<void> {
    try {
      if (await this.reconcileCurrentAuthFile(true)) return;

      const activeAccountId = await this.store.getActiveAccountId();
      if (!activeAccountId) return;

      // 先确认账号元数据还在；若账号已被彻底删除才清 activeAccountId
      const account = await this.store.getAccount(activeAccountId);
      if (!account) {
        await this.store.setActiveAccountId(undefined);
        return;
      }

      const authData = await this.store.loadAuthData(activeAccountId);
      if (!authData) {
        // 令牌读取失败（Keychain 授权超时 / Extension Host 刚重启 / macOS 锁屏）
        // 不清 activeAccountId，让健康检查界面显示 error 状态，用户手动修复
        return;
      }

      await syncCodexAuthFile(this.authPath, authData);
    } finally {
      await this.refreshStatusBar();
    }
  }

  private async consumePendingLoginNewAccountSidebar(): Promise<void> {
    const pending = this.context.globalState.get<boolean>(PENDING_LOGIN_NEW_ACCOUNT_SIDEBAR_KEY, false);
    if (!pending) {
      return;
    }

    await this.context.globalState.update(PENDING_LOGIN_NEW_ACCOUNT_SIDEBAR_KEY, undefined);
    this.clearExternalAuthNotice();

    // 激活后若已有新账号登录，静默导入
    const authData = await loadAuthDataFromFile(this.authPath);
    if (authData) {
      await this.importAuthData(authData, { allowReloadOnActivate: false });
      return;
    }

    await this.refreshStatusBar();

    if (!this.hasOfficialCodexExtensionInstalled()) {
      return;
    }

    try {
      await vscode.commands.executeCommand("chatgpt.openSidebar");
    } catch {
      // ignore
    }
  }


  private hasOfficialCodexExtensionInstalled(): boolean {

    return Boolean(vscode.extensions.getExtension(OFFICIAL_CODEX_EXTENSION_ID));
  }

  private async applyCodexExtensionSyncAfterSwitch(notify: boolean, accountName: string): Promise<boolean> {
    if (!this.shouldRestartExtensionHostAfterSwitch || !this.hasOfficialCodexExtensionInstalled()) {
      return false;
    }

    return this.reloadOrRestartExtensionHost();
  }

  private async restartCodexExtensionForNewLogin(): Promise<boolean> {
    if (!this.hasOfficialCodexExtensionInstalled()) {
      return false;
    }

    await this.context.globalState.update(PENDING_LOGIN_NEW_ACCOUNT_SIDEBAR_KEY, true);
    const ok = await this.reloadOrRestartExtensionHost();
    if (!ok) {
      await this.context.globalState.update(PENDING_LOGIN_NEW_ACCOUNT_SIDEBAR_KEY, undefined);
      void vscode.window.showWarningMessage(
        "已退出当前账号，但自动重启扩展宿主失败。你也可以手动执行\"Developer: Restart Extension Host\"。",
      );
    }
    return ok;
  }

  /** 切号后重启 Codex 桌面应用（Windows MSIX 安装版） */
  private async restartCodexDesktopApp(): Promise<void> {
    const isWin = process.platform === "win32";
    const isMac = process.platform === "darwin";

    try {
      // 先检测 Codex 进程是否在运行，没有则直接返回
      const checkCmd = isWin
        ? 'tasklist /FI "IMAGENAME eq Codex.exe" /NH 2>nul | findstr /I "Codex.exe"'
        : isMac
          ? "pgrep -f 'Codex\\.app' >/dev/null 2>&1 && echo FOUND || echo NOT_FOUND"
          : "pgrep -f codex-app >/dev/null 2>&1 && echo FOUND || echo NOT_FOUND";
      const checkResult = cp.execSync(checkCmd, { timeout: 5000, encoding: "utf-8" }).trim();
      if (isWin ? !checkResult.includes("Codex.exe") : !checkResult.includes("FOUND")) {
        this.tsLog("Codex 桌面应用未运行，跳过重启");
        return;
      }

      // 先关闭正在运行的 Codex App
      const killCmd = isWin
        ? "taskkill /F /IM Codex.exe /T 2>nul"
        : isMac
          ? "pkill -f 'Codex\\.app' 2>/dev/null"
          : "pkill -f codex-app 2>/dev/null";
      cp.execSync(killCmd, { timeout: 5000 });

      // 等待进程退出
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // 重新启动 Codex App
      let launchCmd: string;
      if (isWin) {
        launchCmd = `powershell -Command "Start-Process 'shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'"`;
      } else if (isMac) {
        launchCmd = "open -a 'Codex'";
      } else {
        launchCmd = "codex-app";
      }
      cp.execSync(launchCmd, { timeout: 10000 });

      this.tsLog("Codex 桌面应用已重启");
    } catch (error) {
      this.tsLog(`Codex 桌面应用重启失败: ${this.getErrorMessage(error)}`);
      void vscode.window.showWarningMessage(
        "自动重启 Codex 桌面应用失败，请手动重启 Codex 应用使其加载新账号。",
      );
    }
  }

  private async manageAccounts(): Promise<void> {


    const { accounts, activeAccountId } = await this.loadAccountContext();
    const lastAccountId = await this.store.getLastAccountId();
    const activeAccount = this.findActiveAccount(accounts, activeAccountId);
    const lastAccount = lastAccountId ? accounts.find((a) => a.id === lastAccountId) : undefined;
    const items: ManageActionItem[] = [
      {
        label: "$(plus) 从当前 auth.json 导入账号",
        description: this.authPath,
        action: "import-current",
      },
      {
        label: "$(file) 从文件导入账号",
        description: "导入另一个账号的 auth.json",
        action: "import-file",
      },
      {
        label: "$(go-to-file) 打开当前 auth.json 路径",
        description: this.authPath,
        action: "open-auth-path",
      },
      {
        label: "$(key) 退出当前账号并登录新账号",
        description: "清空当前 auth.json，并打开官方 Codex 侧边栏继续登录",
        action: "login-new",
      },
      {
        label: "$(export) 导出账号配置包",

        description: "导出已保存账号和令牌，便于备份或迁移",
        action: "export-bundle",
      },
      {
        label: "$(package) 导入账号配置包",
        description: "从备份文件恢复多个账号",
        action: "import-bundle",
      },
      {
        label: "$(pulse) 账号健康检查",
        description: "查看 refresh token 缺失、恢复失败和额度异常",
        action: "health",
      },
      {
        label: "$(wrench) 快速修复问题账号",
        description: "重试刷新、切换账号、重新导入或打开 auth.json 路径",
        action: "quick-fix",
      },
      {
        label: "$(refresh) 刷新全部额度",
        description: `${this.refreshIntervalMinutes > 0 ? `每 ${this.refreshIntervalMinutes} 分钟自动刷新一次` : "自动刷新已禁用"} · ${this.autoSwitchSummary}`,
        action: "refresh",
      },
      {
        label: "$(gear) 修改配置",
        description: "刷新间隔、自动切号阈值、超时时间等",
        action: "settings",
      },




    ];

    if (accounts.length > 0) {
      items.push(
        {
          label: "$(account) 切换当前账号",
          description: activeAccount ? `当前：${activeAccount.name}` : "当前未选择账号",
          action: "switch",
        },
      );

      if (lastAccount && lastAccount.id !== activeAccountId) {
        items.push({
          label: "$(history) 切回上一个账号",
          description: `上一个：${lastAccount.name}`,
          action: "switch-last",
        });
      }

      items.push(

        {
          label: "$(edit) 重命名账号",
          description: "修改展示名称",
          action: "rename",
        },

        {
          label: "$(trash) 删除账号",
          description: "移除本地保存的账号与额度缓存",
          action: "remove",
        },
      );
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "选择要执行的 Codex 账号操作",
    });

    if (!picked) {
      return;
    }

    switch (picked.action) {
      case "import-current":
        await this.importCurrentAuth();
        break;
      case "import-file":
        await this.importAuthFile();
        break;
      case "open-auth-path":
        await this.openCurrentAuthPath();
        break;
      case "export-bundle":
        await this.exportAccounts();
        break;
      case "import-bundle":
        await this.importAccountBundle();
        break;
      case "health":
        await this.showAccountHealth();
        break;
      case "quick-fix":
        await this.quickFixAccountHealth();
        break;
      case "switch":
        await this.switchAccount();
        break;
      case "switch-last":
        await this.switchToLastAccount();
        break;
      case "login-new":
        await this.loginNewAccount();
        break;

      case "rename":
        await this.renameAccount();
        break;

      case "remove":
        await this.removeAccount();
        break;
      case "refresh":
        await this.refreshAllQuotas(false);
        break;
      case "settings":
        await this.openSettings();
        break;
    }
  }

  private compareHealthChecks(left: AccountHealthCheck, right: AccountHealthCheck): number {
    const severityScore: Record<AccountHealthCheck["severity"], number> = {
      healthy: 0,
      warning: 1,
      error: 2,
    };

    if (left.isActive !== right.isActive) {
      return left.isActive ? -1 : 1;
    }

    const severityDelta = severityScore[right.severity] - severityScore[left.severity];
    if (severityDelta !== 0) {
      return severityDelta;
    }

    return left.accountName.localeCompare(right.accountName, "zh-CN");
  }

  private async loadAccountHealthChecks(): Promise<{ accounts: AccountProfile[]; checks: AccountHealthCheck[] }> {
    const { accounts, activeAccountId } = await this.loadAccountContext();
    const checks = await Promise.all(
      accounts.map(async (account) => {
        const authData = await this.store.loadAuthData(account.id);
        return evaluateAccountHealth(
          account,
          authData,
          this.refreshIntervalMinutes,
          account.id === activeAccountId,
          this.autoSwitchThresholdPercent,
          this.autoSwitchPriority,
        );
      }),
    );


    return {
      accounts,
      checks: checks.sort((left, right) => this.compareHealthChecks(left, right)),
    };
  }

  private async openCurrentAuthPath(): Promise<void> {
    const authPath = this.authPath;
    const authUri = vscode.Uri.file(authPath);

    try {
      await vscode.workspace.fs.stat(authUri);
      const document = await vscode.workspace.openTextDocument(authUri);
      await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
      });
      return;
    } catch {
      const directoryUri = vscode.Uri.file(path.dirname(authPath));
      await vscode.workspace.fs.createDirectory(directoryUri);
      await vscode.commands.executeCommand("revealFileInOS", directoryUri);
      void vscode.window.showWarningMessage(`当前 auth.json 还不存在，已帮你打开目录：${authPath}`);
    }
  }

  private async showAccountHealth(offerQuickFix = true): Promise<void> {
    const { accounts, checks } = await this.loadAccountHealthChecks();
    if (!(await this.requireAccounts(accounts, "查看健康检查"))) return;

    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: renderAccountHealthMarkdown(
        checks,
        new Date().toISOString(),
        this.refreshIntervalMinutes,
        this.autoSwitchThresholdPercent,
        this.autoSwitchPriority,
      ),

    });

    await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
    });

    if (!offerQuickFix) {
      return;
    }

    const unhealthyCount = checks.filter((check) => check.severity !== "healthy").length;
    if (unhealthyCount === 0) {
      return;
    }

    const nextAction = await vscode.window.showInformationMessage(
      `健康检查完成：发现 ${unhealthyCount} 个需要处理的账号。`,
      "快速处理问题账号",
      "稍后再说",
    );

    if (nextAction === "快速处理问题账号") {
      await this.quickFixAccountHealth();
    }
  }

  private async quickFixAccountHealth(accountId?: string): Promise<void> {
    const { accounts, checks } = await this.loadAccountHealthChecks();
    if (!(await this.requireAccounts(accounts, "修复"))) return;

    const problemChecks = checks.filter((check) => check.severity !== "healthy");
    const targetCheck = accountId
      ? checks.find((check) => check.accountId === accountId)
      : undefined;

    const selected = targetCheck
      ? {
        account: accounts.find((account) => account.id === targetCheck.accountId),
        check: targetCheck,
      }
      : await vscode.window.showQuickPick<HealthCheckPickItem>(
        (problemChecks.length > 0 ? problemChecks : checks).map((check) => ({
          label: `${check.severity === "error" ? "$(error)" : check.severity === "warning" ? "$(warning)" : "$(pass)"} ${check.accountName}`,
          description: check.isActive ? "当前账号" : check.email,
          detail: `${check.summary} · ${check.quotaSummary}`,
          account: accounts.find((account) => account.id === check.accountId)!,
          check,
        })),
        {
          placeHolder: problemChecks.length > 0
            ? "选择要处理的问题账号"
            : "目前没有异常账号，选择一个账号执行手动修复动作",
        },
      );

    if (!selected?.account) {
      return;
    }

    const account = selected.account;
    const check = selected.check;
    const actionItems: HealthActionItem[] = [
      {
        label: "$(refresh) 重试刷新这个账号的额度",
        description: check.summary,
        action: "refresh-account",
      },
      {
        label: "$(file) 从文件重新导入这个账号",
        description: "适合 refresh token 缺失或连续恢复失败时直接覆盖更新",
        action: "reimport-file",
      },
      {
        label: "$(go-to-file) 打开当前 auth.json 路径",
        description: this.authPath,
        action: "open-auth-path",
      },
      {
        label: "$(pulse) 重新查看账号健康检查",
        description: "修完后再看一眼报告，心里更踏实",
        action: "show-health-report",
      },
    ];

    if (!check.isActive) {
      actionItems.unshift({
        label: "$(account) 切换到这个账号并同步 auth.json",
        description: "让官方 Codex 扩展立即跟到这个账号上",
        action: "activate-account",
      });
    } else {
      actionItems.unshift({
        label: "$(history) 从当前 auth.json 重新导入当前账号",
        description: this.authPath,
        action: "reimport-current",
      });
    }

    const action = await vscode.window.showQuickPick(actionItems, {
      placeHolder: `处理账号"${account.name}"`,
    });

    if (!action) {
      return;
    }

    switch (action.action) {
      case "refresh-account": {
        const ok = await this.refreshQuotaForAccount(account.id, true);
        if (!ok) {
          void vscode.window.showWarningMessage(`账号"${account.name}"仍有异常，建议重新导入后再试。`);
        }
        break;
      }
      case "activate-account": {
        // 切换前检查当前 auth.json 是否有未导入的账号
        if (!(await this.confirmProceedIfCurrentAuthUnimported("切换账号"))) {
          break;
        }
        await this.activateAccountManually(account.id, { notify: true, skipUnimportedCheck: true });
        break;
      }
      case "reimport-current":
        await this.importCurrentAuth();
        break;
      case "reimport-file":
        await this.importAuthFile();
        break;
      case "open-auth-path":
        await this.openCurrentAuthPath();
        return; // 不需要重新显示健康报告
      case "show-health-report":
        await this.showAccountHealth(false);
        return; // 已经显示了，不再重复
    }
    await this.showAccountHealth(false);
  }


  private async pickAccount(placeHolder: string): Promise<AccountProfile | undefined> {

    const { accounts, activeAccountId } = await this.loadAccountContext();

    if (!(await this.requireAccounts(accounts, ""))) return undefined;

    const picked = await this.showAccountQuickPick(
      this.buildAccountPickItems(accounts, activeAccountId),
      placeHolder,
      activeAccountId,
    );

    return picked?.account;
  }


  private async importCurrentAuth(): Promise<void> {
    const authPath = this.authPath;
    const authData = await loadAuthDataFromFile(authPath);

    if (!authData) {
      void vscode.window.showErrorMessage(`当前 ${authPath} 里没有登录信息，请先在 Codex 侧边栏完成登录。`);
      return;
    }

    await this.importAuthData(authData, { allowReloadOnActivate: false });
  }



  private async importAuthFile(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      filters: {
        JSON: ["json"],
      },
      openLabel: "导入 Codex auth.json",
    });

    if (!picked || picked.length === 0) {
      return;
    }

    const authData = await loadAuthDataFromFile(picked[0].fsPath);
    if (!authData) {
      void vscode.window.showErrorMessage("选中的文件不是有效的 Codex auth.json。");
      return;
    }

    await this.importAuthData(authData);
  }

  /**
   * 切换账号 / 登录新账号前，检查当前 auth.json 是否已经被导入到插件里。
   * 若未导入，则弹出确认提示，让用户决定是否继续（继续则当前登录信息将会丢失）。
   * 返回 true 表示可以继续，false 表示用户取消或确认放弃。
   */
  private async confirmProceedIfCurrentAuthUnimported(actionLabel: string): Promise<boolean> {
    const result = await this.loadCurrentAuthAndMatch();
    if (!result) return true;

    const { authData: currentAuthData, matchedAccount: matched } = result;
    if (matched) {
      return true;
    }

    const accountLabel = this.deriveDefaultName(currentAuthData);
    const answer = await vscode.window.showWarningMessage(
      `"${accountLabel}" 账号还未导入，${actionLabel}后当前登录信息将丢失，是否继续？`,
      { modal: true },
      "继续",
    );

    return answer === "继续";
  }

  private async loginNewAccount(): Promise<void> {
    if (!(await this.confirmProceedIfCurrentAuthUnimported("登录新账号"))) {
      return;
    }

    await clearCodexAuthFile(this.authPath);
    await this.store.setActiveAccountId(undefined);
    this.clearExternalAuthNotice();
    await this.refreshStatusBar();


    if (await this.restartCodexExtensionForNewLogin()) {
      return;
    }

    if (this.hasOfficialCodexExtensionInstalled()) {
      try {
        await vscode.commands.executeCommand("chatgpt.openSidebar");
      } catch {
        // ignore
      }
      return;
    }
  }


  private async exportAccounts(): Promise<void> {

    const { accounts, activeAccountId } = await this.loadAccountContext();

    if (!(await this.requireAccounts(accounts, "可导出"))) return;

    const picked = await vscode.window.showQuickPick<ExportPickItem>(
      [
        {
          label: "$(files) 导出全部账号",
          description: `共 ${accounts.length} 个账号`,
          accountIds: accounts.map((account) => account.id),
        },
        ...accounts.map((account) => ({
          label: account.name,
          description: this.buildAccountDescription(account),
          detail: this.buildAccountQuotaDetail(account),
          accountIds: [account.id],
        })),



      ],
      {
        placeHolder: "选择要导出的账号范围",
      },
    );

    if (!picked) {
      return;
    }

    const exportItems: ExportedAccountItem[] = [];
    const skippedAccounts: string[] = [];

    for (const accountId of picked.accountIds) {
      const account = accounts.find((item) => item.id === accountId);
      if (!account) {
        continue;
      }

      const authData = await this.store.loadAuthData(account.id);
      if (!authData) {
        skippedAccounts.push(account.name);
        continue;
      }

      exportItems.push({
        name: account.name,
        isActive: account.id === activeAccountId,
        quota: account.quota,
        auth: authData,
      });
    }

    if (exportItems.length === 0) {
      void vscode.window.showErrorMessage("选中的账号都缺少可导出的令牌，请先重新导入这些账号。");
      return;
    }

    const saveUri = await vscode.window.showSaveDialog({
      filters: {
        JSON: ["json"],
      },
      saveLabel: "导出账号配置包",
    });

    if (!saveUri) {
      return;
    }

    const bundle = createAccountsExportFile(exportItems);
    await vscode.workspace.fs.writeFile(saveUri, Buffer.from(serializeAccountsExportFile(bundle), "utf8"));

    const skippedSuffix = skippedAccounts.length > 0
      ? `，另有 ${skippedAccounts.length} 个账号因令牌缺失未导出`
      : "";

    void vscode.window.showInformationMessage(
      `配置包已导出：${saveUri.fsPath}${skippedSuffix}`,
    );
  }

  private async importAccountBundle(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      filters: {
        JSON: ["json"],
      },
      openLabel: "导入账号配置包",
    });

    if (!picked || picked.length === 0) {
      return;
    }

    let bundle;
    try {
      const content = await vscode.workspace.fs.readFile(picked[0]);
      bundle = parseAccountsExportFile(Buffer.from(content).toString("utf8"));
    } catch (error) {
      void vscode.window.showErrorMessage(
        `账号配置包导入失败：${this.getErrorMessage(error, "文件格式不正确")}`,
      );
      return;
    }

    let createdCount = 0;
    let updatedCount = 0;
    let restoredQuotaCount = 0;
    let nextActiveAccountId: string | undefined;

    for (const item of bundle.accounts) {
      const duplicate = await this.store.findDuplicateAccount(item.auth);
      const { account, created } = await this.store.upsertAccountFromAuth(item.auth, item.name);

      if (created || !duplicate) {
        createdCount += 1;
      } else {
        updatedCount += 1;
      }

      if (item.quota) {
        await this.store.updateQuota(account.id, item.quota);
        restoredQuotaCount += 1;
      }

      if (item.isActive) {
        nextActiveAccountId = account.id;
      }
    }

    if (nextActiveAccountId) {
      await this.activateAccountById(nextActiveAccountId, { notify: false });

    } else {
      await this.refreshStatusBar();
    }

    const quotaSuffix = restoredQuotaCount > 0 ? `，恢复额度 ${restoredQuotaCount} 个` : "";
    void vscode.window.showInformationMessage(
      `导入完成：新增 ${createdCount} 个，更新 ${updatedCount} 个${quotaSuffix}`,
    );
  }

  private async importAuthData(authData: AuthData, options: ImportAuthOptions = {}): Promise<void> {
    const { allowReloadOnActivate = true } = options;
    const existing = await this.store.findDuplicateAccount(authData);

    let preferredName = existing?.name;

    if (!existing) {
      preferredName = await vscode.window.showInputBox({
        prompt: "给这个账号起个名字，状态栏和悬停列表都会显示它",
        value: this.deriveDefaultName(authData),
        validateInput: (value) => (value.trim().length === 0 ? "名称不能为空" : undefined),
      });

      if (!preferredName) {
        return;
      }
    }

    const { account, created } = await this.store.upsertAccountFromAuth(authData, preferredName);
    this.clearExternalAuthNotice();
    await this.activateAccountById(account.id, {
      notify: false,
      allowReload: allowReloadOnActivate,
    });
  }



  private deriveDefaultName(authData: AuthData): string {
    if (authData.email) {
      return authData.email.split("@")[0];
    }

    if (authData.defaultOrganizationTitle) {
      return authData.defaultOrganizationTitle;
    }

    return "codex-account";
  }

  private async activateAccountManually(accountId: string | undefined, options: ActivateAccountOptions): Promise<void> {
    if (!accountId) {
      await this.switchAccount();
      return;
    }

    if (!options.skipUnimportedCheck) {
      if (!(await this.confirmProceedIfCurrentAuthUnimported("切换账号"))) {
        return;
      }
    }

    // 手动切号前检查 Codex 是否正在推理
    const idleStatus = await this.canAutoSwitchNow();
    if (!idleStatus.canSwitch) {
      const elapsedText = this.formatElapsedMinutes(idleStatus.lastActivityAt) ?? "未知";
      const confirm = await vscode.window.showWarningMessage(
        `Codex 正在推理中（最近活动：${elapsedText}），切换账号将中断当前推理并重启 Codex 扩展，确定要继续吗？`,
        { modal: true },
        "仍然切换",
      );
      if (confirm !== "仍然切换") {
        return;
      }
    }

    this.manualSwitchGeneration++;
    await this.context.globalState.update(MANUAL_SWITCH_OVERRIDE_ACCOUNT_ID_KEY, accountId);
    await this.activateAccountById(accountId, options);
  }

  private async switchAccount(): Promise<void> {
    if (!(await this.confirmProceedIfCurrentAuthUnimported("切换账号"))) {
      return;
    }

    const account = await this.pickAccount("选择要切换到的 Codex 账号");
    if (!account) {
      return;
    }

    await this.activateAccountManually(account.id, { notify: true, skipUnimportedCheck: true });
  }

  private async switchToLastAccount(): Promise<void> {
    if (!(await this.confirmProceedIfCurrentAuthUnimported("切换账号"))) {
      return;
    }

    const [lastAccountId, activeAccountId] = await Promise.all([
      this.store.getLastAccountId(),
      this.store.getActiveAccountId(),
    ]);

    if (!lastAccountId) {
      return;
    }

    if (lastAccountId === activeAccountId) {
      return;
    }

    const lastAccount = await this.store.getAccount(lastAccountId);
    if (!lastAccount) {
      return;
    }

    await this.activateAccountManually(lastAccountId, {
      notify: true,
      notificationMessage: `已切回上一个账号：${lastAccount.name}`,
      skipUnimportedCheck: true,
    });

  }

  private async renameAccount(): Promise<void> {
    const account = await this.pickAccount("选择要重命名的账号");
    if (!account) {
      return;
    }

    const nextName = await vscode.window.showInputBox({
      prompt: `为账号"${account.name}"输入新的显示名称`,
      value: account.name,
      validateInput: (value) => (value.trim().length === 0 ? "名称不能为空" : undefined),
    });

    if (!nextName) {
      return;
    }

    await this.store.renameAccount(account.id, nextName);
    await this.refreshStatusBar();
  }

  private async removeAccount(): Promise<void> {
    const account = await this.pickAccount("选择要删除的账号");
    if (!account) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `确定删除账号"${account.name}"吗？这会移除本地保存的令牌和额度缓存。`,
      { modal: true },
      "删除",
    );

    if (confirm !== "删除") {
      return;
    }

    await this.store.deleteAccount(account.id);
    await this.refreshStatusBar();
  }

  private async updateBooleanSetting(config: vscode.WorkspaceConfiguration, settingKey: string): Promise<void> {
    try {
      const current = config.get<boolean>(settingKey, true);
      await config.update(settingKey, !current, vscode.ConfigurationTarget.Global);
      await this.refreshStatusBar();
    } catch (error) {
      if (String(error).includes("没有注册配置") || String(error).includes("not registered")) {
        void vscode.window.showWarningMessage(
          `配置项 ${settingKey} 未注册，请重新安装扩展后重启 VS Code 窗口。`,
        );
      } else {
        throw error;
      }
    }
  }

  private async updateNumberSetting(config: vscode.WorkspaceConfiguration, settingKey: string, description: string): Promise<void> {
    const input = await vscode.window.showInputBox({
      prompt: description,
      value: String(config.get<number>(settingKey)),
      validateInput: (value) => {
        const num = Number(value);
        if (!Number.isFinite(num)) return "请输入有效数字";
        if (settingKey === "autoSwitchThresholdPercent" && (num < 0 || num > 100)) return "范围 0 ~ 100";
        if (settingKey === "codexIdleThresholdSeconds" && (num < 15 || num > 600)) return "范围 15 ~ 600";
        if (settingKey === "requestTimeoutSeconds" && num < 5) return "最小 5 秒";
        if (settingKey === "refreshIntervalMinutes" && num < 0) return "最小 0（禁用）";
        return undefined;
      },
    });
    if (input === undefined) return;
    const num = Number(input);
    if (Number.isFinite(num)) {
      await config.update(settingKey, num, vscode.ConfigurationTarget.Global);
      await this.refreshStatusBar();
    }
  }

  private async updateEnumSetting(config: vscode.WorkspaceConfiguration, picked: { settingKey: string; label: string; enumValues: string[]; enumLabels: string[] }): Promise<void> {
    const currentVal = config.get<string>(picked.settingKey);
    const currentIdx = picked.enumValues.indexOf(currentVal ?? "");
    const enumItems = picked.enumLabels.map((label, idx) => ({
      label: `${idx === currentIdx ? "$(check) " : ""}${label}`,
      value: picked.enumValues[idx],
      description: idx === currentIdx ? "当前" : undefined,
    }));
    const selected = await vscode.window.showQuickPick(enumItems, {
      placeHolder: `选择「${picked.label.replace(/^.*\)\s*/, "")}」的值`,
    });
    if (selected && selected.value !== currentVal) {
      await config.update(picked.settingKey, selected.value, vscode.ConfigurationTarget.Global);
      await this.refreshStatusBar();
    }
  }

  private async openSettings(): Promise<void> {
    interface SettingPickItem extends vscode.QuickPickItem {
      sectionId: string;
      settingKey: string;
      currentLabel: string;
      type: "boolean" | "number" | "enum";
      enumValues?: string[];
      enumLabels?: string[];
    }

    const config = vscode.workspace.getConfiguration("codexAccountManager");

    const settingItems: SettingPickItem[] = [
      {
        label: "$(clock) 刷新间隔",
        description: "设为 0 则禁用自动刷新",
        detail: this.refreshIntervalMinutes > 0 ? `${this.refreshIntervalMinutes} 分钟` : "已禁用",
        sectionId: "codexAccountManager.refreshIntervalMinutes",
        settingKey: "refreshIntervalMinutes",
        currentLabel: `${this.refreshIntervalMinutes}`,
        type: "number",
      },
      {
        label: "$(timer) 请求超时",
        description: "请求 Codex 额度接口的超时时间",
        detail: `${this.requestTimeoutMs / 1000} 秒`,
        sectionId: "codexAccountManager.requestTimeoutSeconds",
        settingKey: "requestTimeoutSeconds",
        currentLabel: `${this.requestTimeoutMs / 1000}`,
        type: "number",
      },
      {
        label: "$(arrow-swap) 自动切号阈值",
        description: "当前账号最低可用额度低于此百分比则自动切号",
        detail: `${this.autoSwitchThresholdPercent}%（设为 0 关闭）`,
        sectionId: "codexAccountManager.autoSwitchThresholdPercent",
        settingKey: "autoSwitchThresholdPercent",
        currentLabel: `${this.autoSwitchThresholdPercent}%`,
        type: "number",
      },
      {
        label: "$(list-ordered) 自动切号优先级",
        description: "自动切号时比较候选账号额度的策略",
        detail: formatAutoSwitchPriority(this.autoSwitchPriority),
        sectionId: "codexAccountManager.autoSwitchPriority",
        settingKey: "autoSwitchPriority",
        currentLabel: formatAutoSwitchPriority(this.autoSwitchPriority),
        type: "enum",
        enumValues: ["lowest-window-first", "primary-first", "secondary-first"],
        enumLabels: ["最低窗口优先", "5h 优先", "7d 优先"],
      },
      {
        label: "$(debug-restart) 切号后重启 Codex 扩展",
        description: "切换账号后自动重启扩展宿主让官方 Codex 扩展立即生效",
        detail: this.shouldRestartExtensionHostAfterSwitch ? "已开启" : "已关闭",
        sectionId: "codexAccountManager.restartExtensionHostAfterSwitch",
        settingKey: "restartExtensionHostAfterSwitch",
        currentLabel: this.shouldRestartExtensionHostAfterSwitch ? "开启" : "关闭",
        type: "boolean",
      },
      {
        label: "$(device-desktop) 切号后重启 Codex 应用",
        description: "切换账号后自动重启 Codex 桌面应用使其加载新账号（会中断当前会话）",
        detail: this.shouldRestartCodexAppAfterSwitch ? "已开启" : "已关闭",
        sectionId: "codexAccountManager.restartCodexAppAfterSwitch",
        settingKey: "restartCodexAppAfterSwitch",
        currentLabel: this.shouldRestartCodexAppAfterSwitch ? "开启" : "关闭",
        type: "boolean",
      },
      {
        label: "$(eye) 悬停显示邮箱",
        description: "在状态栏悬停提示中显示账号邮箱",
        detail: this.showEmailInTooltip ? "已开启" : "已关闭",
        sectionId: "codexAccountManager.showEmailInTooltip",
        settingKey: "showEmailInTooltip",
        currentLabel: this.showEmailInTooltip ? "开启" : "关闭",
        type: "boolean",
      },
      {
        label: "$(beaker-stop) 自动切号前检查 Codex 空闲",
        description: "开启后，自动切号前先判断官方 Codex 最近是否仍在活动",
        detail: this.shouldAutoSwitchRequireCodexIdle ? "已开启" : "已关闭",
        sectionId: "codexAccountManager.autoSwitchRequiresCodexIdle",
        settingKey: "autoSwitchRequiresCodexIdle",
        currentLabel: this.shouldAutoSwitchRequireCodexIdle ? "开启" : "关闭",
        type: "boolean",
      },
      {
        label: "$(watch) 空闲判定秒数",
        description: this.shouldAutoSwitchRequireCodexIdle
          ? "sessions 无写入超过此时长后视为空闲，才会自动切号"
          : "需要先开启「自动切号前检查 Codex 空闲」",
        detail: this.shouldAutoSwitchRequireCodexIdle ? `${this.codexIdleThresholdSeconds} 秒` : "未启用",
        sectionId: "codexAccountManager.codexIdleThresholdSeconds",
        settingKey: "codexIdleThresholdSeconds",
        currentLabel: `${this.codexIdleThresholdSeconds}`,
        type: "number",
      },
    ];

    const picked = await vscode.window.showQuickPick(settingItems, {
      placeHolder: "选择要修改的配置项",
    });

    if (!picked) {
      return;
    }

    switch (picked.type) {
      case "boolean":
        await this.updateBooleanSetting(config, picked.settingKey);
        break;
      case "number":
        if (picked.settingKey === "codexIdleThresholdSeconds" && !this.shouldAutoSwitchRequireCodexIdle) {
          await vscode.window.showInformationMessage("请先开启「自动切号前检查 Codex 空闲」");
          break;
        }
        await this.updateNumberSetting(config, picked.settingKey, picked.description ?? "");
        break;
      case "enum":
        if (picked.enumValues && picked.enumLabels) {
          await this.updateEnumSetting(config, picked as typeof picked & { enumValues: string[]; enumLabels: string[] });
        }
        break;
    }
  }

  private async activateAccountById(accountId: string | undefined, options: ActivateAccountOptions): Promise<void> {
    const {
      notify,
      refreshQuota = true,
      allowReload = true,
      notificationMessage,
    } = options;

    if (!accountId) {
      await this.switchAccount();
      return;
    }

    const previousActiveAccountId = await this.store.getActiveAccountId();
    const authData = await this.store.loadAuthData(accountId);
    const account = await this.store.getAccount(accountId);

    if (!authData || !account) {
      void vscode.window.showErrorMessage("账号信息不完整，请重新导入该账号。");
      return;
    }

    this.clearExternalAuthNotice();

    // 先把 auth.json 写进去，让 Codex 能马上感知新账号
    await syncCodexAuthFile(this.authPath, authData);

    const accountChanged = previousActiveAccountId !== accountId;

    // 如果配置了重启 Codex 桌面应用，在 auth.json 写入后立即执行
    // （要在 Extension Host 重启之前，因为重启后本代码不会再跑）
    if (accountChanged && this.shouldRestartCodexAppAfterSwitch) {
      await this.restartCodexDesktopApp();
    }

    const shouldRestartCodexExtension = allowReload && accountChanged;

    if (shouldRestartCodexExtension) {
      // 先触发 Codex 扩展同步（重启扩展宿主 / 整窗重载）
      // 同步完成后再 setActiveAccountId + refreshStatusBar，保证账号列表里的"当前账号"标记
      // 在 Codex 扩展已经切过去之后才更新，避免 UI 先跳走、Codex 还在旧账号
      const restartedCodexExtension = await this.applyCodexExtensionSyncAfterSwitch(notify, account.name);
      if (restartedCodexExtension) {
        // Extension Host 重启时本扩展也会被重建，下面的代码不会再跑到
        // 但 auth.json 已经写了，重新激活后 restoreActiveAccountAuth 会对账好
        // 这里仍然落一下 activeAccountId，万一重启不彻底也能兜底
        await this.store.setActiveAccountId(accountId);
        return;
      }
    }

    // 未触发重启（自动切换 / allowReload=false / 账号未变 / 没装官方扩展）：
    // 直接落库并刷新状态栏
    await this.store.setActiveAccountId(accountId);
    await this.refreshStatusBar();

    if (refreshQuota) {
      await this.refreshQuotaForAccount(accountId, notify);
    }

    if (notify && notificationMessage) {
      void vscode.window.showInformationMessage(notificationMessage);
    }
  }




  private async tryRecoverAuthData(
    accountId: string,
    authData: AuthData,
    notifyFailure: boolean,
  ): Promise<AuthData | null> {
    try {
      const refreshedAuthData = await new CodexTokenRecoveryClient(authData, this.requestTimeoutMs).refreshAuthData();
      await this.store.replaceAuthData(accountId, refreshedAuthData);
      await this.store.recordTokenRecoverySuccess(accountId, refreshedAuthData);

      const activeAccountId = await this.store.getActiveAccountId();
      if (activeAccountId === accountId) {
        await syncCodexAuthFile(this.authPath, refreshedAuthData);
      }

      return refreshedAuthData;
    } catch (error) {
      const message = this.getErrorMessage(error);
      await this.store.recordTokenRecoveryFailure(accountId, authData, message);

      if (notifyFailure) {
        void vscode.window.showWarningMessage(
          `检测到账号令牌失效，但自动恢复失败：${message}。请重新导入该账号。`,
        );
      }

      return null;
    }

  }

  private async refreshQuotaForAccount(accountId: string, notifyRecoveryFailure = false): Promise<boolean> {
    let authData = await this.store.loadAuthData(accountId);
    if (!authData) {
      await this.store.updateQuota(accountId, {
        fetchedAt: new Date().toISOString(),
        error: "缺少令牌，请重新导入账号",
      });
      await this.refreshStatusBar();
      return false;
    }

    // 对当前激活账号，优先从 auth.json 同步最新 token。
    // 官方 Codex 扩展（通过 Codex CLI）在每次调用时会自动续期并将最新 token 写回
    // auth.json，而我们的 Keychain 里保存的是导入时的快照，可能已经过期。
    // 只要 auth.json 里的账号和 Keychain 里的是同一个账号（fingerprint 匹配），
    // 就用 auth.json 里的 accessToken/refreshToken 覆盖 Keychain，保持同步。
    try {
      const activeAccountId = await this.store.getActiveAccountId();
      if (activeAccountId === accountId) {
        const syncResult = await this.loadCurrentAuthAndMatch();
        if (syncResult?.matchedAccount && syncResult.matchedAccount.id === accountId) {
            const authFileData = syncResult.authData;
            // auth.json 里的 token 比 Keychain 里的更新（官方扩展已续期）
            const fileAccessToken = authFileData.accessToken;
            const fileRefreshToken = authFileData.refreshToken;
            const staleAccessToken = authData.accessToken;

            if (
              fileAccessToken &&
              (fileAccessToken !== staleAccessToken || fileRefreshToken !== authData.refreshToken)
            ) {
              this.tsLog(`quota:sync-token-from-auth-file accountId=${accountId}`);
              // 把 auth.json 里更新的 token 合并进来，同时写回 Keychain
              const syncedAuthData: AuthData = {
                ...authData,
                accessToken: fileAccessToken,
                refreshToken: fileRefreshToken ?? authData.refreshToken,
                idToken: authFileData.idToken ?? authData.idToken,
                authJson: authFileData.authJson ?? authData.authJson,
              };
              await this.store.replaceAuthData(accountId, syncedAuthData);
              authData = syncedAuthData;
            }
        }
      }
    } catch (syncError) {
      // auth.json 同步失败时只记日志，继续用 Keychain 里的旧 token 尝试刷新
      this.tsLog(`quota:sync-token-from-auth-file failed: ${this.getErrorMessage(syncError, String(syncError))}`);
    }

    let quota: QuotaSnapshot = await new CodexQuotaClient(authData, this.requestTimeoutMs).fetchQuota();

    if (isSessionRevokedError(quota.error)) {
      // session 已被服务端吊销（token_revoked / token_invalidated），
      // refresh token 同步失效，不走自动恢复，直接给出明确提示
      quota = {
        ...quota,
        error: "会话已吊销，请重新登录后导入",
      };
    } else if (isTokenExpiredAndUnrecoverableError(quota.error)) {
      // token 已过期（token_expired），refresh token 大概率也已失效，不走自动恢复
      quota = {
        ...quota,
        error: "会话已过期，请重新登录后导入",
      };
    } else if (shouldAttemptTokenRecovery(authData, quota.statusCode, quota.error)) {
      const recoveredAuthData = await this.tryRecoverAuthData(accountId, authData, notifyRecoveryFailure);
      if (recoveredAuthData) {
        quota = await new CodexQuotaClient(recoveredAuthData, this.requestTimeoutMs).fetchQuota();

        if (shouldAttemptTokenRecovery(recoveredAuthData, quota.statusCode, quota.error)) {
          quota = {
            ...quota,
            error: `令牌已刷新，但额度接口仍然拒绝访问：${quota.error || `HTTP ${quota.statusCode ?? 0}`}`,
          };
        }
      } else {
        // token_expired 且自动恢复失败 → 给出友好提示
        const isExpired = isTokenExpiredAndUnrecoverableError(quota.error);
        quota = {
          ...quota,
          error: isExpired
            ? "会话已过期，请重新登录后导入"
            : authData.refreshToken
              ? "令牌失效，自动恢复失败"
              : "令牌失效，缺少 refresh token",
        };
      }
    }

    await this.store.updateQuota(accountId, quota);
    await this.refreshStatusBar();
    return !quota.error;
  }

  private async refreshAllQuotas(silent: boolean): Promise<void> {
    if (this.refreshing) {
      return;
    }

    // 刷新开始时快照手动切换序列号；若刷新过程中用户手动切号，序列号会变，
    // 刷新完后检测到变化则跳过 autoSwitch，避免用刷新后的额度把手动切换覆盖掉
    const generationAtRefreshStart = this.manualSwitchGeneration;

    this.refreshing = true;
    await this.refreshStatusBar();

    // Grok 与 Codex 并行；finally 必须 join，避免异常路径留下陈旧 Grok UI（审查 #4）
    let grokRefresh: Promise<void> = Promise.resolve();

    try {
      grokRefresh = this.refreshGrokPeriodRemaining();

      const accounts = await this.store.listAccounts();
      if (accounts.length === 0) {
        await grokRefresh;
        if (!silent) {
          void vscode.window.showInformationMessage("还没有可刷新的账号，先导入一个吧。");
        }
        return;
      }

      const results: PromiseSettledResult<boolean>[] = [];
      for (const account of accounts) {
        // 自动刷新时跳过令牌已失效的账号（session 被吊销或已过期），仅保留手动刷新能力
        if (silent && isUnrecoverableAuthError(account.quota?.error)) {
          results.push({ status: "fulfilled", value: false });
          continue;
        }
        try {
          const ok = await this.refreshQuotaForAccount(account.id, false);
          results.push({ status: "fulfilled", value: ok });
        } catch (e) {
          results.push({ status: "rejected", reason: e });
        }
      }

      await grokRefresh;

      // 刷新额度完成后顺带同步当前激活账号的 planType：
      // 用户在 OpenAI 后台升级套餐后，auth.json 里的 chatgpt_plan_type 已更新，
      // 但 accounts.json 里只在导入/切号时才会更新，需要在这里主动补齐。
      await this.maybeSyncActivePlanType();

      // 若刷新期间发生了手动切换，跳过本轮 autoSwitch，不覆盖用户的选择
      const autoSwitchOutcome = this.manualSwitchGeneration === generationAtRefreshStart
        ? await this.maybeAutoSwitchLowQuotaAccount()
        : undefined;

      if (autoSwitchOutcome?.status === "switched") {
        void vscode.window.showInformationMessage(
          `当前账号"${autoSwitchOutcome.from.name}"最低可用额度已低于 ${autoSwitchOutcome.thresholdPercent}%（${autoSwitchOutcome.fromPercent.toFixed(1)}%），已按"${autoSwitchOutcome.priorityLabel}"策略自动切换到更优账号"${autoSwitchOutcome.to.name}"（当前最低可用额度 ${autoSwitchOutcome.toPercent.toFixed(1)}%）。`,
        );
      }

      if (!silent && autoSwitchOutcome?.status === "deferred-busy") {
        const recentActivity = this.formatElapsedMinutes(autoSwitchOutcome.lastActivityAt) || "最近";
        void vscode.window.showInformationMessage(
          `当前账号"${autoSwitchOutcome.from.name}"最低可用额度已低于 ${autoSwitchOutcome.thresholdPercent}%（${autoSwitchOutcome.fromPercent.toFixed(1)}%），但检测到 Codex ${recentActivity}仍有会话写入，暂不自动切换到"${autoSwitchOutcome.to.name}"，等空闲至少 ${autoSwitchOutcome.idleThresholdSeconds} 秒后下次刷新再试。`,
        );
      }

      if (!silent) {
        const failedCount = results.filter((result) => result.status === "rejected" || result.value === false).length;
        const refreshedCount = results.length - failedCount;
        const switchedSuffix = autoSwitchOutcome?.status === "switched"
          ? `，已按 ${autoSwitchOutcome.priorityLabel} 切换到 ${autoSwitchOutcome.to.name}`
          : autoSwitchOutcome?.status === "deferred-busy"
            ? `，但因 Codex 仍忙暂未切换到 ${autoSwitchOutcome.to.name}`
            : "";
        void vscode.window.showInformationMessage(`额度刷新完成：成功 ${refreshedCount} 个，失败 ${failedCount} 个${switchedSuffix}。`);
      }
    } finally {
      try {
        await grokRefresh;
      } catch {
        // Grok 失败已在 refreshGrokPeriodRemaining 内消化；此处仅确保 join
      }
      this.refreshing = false;
      await this.refreshStatusBar();
    }
  }
}

