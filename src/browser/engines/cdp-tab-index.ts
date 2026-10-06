import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { activateCdpTarget, listCdpPages } from "../../chrome/cdp.js";
import { mcpCallTool, mcpToolText } from "./mcp-client.js";

export type TabIndexResolution =
	| { ok: true }
	| { ok: false; code: "target_unavailable" | "ambiguous_tab_match"; message?: string };

export interface McpTabEntry {
	index: number;
	url: string;
	title: string;
}

export function parseMcpTabList(listText: string): McpTabEntry[] {
	const tabs: McpTabEntry[] = [];
	for (const line of listText.split("\n")) {
		const idxMatch = line.match(/^-\s+(\d+):/);
		if (!idxMatch) continue;
		const urlMatch = line.match(/\]\(([^)]+)\)\s*$/);
		const titleMatch = line.match(/\[([^\]]*)\]/);
		tabs.push({
			index: Number(idxMatch[1]),
			title: titleMatch?.[1]?.trim() ?? "",
			url: urlMatch?.[1]?.trim() ?? "",
		});
	}
	return tabs.sort((a, b) => a.index - b.index);
}

function urlsEquivalent(a: string, b: string): boolean {
	if (a === b) return true;
	try {
		return new URL(a).href === new URL(b).href;
	} catch {
		return false;
	}
}

/**
 * Select the MCP tab that corresponds to an exact CDP target id.
 * Aligns same-URL tabs by relative order in CDP /json/list vs MCP browser_tabs list.
 */
export async function focusAndSelectCdpTarget(
	cdpUrl: string,
	targetId: string,
	client: Client,
): Promise<TabIndexResolution> {
	const cdpPages = await listCdpPages(cdpUrl);
	const target = cdpPages.find((p) => p.id === targetId);
	if (!target) {
		return { ok: false, code: "target_unavailable", message: "CDP target not in /json/list" };
	}

	const listText = mcpToolText(await mcpCallTool(client, "browser_tabs", { action: "list" }));
	const mcpTabs = parseMcpTabList(listText);
	const cdpSameUrl = cdpPages.filter((p) => urlsEquivalent(p.url, target.url));
	const mcpSameUrl = mcpTabs.filter((t) => urlsEquivalent(t.url, target.url));

	if (mcpSameUrl.length === 0) {
		return { ok: false, code: "target_unavailable", message: "target URL absent from MCP tab list" };
	}

	const posInCdp = cdpSameUrl.findIndex((p) => p.id === targetId);
	if (posInCdp < 0) {
		return { ok: false, code: "target_unavailable" };
	}

	if (mcpSameUrl.length !== cdpSameUrl.length) {
		return {
			ok: false,
			code: "ambiguous_tab_match",
			message: "CDP/MCP same-URL tab count mismatch",
		};
	}

	const tabIndex = mcpSameUrl[posInCdp]!.index;
	await activateCdpTarget(cdpUrl, targetId);
	const result = await mcpCallTool(client, "browser_tabs", { action: "select", index: tabIndex });
	if (result.isError) {
		return {
			ok: false,
			code: "target_unavailable",
			message: mcpToolText(result) || "browser_tabs select failed",
		};
	}
	return { ok: true };
}
