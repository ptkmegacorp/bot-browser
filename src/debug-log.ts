import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./config.js";

export interface DebugContext {
	runId?: string;
	provider?: string;
	model?: string;
	engine?: string;
	targetId?: string | null;
	generation?: number;
	bindingRevision?: number;
}

type DebugFields = DebugContext & {
	callId?: string;
	name?: string;
	source?: string;
	outcome?: string;
	errorCode?: string;
	durationMs?: number;
	textChars?: number;
	valueChars?: number;
	nodeCount?: number;
	pendingCount?: number;
	bytes?: number;
	pid?: number;
	exitCode?: number | null;
	signal?: string | null;
	verification?: string;
};

const stringFields = new Set([
	"runId", "provider", "model", "engine", "targetId", "callId", "name", "source",
	"outcome", "errorCode", "signal", "verification",
]);
const numberFields = new Set([
	"generation", "bindingRevision", "durationMs", "textChars", "valueChars", "nodeCount",
	"pendingCount", "bytes", "pid", "exitCode",
]);
const errorCodes = new Set([
	"operation_cancelled", "timeout", "stale_observation", "stale_ref", "unknown_ref",
	"not_bound", "target_unavailable", "invalid_argument", "not_implemented",
	"stale_snapshot_generation", "no_tab_attached", "tab_not_attached", "stale_tab_binding",
	"observations_paused", "agent_disabled", "sensitive_field_human_only",
	"risky_click_requires_human", "origin_not_approved", "ref_element_missing",
	"not_a_select", "missing_arguments", "unsupported_tool", "run_budget_exceeded",
]);

/** Keep error messages, URLs, values and page text outside this metadata-only log. */
export function debugErrorCode(error: unknown): string {
	const code = error instanceof Error ? error.message : error;
	return typeof code === "string" && errorCodes.has(code) ? code : "internal_error";
}

export class DebugLog {
	private warned = false;
	constructor(readonly path: string, private readonly maxBytes = 5 * 1024 * 1024) {}

	write(event: string, fields: DebugFields = {}): void {
		try {
			const row: Record<string, unknown> = { timestamp: new Date().toISOString(), event };
			for (const [key, value] of Object.entries(fields)) {
				if (stringFields.has(key) && typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value)) {
					row[key] = value;
				} else if (numberFields.has(key) && typeof value === "number" && Number.isFinite(value)) {
					row[key] = value;
				}
			}
			const line = `${JSON.stringify(row)}\n`;
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			if (existsSync(this.path) && statSync(this.path).size + Buffer.byteLength(line) > this.maxBytes) {
				rmSync(`${this.path}.1`, { force: true });
				renameSync(this.path, `${this.path}.1`);
				chmodSync(`${this.path}.1`, 0o600);
			}
			appendFileSync(this.path, line, { mode: 0o600 });
			chmodSync(this.path, 0o600);
		} catch {
			if (!this.warned) {
				this.warned = true;
				console.warn("[bot-browser] debug log unavailable");
			}
		}
	}
}

const context = new AsyncLocalStorage<DebugContext>();
let logger: DebugLog | undefined;
let nextCall = 0;

export function setDebugLog(value: DebugLog | undefined): void {
	logger = value;
}

export function enableDebugLog(): void {
	if (process.env.BOT_BROWSER_DEBUG_LOG === "0") return;
	setDebugLog(new DebugLog(join(stateDir(), "debug.jsonl")));
}

export function currentDebugContext(): DebugContext {
	return { ...context.getStore() };
}

export function debugEvent(event: string, fields: DebugFields = {}): void {
	logger?.write(event, { ...context.getStore(), ...fields });
}

export function withDebugRun<T>(fields: DebugContext, fn: () => T): T {
	return context.run(fields, fn);
}

function resultSummary(result: unknown): DebugFields {
	if (typeof result === "string") {
		if (result.startsWith("error:")) return { outcome: "error", errorCode: debugErrorCode(result.slice(6).trim()) };
		try { return resultSummary(JSON.parse(result)); } catch { return { outcome: "ok" }; }
	}
	if (!result || typeof result !== "object") return { outcome: "ok" };
	const raw = result as Record<string, unknown>;
	const details = raw.details && typeof raw.details === "object"
		? raw.details as Record<string, unknown> : raw;
	const verification = details.verification as { status?: string } | undefined;
	return {
		outcome: details.ok === false ? "blocked" : "ok",
		errorCode: details.ok === false ? debugErrorCode(details.blocked) : undefined,
		generation: typeof details.generation === "number" ? details.generation : undefined,
		nodeCount: Array.isArray(details.nodes) ? details.nodes.length : undefined,
		verification: ["ok", "warn", "fail"].includes(verification?.status ?? "") ? verification?.status : undefined,
	};
}

/** Shared by SDK tools and the Qwen text-tool compatibility path. */
export async function traceTool<T>(
	name: string,
	args: unknown,
	source: "sdk" | "text_shim",
	state: () => DebugContext,
	execute: () => Promise<T>,
): Promise<T> {
	const callId = `tool-${++nextCall}`;
	const params = args && typeof args === "object" ? args as Record<string, unknown> : {};
	const started = performance.now();
	debugEvent("tool_start", {
		...state(), callId, name, source,
		generation: Number.isFinite(Number(params.generation)) ? Number(params.generation) : undefined,
		textChars: typeof params.text === "string" ? params.text.length : undefined,
		valueChars: typeof params.value === "string" ? params.value.length : undefined,
	});
	try {
		const result = await execute();
		debugEvent("tool_end", { ...state(), callId, name, source, durationMs: Math.round(performance.now() - started), ...resultSummary(result) });
		return result;
	} catch (error) {
		debugEvent("tool_end", { ...state(), callId, name, source, outcome: "error", errorCode: debugErrorCode(error), durationMs: Math.round(performance.now() - started) });
		throw error;
	}
}
