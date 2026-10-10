import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_NAME = "bot-browser";
export const WM_CLASS = "BotBrowser";
/** Bump when /api/status schema or binding semantics change. */
export const API_VERSION = 3;

export const DEFAULT_CDP_PORT = 9333;
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 9477;

export const MAX_CHAT_BODY_BYTES = 64 * 1024;
export const MAX_WS_MESSAGE_BYTES = 256 * 1024;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function assertLoopbackHost(host: string): void {
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error(`BOT_BROWSER_HOST must be loopback, got ${host}`);
	}
}

export function extensionIdFromEnv(): string | undefined {
	const id = process.env.BOT_BROWSER_EXTENSION_ID?.trim();
	return id || undefined;
}

export function dataDir(): string {
	return join(homedir(), ".local", "share", APP_NAME);
}

export function chromeProfileDir(): string {
	return join(dataDir(), "chrome");
}

export function stateDir(): string {
	return join(dataDir(), "state");
}

export function chromeExecutable(): string {
	return process.env.BOT_BROWSER_CHROME_EXECUTABLE ?? "/usr/bin/google-chrome";
}

/** Unpacked MV3 extension shipped with this repo (override with BOT_BROWSER_EXTENSION_PATH). */
export function bundledExtensionDir(): string {
	const fromEnv = process.env.BOT_BROWSER_EXTENSION_PATH?.trim();
	if (fromEnv) return fromEnv;
	return join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
}

/** Chrome branded builds ignore --load-extension (M137+); use CDP `Extensions.loadUnpacked` after launch. */
export function chromeExtensionLaunchArgs(): string[] {
	const ext = bundledExtensionDir();
	if (!existsSync(join(ext, "manifest.json"))) return [];
	return ["--enable-unsafe-extension-debugging"];
}

export function cdpUrl(port = DEFAULT_CDP_PORT): string {
	return `http://127.0.0.1:${port}`;
}

export type BrowserEngineId = "anchortree" | "playwright-mcp" | "fake";

/** Resolved browser engine for this process (`BOT_BROWSER_BROWSER_ENGINE` overrides default). */
export function resolvedBrowserEngineId(): BrowserEngineId {
	const raw = process.env.BOT_BROWSER_BROWSER_ENGINE?.trim().toLowerCase();
	if (raw === "fake") return "fake";
	if (raw === "playwright-mcp" || raw === "playwright" || raw === "mcp") return "playwright-mcp";
	if (raw === "anchortree") return "anchortree";
	return "anchortree";
}

export const DEFAULT_MODEL = {
	provider: "saturn",
	id: "qwen3.8-27b-huihui-swift-gsq-rco-iq2_xs-local",
} as const;

export const DEFAULT_THINKING_LEVEL = "off" as const;

/** Codex OAuth smoke / optional Codex runs (not the HTTP default). */
export const DEFAULT_CODEX_MODEL = {
	provider: "openai-codex",
	id: "gpt-6-luna",
} as const;

export const DEFAULT_CODEX_THINKING_LEVEL = "high" as const;
