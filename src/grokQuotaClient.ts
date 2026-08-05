import * as https from "node:https";
import { URL } from "node:url";
import { GrokAuthData } from "./grokAuth";
import { GrokPeriodSnapshot, QuotaWindow } from "./types";

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

interface BillingPeriod {
  type?: string;
  start?: string;
  end?: string;
}

interface ProductUsage {
  product?: string;
  usagePercent?: number;
  usage_percent?: number;
}

interface BillingConfig {
  currentPeriod?: BillingPeriod;
  current_period?: BillingPeriod;
  creditUsagePercent?: number;
  credit_usage_percent?: number;
  productUsage?: ProductUsage[];
  product_usage?: ProductUsage[];
  billingPeriodStart?: string;
  billing_period_start?: string;
  billingPeriodEnd?: string;
  billing_period_end?: string;
}

interface BillingResponse {
  config?: BillingConfig;
}

export interface GrokBillingFetchResult {
  body: string;
  statusCode: number;
}

/** HTTP 失败时携带 statusCode，便于写入 snapshot */
export class GrokBillingHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, detail?: string) {
    const suffix = detail?.trim() ? `: ${detail.trim().slice(0, 200)}` : "";
    super(`Grok billing HTTP ${statusCode}${suffix}`);
    this.name = "GrokBillingHttpError";
    this.statusCode = statusCode;
  }
}

const GROK_BUILD_PRODUCT = "GrokBuild";
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const MAX_RESPONSE_BODY_BYTES = 256 * 1024;

function periodLabelFromWindowMinutes(windowMinutes: number | undefined): string | undefined {
  if (windowMinutes === undefined || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return undefined;
  }
  if (windowMinutes >= 6 * 24 * 60 && windowMinutes <= 8 * 24 * 60) {
    return "7d";
  }
  if (windowMinutes >= 28 * 24 * 60 && windowMinutes <= 32 * 24 * 60) {
    return "30d";
  }
  if (windowMinutes >= 23 * 60 && windowMinutes <= 25 * 60) {
    return "1d";
  }
  if (windowMinutes < 24 * 60) {
    const hours = Math.max(1, Math.round(windowMinutes / 60));
    return `${hours}h`;
  }
  const days = Math.max(1, Math.round(windowMinutes / (24 * 60)));
  return `${days}d`;
}

/**
 * 周期类型 → 展示标签。
 * 优先匹配已知枚举（WEEKLY/MONTHLY/DAILY），避免 BIWEEKLY 等子串误伤。
 */
export function periodLabelFromType(periodType: string | undefined, windowMinutes?: number): string | undefined {
  const normalized = (periodType ?? "").toUpperCase();

  // 复合周期先交给窗口时长，避免 includes("WEEK") 误伤 BIWEEKLY
  if (normalized.includes("BIWEEKLY") || normalized.includes("BIMONTHLY") || normalized.includes("FORTNIGHT")) {
    return periodLabelFromWindowMinutes(windowMinutes);
  }

  if (normalized.includes("WEEKLY") || /(?:^|_)WEEK(?:_|$)/.test(normalized)) {
    return "7d";
  }
  if (normalized.includes("MONTHLY") || /(?:^|_)MONTH(?:_|$)/.test(normalized)) {
    return "30d";
  }
  if (normalized.includes("DAILY") || /(?:^|_)DAY(?:_|$)/.test(normalized)) {
    return "1d";
  }

  return periodLabelFromWindowMinutes(windowMinutes);
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (!value || typeof value !== "string") {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function coerceUsagePercent(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // 0–1 小数按比例缩放；0–100 原样
    if (raw >= 0 && raw <= 1) {
      return clampPercent(raw * 100);
    }
    return clampPercent(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.trim().replace(/%$/, ""));
    if (Number.isFinite(n)) {
      return coerceUsagePercent(n);
    }
  }
  return undefined;
}

/**
 * 周期已用百分比，对齐 Grok TUI `/usage` 的「Weekly limit」。
 *
 * 优先 `creditUsagePercent`（总周额度，与 /usage 一致）；
 * 缺失时再回退 `productUsage[GrokBuild].usagePercent`。
 * 注意：GrokBuild 分项用量往往略低于总周额度（其它产品也会占周额度）。
 */
function pickUsagePercent(config: BillingConfig | undefined): { usedPercent: number; product?: string } | undefined {
  if (!config) {
    return undefined;
  }

  const overall = coerceUsagePercent(config.creditUsagePercent ?? config.credit_usage_percent);
  if (overall !== undefined) {
    return { usedPercent: overall, product: "weekly" };
  }

  const products = config.productUsage ?? config.product_usage ?? [];
  const build = products.find((item) => {
    const name = (item.product ?? "").toLowerCase().replace(/[\s_-]+/g, "");
    return name === "grokbuild";
  });

  if (build) {
    const used = coerceUsagePercent(build.usagePercent ?? build.usage_percent);
    if (used !== undefined) {
      return { usedPercent: used, product: build.product ?? GROK_BUILD_PRODUCT };
    }
  }

  return undefined;
}

export function parseBillingConfigToSnapshot(
  config: BillingConfig | undefined,
  fetchedAt: string,
  statusCode = 200,
  nowMs = Date.now(),
): GrokPeriodSnapshot {
  const usage = pickUsagePercent(config);
  if (!usage) {
    return {
      fetchedAt,
      statusCode,
      error: "未从 Grok billing 解析到周期用量",
    };
  }

  const period = config?.currentPeriod ?? config?.current_period;
  const periodEnd = period?.end ?? config?.billingPeriodEnd ?? config?.billing_period_end;
  const periodStart = period?.start ?? config?.billingPeriodStart ?? config?.billing_period_start;
  const endMs = parseIsoMs(periodEnd);
  const startMs = parseIsoMs(periodStart);

  let windowMinutes: number | undefined;
  if (startMs !== undefined && endMs !== undefined && endMs > startMs) {
    windowMinutes = Math.round((endMs - startMs) / 60_000);
  }

  let resetAfterSeconds: number | undefined;
  if (endMs !== undefined) {
    resetAfterSeconds = Math.max(0, Math.round((endMs - nowMs) / 1000));
  }

  const availablePercent = clampPercent(100 - usage.usedPercent);
  const window: QuotaWindow = {
    usedPercent: usage.usedPercent,
    availablePercent,
    windowMinutes,
    resetAfterSeconds,
  };

  return {
    window,
    periodLabel: periodLabelFromType(period?.type, windowMinutes),
    product: usage.product,
    periodEndAt: periodEnd && endMs !== undefined ? new Date(endMs).toISOString() : undefined,
    fetchedAt,
    statusCode,
  };
}

export class GrokQuotaClient {
  constructor(
    private readonly authData: GrokAuthData,
    private readonly timeoutMs: number,
  ) {}

  async fetchPeriodRemaining(): Promise<GrokPeriodSnapshot> {
    const fetchedAt = new Date().toISOString();

    try {
      const { body, statusCode } = await this.fetchBillingCredits();
      let data: BillingResponse;
      try {
        data = JSON.parse(body) as BillingResponse;
      } catch {
        return {
          fetchedAt,
          statusCode,
          error: "Grok billing 响应不是合法 JSON",
        };
      }
      return parseBillingConfigToSnapshot(data.config, fetchedAt, statusCode);
    } catch (error) {
      if (error instanceof GrokBillingHttpError) {
        return {
          fetchedAt,
          statusCode: error.statusCode,
          error: error.message,
        };
      }
      return {
        fetchedAt,
        error: error instanceof Error ? error.message : "刷新 Grok 周期额度失败",
      };
    }
  }

  /**
   * 可测试注入点。返回 body + 真实 statusCode。
   * 失败抛 GrokBillingHttpError 或 Error。
   */
  async fetchBillingCredits(): Promise<GrokBillingFetchResult> {
    return new Promise<GrokBillingFetchResult>((resolve, reject) => {
      const requestUrl = new URL(BILLING_URL);

      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.authData.accessToken}`,
        Accept: "application/json",
        "User-Agent": "codex-account-manager/0.0.41",
        "x-grok-client-mode": "cli",
        "Cache-Control": "no-cache",
      };

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
          const statusCode = response.statusCode ?? 500;
          let oversized = false;

          const appendChunk = (chunk: string, target: "ok" | "err"): void => {
            if (oversized) {
              return;
            }
            if (target === "ok") {
              body += chunk;
              if (body.length > MAX_RESPONSE_BODY_BYTES) {
                oversized = true;
                finish(() => {
                  request.destroy();
                  reject(new Error("Grok billing 响应过大"));
                });
              }
            }
          };

          if (statusCode >= 400) {
            let errBody = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
              if (errBody.length < 2048) {
                errBody += chunk;
              }
            });
            const rejectHttp = (): void => {
              finish(() => {
                // 不把完整 body 塞进错误（可能含敏感信息）；只附极短摘要
                const snippet = errBody.replace(/\s+/g, " ").trim().slice(0, 120);
                reject(new GrokBillingHttpError(statusCode, snippet || undefined));
              });
            };
            response.on("end", rejectHttp);
            response.on("close", rejectHttp);
            response.on("error", (error) => {
              finish(() => reject(error));
            });
            return;
          }

          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            appendChunk(chunk, "ok");
          });
          response.on("end", () => {
            finish(() => resolve({ body, statusCode }));
          });
          response.on("close", () => {
            finish(() => resolve({ body, statusCode }));
          });
          response.on("error", (error) => {
            finish(() => reject(error));
          });
        },
      );

      request.setTimeout(this.timeoutMs, () => {
        finish(() => {
          request.destroy();
          reject(new Error(`Grok billing 请求超时（${this.timeoutMs}ms）`));
        });
      });

      request.on("error", (error) => {
        finish(() => reject(error));
      });

      request.end();
    });
  }
}
