import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BrowserController } from "../browser/controller.js";

const TOOL_ALIASES: Record<string, string> = {
	page_snapshot: "page_snapshot",
	browser_snapshot: "page_snapshot",
	"mcp__browser__page_snapshot": "page_snapshot",
	browser_fill: "browser_fill",
	"mcp__browser__browser_fill": "browser_fill",
	browser_click: "browser_click",
	browser_navigate: "browser_navigate",
	browser_select: "browser_select",
	browser_scroll: "browser_scroll",
};

export interface ParsedTextTool {
	name: string;
	args: Record<string, string>;
}

function normalizeToolName(raw: string): string | null {
	const key = raw.replace(/^mcp__browser__/, "");
	return TOOL_ALIASES[raw] ?? TOOL_ALIASES[key] ?? null;
}

export function parseTextToolCall(text: string): ParsedTextTool | null {
	const jsonMatch = text.match(/"tool_name"\s*:\s*"([^"]+)"/);
	if (jsonMatch) {
		const name = normalizeToolName(jsonMatch[1]!);
		if (!name) return null;
		const args: Record<string, string> = {};
		const argsMatch = text.match(/"arguments"\s*:\s*(\{[^}]+\})/);
		if (argsMatch) {
			try {
				const parsed = JSON.parse(argsMatch[1]!) as Record<string, unknown>;
				for (const [k, v] of Object.entries(parsed)) {
					if (typeof v === "string" || typeof v === "number") args[k] = String(v);
				}
			} catch {
				/* ignore */
			}
		}
		return { name, args };
	}

	const fnMatch = text.match(/<function=([^>\s]+)>/);
	if (!fnMatch) return null;
	const name = normalizeToolName(fnMatch[1]!);
	if (!name) return null;
	const args: Record<string, string> = {};
	for (const m of text.matchAll(/(\w+)\s*[:=]\s*["']?([^"'\n<]+)["']?/g)) {
		args[m[1]!] = m[2]!.trim();
	}
	return { name, args };
}

async function executeParsedTool(
	controller: BrowserController,
	tool: ParsedTextTool,
	lastGeneration: { value: number },
): Promise<string> {
	if (!controller.isTabAttached()) {
		return "error: no_tab_attached";
	}
	switch (tool.name) {
		case "page_snapshot": {
			const snap = await controller.snapshot();
			lastGeneration.value = snap.generation;
			return JSON.stringify(snap);
		}
		case "browser_fill": {
			const ref = tool.args.ref ?? tool.args.ref_id;
			const generation = Number(tool.args.generation ?? lastGeneration.value);
			const text = tool.args.text ?? tool.args.value ?? "";
			if (!ref || !generation) return "error: missing ref or generation";
			const result = await controller.fill(ref, generation, text);
			return JSON.stringify(result);
		}
		case "browser_click": {
			const ref = tool.args.ref;
			const generation = Number(tool.args.generation ?? lastGeneration.value);
			if (!ref || !generation) return "error: missing ref or generation";
			return JSON.stringify(await controller.click(ref, generation));
		}
		case "browser_navigate": {
			const url = tool.args.url;
			if (!url) return "error: missing url";
			return JSON.stringify(await controller.navigate(url));
		}
		default:
			return `error: unsupported tool ${tool.name}`;
	}
}

/** Execute only tools explicitly requested by the model; never guess fields/values. */
export async function runTextToolCompatibilityLoop(
	session: AgentSession,
	controller: BrowserController,
	maxSteps = 8,
): Promise<void> {
	if (!controller.isTabAttached()) return;
	const lastGeneration = { value: 0 };
	for (let step = 0; step < maxSteps; step++) {
		const text = session.getLastAssistantText() ?? "";
		const parsed = parseTextToolCall(text);
		if (!parsed) return;
		const result = await executeParsedTool(controller, parsed, lastGeneration);
		await session.prompt(
			`Tool ${parsed.name} result:\n${result}\nContinue the task. For browser_fill use XML: <function=browser_fill> ref=eN generation=N text=value </function>`,
		);
	}
}
