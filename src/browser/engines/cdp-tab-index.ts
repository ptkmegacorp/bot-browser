import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { activateCdpTarget, listCdpPages } from "../../chrome/cdp.js";
import { readMainBodyTextForCdpTarget } from "./cdp-target-page.js";
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

function verifyNeedleFromBody(expectedBody: string): string {
	if (expectedBody.length <= 80 && !expectedBody.includes("\n")) return expectedBody;
	return (
		expectedBody
			.split("\n")
			.map((s) => s.trim())
			.find((s) => s.length >= 4) ?? expectedBody.slice(0, 80)
	);
}

/**
 * Select the MCP tab that corresponds to an exact CDP target id.
 * When multiple tabs share a URL, each candidate index is tried and verified
 * against the CDP target's live body text (not list order alone).
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

	const expectedBody = (await readMainBodyTextForCdpTarget(cdpUrl, targetId))?.trim() ?? "";
	if (!expectedBody) {
		return { ok: false, code: "target_unavailable", message: "CDP target page not readable" };
	}
	const verifyNeedle = verifyNeedleFromBody(expectedBody);

	const listText = mcpToolText(await mcpCallTool(client, "browser_tabs", { action: "list" }));
	const mcpTabs = parseMcpTabList(listText);
	const candidates = mcpTabs.filter((t) => urlsEquivalent(t.url, target.url));
	if (candidates.length === 0) {
		return { ok: false, code: "target_unavailable", message: "target URL absent from MCP tab list" };
	}

	let matchedIndex: number | null = null;
	for (const entry of candidates) {
		await activateCdpTarget(cdpUrl, targetId);
		const result = await mcpCallTool(client, "browser_tabs", { action: "select", index: entry.index });
		if (result.isError) continue;
		const snap = mcpToolText(await mcpCallTool(client, "browser_snapshot", {}));
		if (!snap.includes(verifyNeedle)) continue;
		if (matchedIndex !== null) {
			return {
				ok: false,
				code: "ambiguous_tab_match",
				message: "multiple MCP tabs matched the same CDP target body",
			};
		}
		matchedIndex = entry.index;
	}

	if (matchedIndex === null) {
		return {
			ok: false,
			code: "ambiguous_tab_match",
			message: "no MCP tab snapshot matched CDP target body",
		};
	}

	await activateCdpTarget(cdpUrl, targetId);
	await mcpCallTool(client, "browser_tabs", { action: "select", index: matchedIndex });
	await activateCdpTarget(cdpUrl, targetId);
	return { ok: true };
}
