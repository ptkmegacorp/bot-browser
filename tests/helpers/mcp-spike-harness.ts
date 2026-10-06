import { createConnection, type Config } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { chromium, type Browser } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const AGENT_CDP = "http://127.0.0.1:9333";

export interface CdpPageTarget {
	id: string;
	type: string;
	url: string;
	title?: string;
}

export async function agentChromeReachable(): Promise<boolean> {
	try {
		const res = await fetch(`${AGENT_CDP}/json/version`, { signal: AbortSignal.timeout(2000) });
		return res.ok;
	} catch {
		return false;
	}
}

export async function listCdpTargets(cdpEndpoint: string): Promise<CdpPageTarget[]> {
	const res = await fetch(`${cdpEndpoint}/json/list`, { signal: AbortSignal.timeout(5000) });
	if (!res.ok) throw new Error(`CDP list failed: ${res.status}`);
	const list = (await res.json()) as CdpPageTarget[];
	return list.filter((t) => t.type === "page");
}

export interface DedicatedCdpSession {
	cdpEndpoint: string;
	browser: Browser;
	userDataDir: string;
	cleanup: () => Promise<void>;
}

/** Headless dedicated Chrome for destructive spike tests (never touches Agent Chrome). */
export async function launchDedicatedCdpBrowser(): Promise<DedicatedCdpSession> {
	const userDataDir = await mkdtemp(join(tmpdir(), "usba-mcp-spike-"));
	const port = await pickFreePort();
	const persistent = await chromium.launchPersistentContext(userDataDir, {
		headless: true,
		args: [`--remote-debugging-port=${port}`],
	});
	const cdpEndpoint = `http://127.0.0.1:${port}`;
	await waitForCdp(cdpEndpoint);
	const pwBrowser = await chromium.connectOverCDP(cdpEndpoint);
	return {
		cdpEndpoint,
		browser: pwBrowser,
		userDataDir,
		cleanup: async () => {
			await pwBrowser.close().catch(() => {});
			await persistent.close().catch(() => {});
			await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
		},
	};
}

async function pickFreePort(): Promise<number> {
	const net = await import("node:net");
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("no port"));
				return;
			}
			const port = addr.port;
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
}

async function waitForCdp(endpoint: string, attempts = 40): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) });
			if (res.ok) return;
		} catch {
			/* retry */
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`CDP not ready: ${endpoint}`);
}

export interface McpSpikeClient {
	client: Client;
	server: Awaited<ReturnType<typeof createConnection>>;
	close: () => Promise<void>;
}

export async function createInProcessMcpClient(config: Config): Promise<McpSpikeClient> {
	const server = await createConnection(config);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "usba-mcp-spike", version: "1.0.0" });
	await client.connect(clientTransport);
	return {
		client,
		server,
		close: async () => {
			await client.close().catch(() => {});
			await server.close().catch(() => {});
		},
	};
}

export function toolText(result: CallToolResult): string {
	return (result.content ?? [])
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

export async function mcpCall(
	client: Client,
	name: string,
	args: Record<string, unknown> = {},
	signal?: AbortSignal,
): Promise<CallToolResult> {
	return client.callTool({ name, arguments: args }, undefined, { signal });
}

/** Parse first ref= token from an accessibility snapshot (Playwright MCP YAML). */
export function firstRefFromSnapshot(snapshot: string): string | undefined {
	const m = snapshot.match(/\[ref=([^\]]+)\]/);
	return m?.[1];
}

/** Find ref for a snapshot line containing a substring (e.g. textbox). */
export function refMatchingSnapshotLine(snapshot: string, needle: string): string | undefined {
	for (const line of snapshot.split("\n")) {
		if (!line.includes(needle)) continue;
		const m = line.match(/\[ref=([^\]]+)\]/);
		if (m) return m[1];
	}
	return undefined;
}

export function mcpConfigForCdp(cdpEndpoint: string, outputDir: string): Config {
	return {
		browser: {
			cdpEndpoint,
			browserName: "chromium",
		},
		outputDir,
		timeouts: { action: 10_000, navigation: 30_000, settle: 200 },
	};
}
