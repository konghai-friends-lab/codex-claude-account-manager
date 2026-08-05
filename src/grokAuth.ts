import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface GrokAuthData {
  accessToken: string;
  email?: string;
  userId?: string;
  expiresAt?: string;
}

interface GrokAuthCandidate extends GrokAuthData {
  /** 顶层 identity key（如 https://auth.x.ai::uuid） */
  identityKey: string;
  /** expires_at 毫秒；缺失时为 0（排序靠后） */
  expiresMs: number;
  /** 当前是否未过期（无 expires_at 视为可用） */
  isUnexpired: boolean;
}

function getDefaultGrokHomePath(): string {
  const fromEnv = process.env.GROK_HOME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".grok");
}

export function getDefaultGrokAuthPath(): string {
  return path.join(getDefaultGrokHomePath(), "auth.json");
}

/** 仅接受看起来像 Grok/xAI auth 条目的顶层 key */
export function isGrokAuthIdentityKey(identityKey: string): boolean {
  const key = identityKey.trim().toLowerCase();
  return key.includes("auth.x.ai") || key.includes("accounts.x.ai");
}

function parseExpiresMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * 从已解析的 auth 对象中挑选当前登录条目。
 * 策略：过滤 xAI identity → 优先未过期 → 再取 expires_at 最新；全部过期则 null。
 * 导出供单测。
 */
export function selectGrokAuthFromParsed(parsed: unknown, nowMs = Date.now()): GrokAuthData | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const candidates: GrokAuthCandidate[] = [];

  for (const [identityKey, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isGrokAuthIdentityKey(identityKey)) {
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (!key) {
      continue;
    }

    const expiresAt = typeof record.expires_at === "string" ? record.expires_at : undefined;
    const expiresMs = parseExpiresMs(expiresAt);
    const isUnexpired = expiresMs === undefined || expiresMs > nowMs;

    candidates.push({
      identityKey,
      accessToken: key,
      email: typeof record.email === "string" ? record.email : undefined,
      userId: typeof record.user_id === "string" ? record.user_id : undefined,
      expiresAt,
      expiresMs: expiresMs ?? 0,
      isUnexpired,
    });
  }

  const usable = candidates.filter((c) => c.isUnexpired);
  if (usable.length === 0) {
    return null;
  }

  usable.sort((a, b) => {
    // 有明确 expires 的排前且取最新；无 expires 的作为次选
    if (a.expiresMs !== b.expiresMs) {
      return b.expiresMs - a.expiresMs;
    }
    return a.identityKey.localeCompare(b.identityKey);
  });

  const best = usable[0];
  return {
    accessToken: best.accessToken,
    email: best.email,
    userId: best.userId,
    expiresAt: best.expiresAt,
  };
}

/**
 * 只读解析本机 Grok auth.json。
 * 失败返回 null，不抛错、不记录令牌内容。
 */
export function loadGrokAuthFromFile(authPath = getDefaultGrokAuthPath()): GrokAuthData | null {
  let raw: string;
  try {
    raw = fs.readFileSync(authPath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return selectGrokAuthFromParsed(parsed);
}
