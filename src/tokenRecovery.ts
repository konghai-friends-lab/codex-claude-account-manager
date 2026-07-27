import * as https from "node:https";
import { AuthData } from "./types";

const OPENAI_AUTH_REFRESH_URL = "https://auth0.openai.com/oauth/token";
const OPENAI_CHATGPT_IOS_CLIENT_ID = "pdlLIX2Y72MIl2rhLhTE9VV9bN905kBh";
const OPENAI_CHATGPT_IOS_REDIRECT_URI = "com.openai.chat://auth0.openai.com/ios/com.openai.chat/callback";

interface RefreshResponsePayload {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJwt(token: string | undefined): Record<string, unknown> {
  if (!token) {
    return {};
  }

  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return {};
    }

    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getDefaultOrganization(authPayload: Record<string, unknown> | undefined): {
  id?: string;
  title?: string;
} {
  const directId =
    asNonEmptyString(authPayload?.selected_organization_id) ??
    asNonEmptyString(authPayload?.default_organization_id);
  const organizations = Array.isArray(authPayload?.organizations)
    ? authPayload.organizations
    : [];

  if (directId) {
    const match = organizations.find(
      (organization) => typeof organization === "object" && organization !== null && asNonEmptyString((organization as Record<string, unknown>).id) === directId,
    ) as Record<string, unknown> | undefined;

    return {
      id: directId,
      title: asNonEmptyString(match?.title),
    };
  }

  if (organizations.length === 0) {
    return {};
  }

  const selected = (
    organizations.find(
      (organization) => typeof organization === "object" && organization !== null && (organization as Record<string, unknown>).is_default,
    ) ?? organizations[0]
  ) as Record<string, unknown>;

  return {
    id: asNonEmptyString(selected?.id),
    title: asNonEmptyString(selected?.title),
  };
}

function buildRefreshedAuthData(baseAuthData: AuthData, payload: RefreshResponsePayload): AuthData {
  const nextAccessToken = asNonEmptyString(payload.access_token);
  if (!nextAccessToken) {
    throw new Error("刷新响应里没有 access token");
  }

  const nextIdToken = asNonEmptyString(payload.id_token) ?? baseAuthData.idToken;
  const nextRefreshToken = asNonEmptyString(payload.refresh_token) ?? baseAuthData.refreshToken;
  const authJson =
    baseAuthData.authJson && typeof baseAuthData.authJson === "object"
      ? JSON.parse(JSON.stringify(baseAuthData.authJson))
      : {};

  if (!authJson.tokens || typeof authJson.tokens !== "object") {
    authJson.tokens = {};
  }

  authJson.tokens.id_token = nextIdToken;
  authJson.tokens.access_token = nextAccessToken;
  authJson.tokens.refresh_token = nextRefreshToken;

  if (baseAuthData.accountId) {
    authJson.tokens.account_id = baseAuthData.accountId;
  }

  const idTokenPayload = parseJwt(nextIdToken);
  const authPayload = idTokenPayload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const defaultOrganization = getDefaultOrganization(authPayload);

  return {
    ...baseAuthData,
    idToken: nextIdToken,
    accessToken: nextAccessToken,
    refreshToken: nextRefreshToken,
    defaultOrganizationId: defaultOrganization.id ?? baseAuthData.defaultOrganizationId,
    defaultOrganizationTitle: defaultOrganization.title ?? baseAuthData.defaultOrganizationTitle,
    chatgptUserId: asNonEmptyString(authPayload?.chatgpt_user_id) ?? baseAuthData.chatgptUserId,
    userId: asNonEmptyString(authPayload?.user_id) ?? baseAuthData.userId,
    subject: asNonEmptyString(idTokenPayload.sub) ?? baseAuthData.subject,
    email: asNonEmptyString(idTokenPayload.email) ?? baseAuthData.email,
    planType: asNonEmptyString(authPayload?.chatgpt_plan_type) ?? baseAuthData.planType,
    authJson,
  };
}

/**
 * 判断错误是否属于"不可恢复的认证错误"——无论是 session 被吊销还是 token 过期，
 * 自动恢复（refresh token 换新）都不可能成功，不应尝试，应引导用户重新登录。
 */
export function isUnrecoverableAuthError(error: string | undefined): boolean {
  const normalized = String(error || "").toLowerCase();
  return ["token_revoked", "token_invalidated", "invalidated oauth token", "token_expired"].some(
    (keyword) => normalized.includes(keyword),
  );
}

/**
 * 判断错误是否属于"session 已被服务端主动吊销"类型。
 * token_revoked / token_invalidated 表示整个 session 被销毁，
 * refresh token 同步失效，用 refresh token 换新 access token 也会失败，
 * 不应尝试自动恢复，应引导用户重新登录后导入。
 */
export function isSessionRevokedError(error: string | undefined): boolean {
  const normalized = String(error || "").toLowerCase();
  return ["token_revoked", "token_invalidated", "invalidated oauth token"].some(
    (keyword) => normalized.includes(keyword),
  );
}

/**
 * 判断错误是否属于"access token 已过期且自动恢复失败"类型。
 * token_expired 时 refresh token 可能也过期了，自动恢复无意义，应引导用户重新登录。
 */
export function isTokenExpiredAndUnrecoverableError(error: string | undefined): boolean {
  const normalized = String(error || "").toLowerCase();
  return normalized.includes("token_expired");
}

export function shouldAttemptTokenRecovery(authData: AuthData, statusCode: number | undefined, error: string | undefined): boolean {
  if (!authData.refreshToken) {
    return false;
  }

  // 不可恢复的认证错误（session 被吊销 / token 过期），refresh 也必然失败，不走恢复流程
  if (isUnrecoverableAuthError(error)) {
    return false;
  }

  if (statusCode === 401 || statusCode === 403) {
    return true;
  }

  const normalizedError = String(error || "").toLowerCase();
  return ["401", "403", "unauthorized", "forbidden", "expired", "invalid token", "invalid_token"].some((keyword) => normalizedError.includes(keyword));
}

export class CodexTokenRecoveryClient {
  constructor(
    private readonly authData: AuthData,
    private readonly timeoutMs: number,
  ) {}

  async refreshAuthData(): Promise<AuthData> {
    if (!this.authData.refreshToken) {
      throw new Error("当前账号没有 refresh token，无法自动恢复");
    }

    const payload = JSON.stringify({
      redirect_uri: OPENAI_CHATGPT_IOS_REDIRECT_URI,
      grant_type: "refresh_token",
      client_id: OPENAI_CHATGPT_IOS_CLIENT_ID,
      refresh_token: this.authData.refreshToken,
    });

    const response = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
      const request = https.request(
        OPENAI_AUTH_REFRESH_URL,
        {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            "User-Agent": "codex-account-manager/0.0.41",











          },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            if (body.length < 8192) {
              body += chunk;
            }
          });
          response.on("end", () => resolve({ statusCode: response.statusCode, body }));
          response.on("close", () => resolve({ statusCode: response.statusCode, body }));
        },
      );

      request.setTimeout(this.timeoutMs, () => {
        request.destroy();
        reject(new Error(`刷新令牌请求超时（>${Math.round(this.timeoutMs / 1000)} 秒）`));
      });

      request.on("error", (error) => reject(error));
      request.write(payload);
      request.end();
    });

    if ((response.statusCode ?? 500) >= 400) {
      throw new Error(`刷新令牌失败（HTTP ${response.statusCode ?? 500}）${response.body ? `: ${response.body}` : ""}`);
    }

    let parsed: RefreshResponsePayload;
    try {
      parsed = JSON.parse(response.body) as RefreshResponsePayload;
    } catch {
      throw new Error("刷新令牌接口返回了无法解析的内容");
    }

    return buildRefreshedAuthData(this.authData, parsed);
  }
}
