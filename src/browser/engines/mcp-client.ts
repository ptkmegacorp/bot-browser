import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const PLAYWRIGHT_MCP_VERSION = "0.0.83";

export interface McpClientSession {
	client: Client;
	server: Awaited<ReturnType<typeof createConnection>>;
	close: () => Promise<void>;
}

/** Minimal @playwright/mcp config surface used by USBA (full type is not package-exported). */
export type PlaywrightMcpConfig = Parameters<typeof createConnection>[0];

export async function createInProcessMcpSession(config: PlaywrightMcpConfig): Promise<McpClientSession> {
	const server = await createConnection(config);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "usba-playwright-mcp", version: "1.0.0" });
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

export function mcpToolText(result: CallToolResult): string {
	return (result.content ?? [])
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/** Extract JSON payload from Playwright MCP browser_evaluate tool output. */
export function parseMcpEvaluateJson(text: string): string {
	const match = text.match(/### Result\s*\n([\s\S]*?)(?:\n###|$)/);
	const chunk = (match?.[1] ?? text).trim();
	if (!chunk) return text.trim();
	if (chunk.startsWith('"')) {
		try {
			return JSON.parse(chunk) as string;
		} catch {
			return chunk;
		}
	}
	return chunk;
}

export function mcpToolImageBase64(result: CallToolResult): string | null {
	for (const c of result.content ?? []) {
		if (c.type === "image" && "data" in c && typeof c.data === "string") {
			return c.data;
		}
	}
	return null;
}

export async function mcpCallTool(
	client: Client,
	name: string,
	args: Record<string, unknown> = {},
	signal?: AbortSignal,
): Promise<CallToolResult> {
	return client.callTool({ name, arguments: args }, undefined, { signal }) as Promise<CallToolResult>;
}

export function mcpConfigForCdpEndpoint(cdpEndpoint: string, outputDir: string): PlaywrightMcpConfig {
	return {
		browser: {
			cdpEndpoint,
			browserName: "chromium",
		},
		outputDir,
		timeouts: { action: 10_000, navigation: 30_000, settle: 200 },
	};
}
