import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as vscode from "vscode";
import { AuthData } from "./types";

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJwt(token: string | undefined): Record<string, any> {
  if (!token) {
    return {};
  }

  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return {};
    }

    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(payload) as Record<string, any>;
  } catch {
    return {};
  }
}

function getDefaultOrganization(authPayload: Record<string, any> | undefined): {
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
    const match = organizations.find((org: Record<string, any>) => asNonEmptyString(org?.id) === directId);
    return {
      id: directId,
      title: asNonEmptyString(match?.title),
    };
  }

  if (organizations.length === 0) {
    return {};
  }

  const selected = organizations.find((org: Record<string, any>) => org?.is_default) ?? organizations[0];
  return {
    id: asNonEmptyString(selected?.id),
    title: asNonEmptyString(selected?.title),
  };
}

export function getDefaultCodexHomePath(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function shouldUseWslAuthPath(): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  return Boolean(
    vscode.workspace
      .getConfiguration("chatgpt")
      .get<boolean>("runCodexInWindowsSubsystemForLinux", false),
  );
}

function resolveWslCodexPath(posixPath: string): string | undefined {
  try {
    const output = execFileSync("wsl.exe", ["sh", "-lc", `wslpath -w ${posixPath}`], {
      encoding: "utf8",
      windowsHide: true,
    });

    const resolved = String(output || "").trim();
    return resolved || undefined;
  } catch {
    return undefined;
  }
}

export function getDefaultCodexAuthPath(): string {
  const localPath = path.join(getDefaultCodexHomePath(), "auth.json");
  if (!shouldUseWslAuthPath()) {
    return localPath;
  }

  return resolveWslCodexPath("~/.codex/auth.json") || localPath;
}

export function getDefaultCodexSessionsPath(): string {
  const localPath = path.join(getDefaultCodexHomePath(), "sessions");
  if (!shouldUseWslAuthPath()) {
    return localPath;
  }

  return resolveWslCodexPath("~/.codex/sessions") || localPath;
}


export async function loadAuthDataFromFile(authPath: string): Promise<AuthData | null> {
  try {
    const content = await fs.promises.readFile(authPath, "utf8");
    const authJson = JSON.parse(content) as Record<string, any>;

    if (!authJson.tokens || typeof authJson.tokens !== "object") {
      return null;
    }

    const tokens = authJson.tokens as Record<string, any>;
    const idToken = asNonEmptyString(tokens.id_token);
    const accessToken = asNonEmptyString(tokens.access_token);

    if (!idToken || !accessToken) {
      return null;
    }

    const idTokenPayload = parseJwt(idToken);
    const authPayload = idTokenPayload["https://api.openai.com/auth"] as Record<string, any> | undefined;
    const defaultOrganization = getDefaultOrganization(authPayload);

    return {
      idToken,
      accessToken,
      refreshToken: asNonEmptyString(tokens.refresh_token),
      accountId: asNonEmptyString(tokens.account_id),
      defaultOrganizationId: defaultOrganization.id,
      defaultOrganizationTitle: defaultOrganization.title,
      chatgptUserId: asNonEmptyString(authPayload?.chatgpt_user_id),
      userId: asNonEmptyString(authPayload?.user_id),
      subject: asNonEmptyString(idTokenPayload.sub),
      email: asNonEmptyString(idTokenPayload.email),
      planType: asNonEmptyString(authPayload?.chatgpt_plan_type),
      authJson,
    };
  } catch {
    return null;
  }
}

export function buildAuthJson(authData: AuthData): string {
  const payload =
    authData.authJson && typeof authData.authJson === "object"
      ? JSON.parse(JSON.stringify(authData.authJson))
      : {};

  if (!payload.tokens || typeof payload.tokens !== "object") {
    payload.tokens = {};
  }

  payload.tokens.id_token = authData.idToken;
  payload.tokens.access_token = authData.accessToken;
  payload.tokens.refresh_token = authData.refreshToken;

  if (authData.accountId) {
    payload.tokens.account_id = authData.accountId;
  }

  return `${JSON.stringify(payload, null, 2)}\n`;
}

export async function syncCodexAuthFile(authPath: string, authData: AuthData): Promise<void> {
  const directory = path.dirname(authPath);
  const tempPath = path.join(directory, `auth.json.tmp.${process.pid}.${Date.now()}`);
  const content = buildAuthJson(authData);

  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(tempPath, content, "utf8");

  try {
    await fs.promises.rename(tempPath, authPath);
  } catch {
    await fs.promises.copyFile(tempPath, authPath);
  } finally {
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // ignore temporary cleanup failures
    }
  }
}

export async function clearCodexAuthFile(authPath: string): Promise<void> {
  try {
    await fs.promises.unlink(authPath);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
    if (errorCode === "ENOENT") {
      return;
    }

    throw error;
  }
}

