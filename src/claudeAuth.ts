import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ClaudeAuthData {
  accessToken: string;
  /** 订阅类型，如 max / pro；仅供展示，缺失不影响取数 */
  subscriptionType?: string;
  /** 过期时间（epoch 毫秒）。实测为 number，不是 ISO 字符串 */
  expiresAt?: number;
}

/** Keychain 服务名：Claude Code CLI 自己创建的通用密码条目 */
const KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * 读取凭据的超时（毫秒）。
 * 本地 Keychain 读取本应瞬时返回；设超时是为了防止 Keychain 授权弹窗
 * 无限期阻塞刷新路径——那会连带冻结 Codex 与 Grok 的刷新。
 */
const CREDENTIAL_READ_TIMEOUT_MS = 3000;

const MAX_CREDENTIAL_BYTES = 64 * 1024;

function getDefaultClaudeCredentialsPath(): string {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

/**
 * 解析 expiresAt。
 * 实测 Claude Code 写的是 epoch 毫秒 number（如 1785935407201），
 * 不是 Grok 那种 ISO 字符串，所以不能照搬 grokAuth 的 Date.parse(string)。
 * 返回 undefined 表示「无法判断」，调用方必须按「可用」处理。
 */
function parseExpiresMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // 时间戳单位不固定：> 1e11 视为毫秒，否则视为秒
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value.trim());
    if (Number.isFinite(ms)) {
      return ms;
    }
    const numeric = Number(value.trim());
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > 1e11 ? numeric : numeric * 1000;
    }
  }
  return undefined;
}

/**
 * 从已解析的凭据对象中取出当前登录条目。
 * 与 Grok 不同：CC 只有单个 claudeAiOauth 对象，不需要多身份挑选。
 * 失败返回 null，绝不抛错、绝不记录令牌内容。导出供单测。
 */
export function selectClaudeAuthFromParsed(parsed: unknown, nowMs = Date.now()): ClaudeAuthData | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) {
    return null;
  }

  const record = oauth as Record<string, unknown>;
  const accessToken = typeof record.accessToken === "string" ? record.accessToken.trim() : "";
  if (!accessToken) {
    return null;
  }

  // 已过期则视为未登录：避免明知会 401 还发一次请求。
  // 注意这只是省一次请求的优化，不是授权判断——服务端的 401 才是权威。
  // 单位/类型无法识别时按「可用」处理，让失败方向偏安全：
  // 最多多跑一次请求，而不是永久性假「未登录」。
  const expiresMs = parseExpiresMs(record.expiresAt);
  if (expiresMs !== undefined && expiresMs <= nowMs) {
    return null;
  }

  return {
    accessToken,
    subscriptionType: typeof record.subscriptionType === "string" ? record.subscriptionType : undefined,
    expiresAt: expiresMs,
  };
}

/** macOS：从 Keychain 读取凭据 JSON。失败返回 null，不抛错 */
function readFromKeychain(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      {
        encoding: "utf8",
        timeout: CREDENTIAL_READ_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: MAX_CREDENTIAL_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        // 出错时整个丢弃 error 对象：Node 会把子进程输出塞进 error.message，
        // 格式化它就等于把令牌写进日志。
        if (error) {
          resolve(null);
          return;
        }
        const raw = String(stdout || "").trim();
        resolve(raw || null);
      },
    );
  });
}

/** 回退路径：读取 ~/.claude/.credentials.json（Windows/Linux 的官方位置，未实测） */
function readFromFile(credentialsPath: string): string | null {
  try {
    const raw = fs.readFileSync(credentialsPath, "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * 只读加载本机 Claude Code 凭据。
 * macOS 走 Keychain（已实测），其余平台或 Keychain 失败时回退文件。
 * 失败返回 null，不抛错、不写回、不进 SecretStorage。
 */
export async function loadClaudeAuth(
  credentialsPath = getDefaultClaudeCredentialsPath(),
  nowMs = Date.now(),
  options: { useKeychain?: boolean } = {},
): Promise<ClaudeAuthData | null> {
  let raw: string | null = null;

  // useKeychain 可显式关掉，便于在 macOS 上单测文件回退路径本身；
  // 生产调用不传该参数，行为与之前完全一致。
  const useKeychain = options.useKeychain ?? process.platform === "darwin";
  if (useKeychain) {
    raw = await readFromKeychain();
  }
  if (!raw) {
    raw = readFromFile(credentialsPath);
  }
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return selectClaudeAuthFromParsed(parsed, nowMs);
}
