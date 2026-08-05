import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface GrokAuthData {
  accessToken: string;
  email?: string;
  userId?: string;
  expiresAt?: string;
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

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  // 形状：{ "https://auth.x.ai::...": { key, email, ... }, ... }
  const entries = Object.values(parsed as Record<string, unknown>);
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (!key) {
      continue;
    }

    return {
      accessToken: key,
      email: typeof record.email === "string" ? record.email : undefined,
      userId: typeof record.user_id === "string" ? record.user_id : undefined,
      expiresAt: typeof record.expires_at === "string" ? record.expires_at : undefined,
    };
  }

  return null;
}
