import * as https from "node:https";
import { URL } from "node:url";
import { ClaudeAuthData } from "./claudeAuth";
import { ClaudeUsageSnapshot, QuotaWindow } from "./types";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const MAX_RESPONSE_BODY_BYTES = 256 * 1024;
const MAX_ERROR_BODY_BYTES = 2048;
const MAX_ERROR_SNIPPET_CHARS = 120;

/** 窗口名 → 标称时长（分钟）。接口不返回周期起点，无法像 Grok 那样由起止相减得出 */
const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 7 * 24 * 60;

interface UsageWindowPayload {
  utilization?: unknown;
  resets_at?: unknown;
}

interface UsageResponse {
  five_hour?: UsageWindowPayload;
  seven_day?: UsageWindowPayload;
}

/** HTTP 失败时携带 statusCode，便于写入 snapshot */
export class ClaudeUsageHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, detail?: string) {
    const suffix = detail?.trim() ? `: ${detail.trim().slice(0, MAX_ERROR_SNIPPET_CHARS)}` : "";
    super(`Claude usage HTTP ${statusCode}${suffix}`);
    this.name = "ClaudeUsageHttpError";
    this.statusCode = statusCode;
  }
}

export interface ClaudeUsageFetchResult {
  body: string;
  statusCode: number;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * 解析 utilization（已用百分比，0–100 量纲）。
 *
 * 刻意不复用 Grok 的 coerceUsagePercent：那个会把 [0,1] 的值乘 100。
 * CC 的量纲已实测为 0–100，套用该启发式会把真实的 0.5%（还剩 99.5%）
 * 变成「已用 50%」，把 1.0 变成「已用 100% → 剩 0%」——正是本项目
 * 明令禁止的伪造 0%。它恰好在账号最健康时出错。
 */
function parseUtilization(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return clampPercent(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const numeric = Number(raw.trim().replace(/%$/, ""));
    if (Number.isFinite(numeric)) {
      return clampPercent(numeric);
    }
  }
  return undefined;
}

function parseIsoMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

interface ParsedWindow {
  window: QuotaWindow;
  resetAt?: string;
}

/**
 * 解析单个窗口。utilization 无法解析时返回 undefined（整窗省略），
 * 绝不退化成 0 或 100——缺失窗口画成空条会被误读为「真的没额度了」。
 */
function parseWindow(
  payload: UsageWindowPayload | undefined,
  windowMinutes: number,
  nowMs: number,
): ParsedWindow | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const usedPercent = parseUtilization(payload.utilization);
  if (usedPercent === undefined) {
    return undefined;
  }

  const endMs = parseIsoMs(payload.resets_at);
  const window: QuotaWindow = {
    usedPercent,
    availablePercent: clampPercent(100 - usedPercent),
    windowMinutes,
    // 仅作为没有绝对时间时的兜底；权威来源是下面的 resetAt
    resetAfterSeconds: endMs !== undefined ? Math.max(0, Math.round((endMs - nowMs) / 1000)) : undefined,
  };

  return {
    window,
    resetAt: endMs !== undefined ? new Date(endMs).toISOString() : undefined,
  };
}

/**
 * 把 usage 响应解析成快照。
 * 按字段名直接读 five_hour / seven_day：这两个键是自描述的，不存在
 * Codex /wham/usage 那种 primary/secondary 槽位歧义，因此不需要
 * 按时长归类——那样反而会引入新的失败模式。
 */
export function parseUsageResponseToSnapshot(
  data: UsageResponse | undefined,
  fetchedAt: string,
  statusCode = 200,
  nowMs = Date.now(),
): ClaudeUsageSnapshot {
  const fiveHour = parseWindow(data?.five_hour, FIVE_HOUR_MINUTES, nowMs);
  const sevenDay = parseWindow(data?.seven_day, SEVEN_DAY_MINUTES, nowMs);

  if (!fiveHour && !sevenDay) {
    return {
      fetchedAt,
      statusCode,
      error: "未从 Claude usage 解析到用量窗口",
    };
  }

  return {
    fiveHour: fiveHour?.window,
    fiveHourResetAt: fiveHour?.resetAt,
    sevenDay: sevenDay?.window,
    sevenDayResetAt: sevenDay?.resetAt,
    fetchedAt,
    statusCode,
    // 只有一个窗口时也记原因，便于展示层说明另一个为何缺失
    error: fiveHour && sevenDay ? undefined : "部分用量窗口不可用",
  };
}

/**
 * 生成一次刷新的 CC 快照，失败一律降级为占位快照。
 *
 * 与 VS Code API 解耦，因此可以直接单测「失败时是否真的写了占位」——
 * 这是写入顺序属性，纯展示函数的测试观察不到。
 */
export async function buildClaudeSnapshot(
  loadAuth: () => Promise<ClaudeAuthData | null>,
  createClient: (auth: ClaudeAuthData) => { fetchUsage: () => Promise<ClaudeUsageSnapshot> },
  nowIso = new Date().toISOString(),
): Promise<ClaudeUsageSnapshot> {
  let auth: ClaudeAuthData | null = null;
  try {
    auth = await loadAuth();
  } catch {
    // 凭据读取本不该抛错；即便抛了也只降级，不打断刷新流程
    return { fetchedAt: nowIso, error: "读取 Claude 凭据失败" };
  }

  if (!auth) {
    return { fetchedAt: nowIso, error: "未登录" };
  }

  try {
    return await createClient(auth).fetchUsage();
  } catch (error) {
    return {
      fetchedAt: nowIso,
      error: error instanceof Error ? error.message : "刷新 Claude 用量失败",
    };
  }
}

export class ClaudeQuotaClient {
  constructor(
    private readonly authData: ClaudeAuthData,
    private readonly timeoutMs: number,
  ) {}

  async fetchUsage(): Promise<ClaudeUsageSnapshot> {
    const fetchedAt = new Date().toISOString();

    try {
      const { body, statusCode } = await this.requestUsage();
      let data: UsageResponse;
      try {
        data = JSON.parse(body) as UsageResponse;
      } catch {
        return {
          fetchedAt,
          statusCode,
          error: "Claude usage 响应不是合法 JSON",
        };
      }
      return parseUsageResponseToSnapshot(data, fetchedAt, statusCode);
    } catch (error) {
      if (error instanceof ClaudeUsageHttpError) {
        return {
          fetchedAt,
          statusCode: error.statusCode,
          error: error.message,
        };
      }
      return {
        fetchedAt,
        error: error instanceof Error ? error.message : "刷新 Claude 用量失败",
      };
    }
  }

  /**
   * 可测试注入点。返回 body + 真实 statusCode。
   * 失败抛 ClaudeUsageHttpError 或 Error。
   */
  async requestUsage(): Promise<ClaudeUsageFetchResult> {
    return new Promise<ClaudeUsageFetchResult>((resolve, reject) => {
      const requestUrl = new URL(USAGE_URL);

      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.authData.accessToken}`,
        Accept: "application/json",
        "User-Agent": "codex-account-manager",
        "anthropic-beta": OAUTH_BETA_HEADER,
        "Cache-Control": "no-cache",
      };

      let settled = false;
      let deadline: NodeJS.Timeout | undefined;
      const finish = (handler: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (deadline) {
          clearTimeout(deadline);
          deadline = undefined;
        }
        handler();
      };

      const request = https.request(requestUrl, { method: "GET", headers }, (response) => {
        const statusCode = response.statusCode ?? 500;
        response.setEncoding("utf8");

        if (statusCode >= 400) {
          let errBody = "";
          response.on("data", (chunk: string) => {
            // 在追加后截断：只判断追加前的长度，
            // 单个超大 chunk 仍会被整块接进来
            if (errBody.length < MAX_ERROR_BODY_BYTES) {
              errBody = (errBody + chunk).slice(0, MAX_ERROR_BODY_BYTES);
            }
          });
          const rejectHttp = (): void => {
            finish(() => {
              // 不把完整 body 塞进错误（可能含敏感信息）；只附极短摘要。
              // 同时抹掉尖括号：该摘要最终会进入 supportHtml=true 的
              // tooltip，而 escapeMarkdown 不转义 '<'，第三方响应体里的
              // 标签会被当作实时标记渲染。
              const snippet = errBody.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_SNIPPET_CHARS);
              reject(new ClaudeUsageHttpError(statusCode, snippet || undefined));
            });
          };
          response.on("end", rejectHttp);
          response.on("close", rejectHttp);
          response.on("error", (error) => {
            finish(() => reject(error));
          });
          return;
        }

        let body = "";
        let oversized = false;
        response.on("data", (chunk: string) => {
          if (oversized) {
            return;
          }
          body += chunk;
          if (body.length > MAX_RESPONSE_BODY_BYTES) {
            oversized = true;
            // destroy 放在 finish 外：若其它路径已先 settle，
            // 放在回调里会被 settled 守卫跳过，socket 就泄漏了
            request.destroy();
            finish(() => {
              reject(new Error("Claude usage 响应过大"));
            });
          }
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
      });

      // request.setTimeout 只是「空闲超时」：只要对端持续滴入字节就会被不断重置，
      // 慢速滴流响应可以让这个 Promise 永远挂着。而它挂着就会一直占住
      // refreshAllQuotas 的 refreshing 标志，导致 Codex 与 Grok 也停止刷新。
      // 因此必须另设一个覆盖 DNS/连接/响应体全过程的端到端截止时间。
      request.setTimeout(this.timeoutMs, () => {
        request.destroy();
        finish(() => {
          reject(new Error(`Claude usage 请求超时（${this.timeoutMs}ms）`));
        });
      });

      deadline = setTimeout(() => {
        request.destroy();
        finish(() => {
          reject(new Error(`Claude usage 请求超时（${this.timeoutMs}ms）`));
        });
      }, this.timeoutMs);
      // 不要让这个定时器把 Node 进程吊住
      deadline.unref?.();

      request.on("error", (error) => {
        finish(() => reject(error));
      });

      request.end();
    });
  }
}
