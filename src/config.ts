import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "ubuntu-shared-browser-agent";
export const WM_CLASS = "UbuntuSharedBrowserAgent";
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
		throw new Error(`USBA_HOST must be loopback, got ${host}`);
	}
}

export function extensionIdFromEnv(): string | undefined {
	const id = process.env.USBA_EXTENSION_ID?.trim();
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
	return process.env.USBA_CHROME_EXECUTABLE ?? "/usr/bin/google-chrome";
}

export function cdpUrl(port = DEFAULT_CDP_PORT): string {
	return `http://127.0.0.1:${port}`;
}

export const DEFAULT_MODEL = {
	provider: "saturn",
	id: "qwen3.8-27b-gsq-rco-iq2_xs-local",
} as const;

export const DEFAULT_THINKING_LEVEL = "off" as const;

/** Codex OAuth smoke / optional Codex runs (not the HTTP default). */
export const DEFAULT_CODEX_MODEL = {
	provider: "openai-codex",
	id: "gpt-6-luna",
} as const;

export const DEFAULT_CODEX_THINKING_LEVEL = "high" as const;
