import * as https from "node:https";
import { URL } from "node:url";
import { AuthData, QuotaSnapshot, QuotaWindow } from "./types";

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

// /wham/usage 接口返回的 JSON 结构（字段名存在多种变体）
interface WhamUsageWindow {
  percent_left?: number;
  remaining_percent?: number;
  used_percent?: number;
  reset_after_seconds?: number;
  reset_time_ms?: number;
  reset_at?: number;
  limit_window_seconds?: number;
  primary_window?: WhamUsageWindow;
  secondary_window?: WhamUsageWindow;
}

interface WhamUsageRateLimit {
  five_hour?: WhamUsageWindow;
  five_hour_limit?: WhamUsageWindow;
  five_hour_rate_limit?: WhamUsageWindow;
  primary?: WhamUsageWindow;
  primary_window?: WhamUsageWindow;
  weekly?: WhamUsageWindow;
  weekly_limit?: WhamUsageWindow;
  weekly_rate_limit?: WhamUsageWindow;
  secondary?: WhamUsageWindow;
  secondary_window?: WhamUsageWindow;
}

interface WhamUsageResponse {
  rate_limit?: WhamUsageRateLimit;
  rate_limits?: WhamUsageRateLimit;
}

export class CodexQuotaClient {
  constructor(
    private readonly authData: AuthData,
    private readonly timeoutMs: number,
  ) {}

  async fetchQuota(): Promise<QuotaSnapshot> {
    const fetchedAt = new Date().toISOString();

    try {
      const body = await this.fetchWhamUsage();
      const data: WhamUsageResponse = JSON.parse(body);
      const rateLimit = data.rate_limit ?? data.rate_limits;

      const windows = [
        this.extractWindowFromRateLimit(rateLimit, "primary"),
        this.extractWindowFromRateLimit(rateLimit, "secondary"),
      ].filter((window): window is QuotaWindow => Boolean(window));

      // /wham/usage 不保证 primary/secondary 槽位分别对应 5h/7d。
      // 例如只有 weekly 额度时，当前接口会把 7d 窗口放在 primary_window。
      const primary = windows.find((window) => (window.windowMinutes ?? 0) < 24 * 60);
      const secondary = windows.find((window) => (window.windowMinutes ?? 0) >= 24 * 60);

      return {
        primary,
        secondary,
        fetchedAt,
        statusCode: 200,
        error:
          primary || secondary
            ? undefined
            : "未从 /wham/usage 解析到额度数据",
      };
    } catch (error) {
      return {
        fetchedAt,
        error: error instanceof Error ? error.message : "刷新额度失败",
      };
    }
  }

  private async fetchWhamUsage(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const requestUrl = new URL("https://chatgpt.com/backend-api/wham/usage");

      const headers: Record<string, string> = {
        "Authorization": `Bearer ${this.authData.accessToken}`,
        "Accept": "application/json",
        "Origin": "https://chatgpt.com",
        "Referer": "https://chatgpt.com/",
        "User-Agent": "codex-account-manager/0.0.41",
        "Cache-Control": "no-cache",
      };

      if (this.authData.accountId) {
        headers["ChatGPT-Account-Id"] = this.authData.accountId;
      }

      let settled = false;
      const finish = (handler: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        handler();
      };

      const request = https.request(
        requestUrl,
        { method: "GET", headers },
        (response) => {
          let body = "";

          if ((response.statusCode ?? 500) >= 400) {
            let errBody = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
              if (errBody.length < 2048) {
                errBody += chunk;
              }
            });
            response.on("end", () =>
              finish(() =>
                reject(
                  new Error(
                    `HTTP ${response.statusCode}${errBody ? `: ${errBody.slice(0, 512)}` : ""}`,
                  ),
                ),
              ),
            );
            response.on("close", () =>
              finish(() =>
                reject(new Error(`HTTP ${response.statusCode}`)),
              ),
            );
            return;
          }

          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => finish(() => resolve(body)));
          response.on("close", () => finish(() => resolve(body)));
        },
      );

      request.setTimeout(this.timeoutMs, () => {
        request.destroy();
        finish(() =>
          reject(new Error(`请求超时（>${Math.round(this.timeoutMs / 1000)} 秒）`)),
        );
      });

      request.on("error", (error) => finish(() => reject(error)));
      request.end();
    });
  }

  /** 从 rate_limit 对象里提取 primary 或 secondary 槽位，字段命名逐一兼容。 */
  private extractWindowFromRateLimit(
    rateLimit: WhamUsageRateLimit | undefined,
    kind: "primary" | "secondary",
  ): QuotaWindow | undefined {
    if (!rateLimit) {
      return undefined;
    }

    let raw: WhamUsageWindow | undefined;

    if (kind === "primary") {
      raw =
        rateLimit.five_hour ??
        rateLimit.five_hour_limit ??
        rateLimit.five_hour_rate_limit ??
        rateLimit.primary ??
        rateLimit.primary_window;
    } else {
      raw =
        rateLimit.weekly ??
        rateLimit.weekly_limit ??
        rateLimit.weekly_rate_limit ??
        rateLimit.secondary ??
        rateLimit.secondary_window;
    }

    if (!raw) {
      return undefined;
    }

    // 某些情况下真正的数据嵌套在 primary_window / secondary_window 里
    const entry = raw.primary_window ?? raw.secondary_window ?? raw;

    return this.parseWindowEntry(entry, kind);
  }

  private parseWindowEntry(entry: WhamUsageWindow, kind: "primary" | "secondary"): QuotaWindow | undefined {
    // 计算 availablePercent
    let availablePercent: number | undefined;

    if (typeof entry.percent_left === "number") {
      availablePercent = clampPercent(entry.percent_left);
    } else if (typeof entry.remaining_percent === "number") {
      availablePercent = clampPercent(entry.remaining_percent);
    } else if (typeof entry.used_percent === "number") {
      availablePercent = clampPercent(100 - entry.used_percent);
    }

    if (availablePercent === undefined) {
      return undefined;
    }

    const usedPercent = clampPercent(100 - availablePercent);

    // 解析 resetAfterSeconds
    let resetAfterSeconds: number | undefined;
    if (typeof entry.reset_after_seconds === "number" && entry.reset_after_seconds > 0) {
      resetAfterSeconds = Math.round(entry.reset_after_seconds);
    } else {
      const resetRaw = entry.reset_time_ms ?? entry.reset_at;
      if (typeof resetRaw === "number" && resetRaw > 0) {
        // OpenAI 接口时间戳单位不固定：> 1e11 是毫秒，否则是秒
        const resetEpochSec = resetRaw > 1e11 ? resetRaw / 1000 : resetRaw;
        const diffSec = Math.round(resetEpochSec - Date.now() / 1000);
        if (diffSec > 0) {
          resetAfterSeconds = diffSec;
        }
      }
    }

    return {
      usedPercent,
      availablePercent,
      windowMinutes: this.getWindowMinutes(entry, kind),
      resetAfterSeconds,
    };
  }

  private getWindowMinutes(entry: WhamUsageWindow, kind: "primary" | "secondary"): number {
    if (typeof entry.limit_window_seconds === "number" && entry.limit_window_seconds > 0) {
      return Math.round(entry.limit_window_seconds / 60);
    }

    // 降级：旧接口没有窗口长度时，沿用其原有 primary/secondary 语义。
    return kind === "primary" ? 5 * 60 : 7 * 24 * 60;
  }
}
