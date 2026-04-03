import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { ensureApiConfig, loadConfig } from "./config.js";
import { appendAssistantTextMessage } from "./utils.js";

export async function withPlaylistConfig(ctx: any) {
  const config = await loadConfig(ctx.cwd);
  ensureApiConfig(config);
  return config;
}

export async function runDescribedCommand(
  pi: ExtensionAPI,
  ctx: any,
  options: {
    args: string;
    usage: string;
    progressMessage: string;
    successMessage: string;
    failurePrefix: string;
    fallbackText: (description: string) => string;
    run: (description: string, ctx: any) => Promise<{ content?: Array<{ type?: string; text?: string }> }>;
  },
) {
  const description = options.args.trim();
  if (!description) {
    ctx.ui.notify(`Usage: ${options.usage}`, "warning");
    return;
  }
  if (!ctx.isIdle()) {
    ctx.ui.notify("Agent is busy. Try again when the current turn finishes.", "warning");
    return;
  }

  try {
    ctx.ui.notify(options.progressMessage, "info");
    const result = await options.run(description, ctx);
    const text = result.content?.find((item) => item.type === "text")?.text ?? options.fallbackText(description);
    appendAssistantTextMessage(pi, ctx, text);
    ctx.ui.notify(text, "info");
    ctx.ui.notify(options.successMessage, "success");
  } catch (error) {
    ctx.ui.notify(`${options.failurePrefix}: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

