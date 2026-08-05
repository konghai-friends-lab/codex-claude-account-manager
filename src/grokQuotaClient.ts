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

const GROK_BUILD_PRODUCT = "GrokBuild";
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

/** 周期类型 → 展示标签；未知时返回 undefined（不硬编码假 7d） */
export function periodLabelFromType(periodType: string | undefined, windowMinutes?: number): string | undefined {
  const normalized = (periodType ?? "").toUpperCase();
  if (normalized.includes("WEEKLY") || normalized.includes("WEEK")) {
    return "7d";
  }
  if (normalized.includes("MONTHLY") || normalized.includes("MONTH")) {
    return "30d";
  }
  if (normalized.includes("DAILY") || normalized.includes("DAY")) {
    return "1d";
  }

  if (windowMinutes !== undefined && Number.isFinite(windowMinutes) && windowMinutes > 0) {
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

  return undefined;
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (!value || typeof value !== "string") {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function pickUsagePercent(config: BillingConfig | undefined): { usedPercent: number; product?: string } | undefined {
  if (!config) {
    return undefined;
  }

  const products = config.productUsage ?? config.product_usage ?? [];
  const build = products.find((item) => {
    const name = (item.product ?? "").toLowerCase();
    return name === "grokbuild" || name === "grok_build" || name === "grok-build";
  });

  if (build) {
    const raw = build.usagePercent ?? build.usage_percent;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return { usedPercent: clampPercent(raw), product: build.product ?? GROK_BUILD_PRODUCT };
    }
  }

  const overall = config.creditUsagePercent ?? config.credit_usage_percent;
  if (typeof overall === "number" && Number.isFinite(overall)) {
    return { usedPercent: clampPercent(overall), product: "credits" };
  }

  return undefined;
}

export function parseBillingConfigToSnapshot(
  config: BillingConfig | undefined,
  fetchedAt: string,
  statusCode = 200,
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
    resetAfterSeconds = Math.max(0, Math.round((endMs - Date.now()) / 1000));
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
      const body = await this.fetchBillingCredits();
      const data = JSON.parse(body) as BillingResponse;
      return parseBillingConfigToSnapshot(data.config, fetchedAt, 200);
    } catch (error) {
      return {
        fetchedAt,
        error: error instanceof Error ? error.message : "刷新 Grok 周期额度失败",
      };
    }
  }

  /** 可测试注入点（与 CodexQuotaClient.fetchWhamUsage 相同约定） */
  async fetchBillingCredits(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
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

          if (statusCode >= 400) {
            let errBody = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
              if (errBody.length < 2048) {
                errBody += chunk;
              }
            });
            response.on("end", () => {
              finish(() => {
                reject(new Error(`Grok billing HTTP ${statusCode}`));
              });
            });
            response.on("error", (error) => {
              finish(() => reject(error));
            });
            return;
          }

          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => {
            finish(() => resolve(body));
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
