import * as vscode from "vscode";
import { CodexAccountManager } from "./manager";

let manager: CodexAccountManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    manager = new CodexAccountManager(context);
    context.subscriptions.push(manager);
    await manager.activate();
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    void vscode.window.showErrorMessage(`Codex Account Manager 激活失败：${message}`);
  }
}


export function deactivate(): void {
  manager?.dispose();
  manager = undefined;
}
