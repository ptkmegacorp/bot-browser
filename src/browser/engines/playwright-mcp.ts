import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { listCdpPages } from "../../chrome/cdp.js";
import { stateDir } from "../../config.js";
import {
	type BrowserEngine,
	type EngineBindResult,
	type EngineBindingState,
	type EngineErrorCode,
	type EngineObservation,
	type EngineOutcome,
	type EngineScreenshot,
	type RefOperationContext,
	truncateObservationText,
} from "../engine.js";
import type { ControlDescriptor } from "../safety.js";
import { focusAndSelectCdpTarget } from "./cdp-tab-index.js";
import {
	createInProcessMcpSession,
	mcpCallTool,
	mcpConfigForCdpEndpoint,
	mcpToolImageBase64,
	mcpToolText,
	PLAYWRIGHT_MCP_VERSION,
	type McpClientSession,
} from "./mcp-client.js";
import { findSnapshotLineForRef, parseSnapshotHeader, parseSnapshotRefs } from "./mcp-snapshot.js";

export interface PlaywrightMcpEngineOptions {
	cdpUrl: string;
	outputDir?: string;
}

const DESCRIBE_CONTROL_FN = `(element) => {
  const el = element;
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute("type");
  const role = el.getAttribute("role");
  const formId = el.getAttribute("form");
  let inForm = false;
  if ("form" in el && el.form) inForm = true;
  else if (formId && document.getElementById(formId)) inForm = true;
  else if (el.closest("form")) inForm = true;
  const label =
    el.getAttribute("aria-label") ||
    (el.textContent ?? "").trim() ||
    el.getAttribute("value") ||
    "";
  const autocomplete = el.getAttribute("autocomplete");
  const name = el.getAttribute("name");
  return JSON.stringify({ tag, type, role, inForm, label, autocomplete, name });
}`;

export class PlaywrightMcpEngine implements BrowserEngine {
	private session: McpClientSession | null = null;
	private client: Client | null = null;
	private targetId: string | null = null;
	private boundUrl: string | null = null;
	private boundTitle: string | null = null;
	private bindingRevision = 0;
	private observationSeq = 0;
	private lastObservation: EngineObservation | null = null;
	private lastSnapshotRaw: string | null = null;
	private actionQueue: Promise<void> = Promise.resolve();
	private operationEpoch = 0;
	private abortController: AbortController | null = null;
	private readonly outputDir: string;

	constructor(private readonly options: PlaywrightMcpEngineOptions) {
		this.outputDir = options.outputDir ?? join(stateDir(), "mcp-output");
	}

	getPackageVersion(): string {
		return PLAYWRIGHT_MCP_VERSION;
	}

	private fail<T>(code: EngineErrorCode, message?: string): EngineOutcome<T> {
		return { ok: false, code, message };
	}

	private bumpEpoch(): void {
		this.operationEpoch += 1;
		if (this.abortController) {
			this.abortController.abort();
		}
		this.abortController = null;
	}

	private invalidateObservations(): void {
		this.lastObservation = null;
		this.lastSnapshotRaw = null;
		this.bindingRevision += 1;
	}

	cancel(): void {
		this.bumpEpoch();
		this.actionQueue = Promise.resolve();
		this.invalidateObservations();
	}

	private enqueue<T>(fn: (epoch: number, signal: AbortSignal) => Promise<EngineOutcome<T>>): Promise<EngineOutcome<T>> {
		const epoch = this.operationEpoch;
		const ac = new AbortController();
		this.abortController = ac;
		const run = this.actionQueue.then(async () => {
			if (epoch !== this.operationEpoch) {
				return this.fail<T>("operation_cancelled");
			}
			return fn(epoch, ac.signal);
		});
		this.actionQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async ensureSession(): Promise<Client> {
		if (this.client && this.session) return this.client;
		await mkdir(this.outputDir, { recursive: true });
		this.session = await createInProcessMcpSession(
			mcpConfigForCdpEndpoint(this.options.cdpUrl, this.outputDir),
		);
		this.client = this.session.client;
		return this.client;
	}

	private validateRef(ctx: RefOperationContext, ref: string): EngineOutcome<void> {
		if (!this.lastObservation || !this.targetId) {
			return this.fail("stale_observation", "no active observation");
		}
		const obs = this.lastObservation;
		if (
			ctx.observationId !== obs.observationId ||
			ctx.generation !== obs.generation ||
			ctx.bindingRevision !== obs.bindingRevision
		) {
			return this.fail("stale_observation");
		}
		if (ctx.bindingRevision !== this.bindingRevision) {
			return this.fail("stale_ref");
		}
		if (!obs.refs.some((r) => r.ref === ref)) {
			return this.fail("unknown_ref");
		}
		return { ok: true, data: undefined };
	}

	private async ensureTargetSelected(_client: Client, targetId: string): Promise<EngineOutcome<void>> {
		const focused = await focusAndSelectCdpTarget(this.options.cdpUrl, targetId, _client);
		if (!focused.ok) {
			if (focused.code === "ambiguous_tab_match") {
				return this.fail("invalid_argument", focused.message ?? "ambiguous_tab_match");
			}
			this.targetId = null;
			this.boundUrl = null;
			this.boundTitle = null;
			return this.fail("target_unavailable", focused.message);
		}
		return { ok: true, data: undefined };
	}

	async bind(targetId: string): Promise<EngineOutcome<EngineBindResult>> {
		return this.enqueue(async (epoch, signal) => {
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			const client = await this.ensureSession();
			const pages = await listCdpPages(this.options.cdpUrl);
			const meta = pages.find((p) => p.id === targetId);
			if (!meta) return this.fail("target_unavailable", "unknown_tab");

			const tab = await this.ensureTargetSelected(client, targetId);
			if (!tab.ok) return tab;

			this.targetId = targetId;
			this.boundUrl = meta.url;
			this.boundTitle = meta.title ?? "";
			this.invalidateObservations();

			if (epoch !== this.operationEpoch || signal.aborted) return this.fail("operation_cancelled");

			return {
				ok: true,
				data: {
					targetId,
					url: meta.url,
					title: meta.title ?? "",
					bindingRevision: this.bindingRevision,
				},
			};
		});
	}

	async getBindingState(): Promise<EngineBindingState> {
		if (!this.targetId) {
			return { live: false, targetId: null, url: null, title: null, bindingRevision: this.bindingRevision };
		}
		const pages = await listCdpPages(this.options.cdpUrl);
		const meta = pages.find((p) => p.id === this.targetId);
		if (!meta) {
			return { live: false, targetId: this.targetId, url: null, title: null, bindingRevision: this.bindingRevision };
		}
		return {
			live: true,
			targetId: this.targetId,
			url: meta.url,
			title: meta.title ?? this.boundTitle,
			bindingRevision: this.bindingRevision,
		};
	}

	async observe(): Promise<EngineOutcome<EngineObservation>> {
		return this.enqueue(async (epoch, signal) => {
			if (!this.targetId) return this.fail("not_bound");
			const client = await this.ensureSession();
			const tab = await this.ensureTargetSelected(client, this.targetId);
			if (!tab.ok) return tab;
			if (epoch !== this.operationEpoch || signal.aborted) return this.fail("operation_cancelled");

			const result = await mcpCallTool(client, "browser_snapshot", {}, signal);
			if (signal.aborted || epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			if (result.isError) {
				return this.fail("timeout", mcpToolText(result) || "browser_snapshot failed");
			}

			const raw = truncateObservationText(mcpToolText(result));
			this.lastSnapshotRaw = raw;
			const header = parseSnapshotHeader(raw, this.boundUrl ?? "", this.boundTitle ?? "");
			const refs = parseSnapshotRefs(raw);

			this.observationSeq += 1;
			const observation: EngineObservation = {
				observationId: `obs-${this.observationSeq}`,
				targetId: this.targetId,
				url: header.url,
				title: header.title,
				generation: this.observationSeq,
				bindingRevision: this.bindingRevision,
				bodyText: raw,
				refs,
			};
			this.lastObservation = observation;
			return { ok: true, data: observation };
		});
	}

	async navigate(url: string): Promise<EngineOutcome<{ url: string }>> {
		return this.enqueue(async (epoch, signal) => {
			if (!this.targetId) return this.fail("not_bound");
			const client = await this.ensureSession();
			const tab = await this.ensureTargetSelected(client, this.targetId);
			if (!tab.ok) return tab;
			if (epoch !== this.operationEpoch || signal.aborted) return this.fail("operation_cancelled");

			const result = await mcpCallTool(client, "browser_navigate", { url }, signal);
			if (signal.aborted || epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			if (result.isError) {
				return this.fail("timeout", mcpToolText(result) || "navigation failed");
			}
			this.boundUrl = url;
			this.invalidateObservations();
			return { ok: true, data: { url } };
		});
	}

	async click(ref: string, ctx: RefOperationContext): Promise<EngineOutcome<{ clicked: true }>> {
		return this.mutateRef(ref, ctx, "browser_click", { target: ref }, { clicked: true });
	}

	async fill(
		ref: string,
		ctx: RefOperationContext,
		text: string,
	): Promise<EngineOutcome<{ filled: true }>> {
		return this.mutateRef(ref, ctx, "browser_type", { target: ref, text }, { filled: true });
	}

	async selectOption(
		ref: string,
		ctx: RefOperationContext,
		value: string,
	): Promise<EngineOutcome<{ selected: true }>> {
		return this.mutateRef(ref, ctx, "browser_select_option", { target: ref, values: [value] }, { selected: true });
	}

	private mutateRef<T extends { clicked: true } | { filled: true } | { selected: true }>(
		ref: string,
		ctx: RefOperationContext,
		tool: string,
		args: Record<string, unknown>,
		success: T,
	): Promise<EngineOutcome<T>> {
		return this.enqueue(async (epoch, signal) => {
			if (!this.targetId) return this.fail("not_bound");
			const check = this.validateRef(ctx, ref);
			if (!check.ok) return check;

			const client = await this.ensureSession();
			const tab = await this.ensureTargetSelected(client, this.targetId);
			if (!tab.ok) return tab;
			if (epoch !== this.operationEpoch || signal.aborted) return this.fail("operation_cancelled");

			const result = await mcpCallTool(client, tool, args, signal);
			if (signal.aborted || epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			if (result.isError) {
				return this.fail("timeout", mcpToolText(result) || `${tool} failed`);
			}
			this.invalidateObservations();
			return { ok: true, data: success };
		});
	}

	async scroll(direction: "up" | "down"): Promise<EngineOutcome<{ scrolled: true }>> {
		return this.enqueue(async (epoch, signal) => {
			if (!this.targetId) return this.fail("not_bound");
			const client = await this.ensureSession();
			const tab = await this.ensureTargetSelected(client, this.targetId);
			if (!tab.ok) return tab;
			const deltaY = direction === "down" ? 600 : -600;
			const result = await mcpCallTool(client, "browser_mouse_wheel", { deltaY }, signal);
			if (signal.aborted || epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			if (result.isError) {
				return this.fail("timeout", mcpToolText(result) || "scroll failed");
			}
			return { ok: true, data: { scrolled: true } };
		});
	}

	async screenshot(): Promise<EngineOutcome<EngineScreenshot>> {
		return this.enqueue(async (epoch, signal) => {
			if (!this.targetId) return this.fail("not_bound");
			const client = await this.ensureSession();
			const tab = await this.ensureTargetSelected(client, this.targetId);
			if (!tab.ok) return tab;
			const result = await mcpCallTool(client, "browser_take_screenshot", { type: "png" }, signal);
			if (signal.aborted || epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			if (result.isError) {
				return this.fail("timeout", mcpToolText(result) || "screenshot failed");
			}
			const base64 = mcpToolImageBase64(result);
			if (!base64) {
				return this.fail("not_implemented", "screenshot response had no image payload");
			}
			return { ok: true, data: { mimeType: "image/png", base64 } };
		});
	}

	async describeControl(ref: string, ctx: RefOperationContext): Promise<EngineOutcome<ControlDescriptor>> {
		if (!this.targetId) return this.fail("not_bound");
		const check = this.validateRef(ctx, ref);
		if (!check.ok) return check;

		const line = this.lastSnapshotRaw ? findSnapshotLineForRef(this.lastSnapshotRaw, ref) : undefined;
		if (line) {
			const roleMatch = line.match(/^\s*-\s+(\w+)/);
			const nameMatch = line.match(/"([^"]*)"/);
			const role = roleMatch?.[1] ?? "element";
			const label = nameMatch?.[1] ?? "";
			const tag =
				role === "button" ? "button" : role === "link" ? "a" : role === "textbox" ? "input" : role;
			let inForm = false;
			if (this.lastSnapshotRaw) {
				const lines = this.lastSnapshotRaw.split("\n");
				const idx = lines.findIndex((l) => l.includes(`[ref=${ref}]`));
				for (let i = idx - 1; i >= 0 && i >= idx - 8; i--) {
					if (/^\s*-\s+form\b/i.test(lines[i]!)) {
						inForm = true;
						break;
					}
				}
			}
			return {
				ok: true,
				data: { tag, type: null, role, inForm, label },
			};
		}

		return this.enqueue(async (epoch, signal) => {
			const client = await this.ensureSession();
			const tab = await this.ensureTargetSelected(client, this.targetId!);
			if (!tab.ok) return tab;
			const result = await mcpCallTool(
				client,
				"browser_evaluate",
				{ target: ref, function: DESCRIBE_CONTROL_FN },
				signal,
			);
			if (signal.aborted || epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			if (result.isError) {
				return this.fail("unknown_ref", mcpToolText(result));
			}
			const text = mcpToolText(result).trim();
			try {
				const parsed = JSON.parse(text) as ControlDescriptor;
				return { ok: true, data: parsed };
			} catch {
				return this.fail("unknown_ref", "could not describe control");
			}
		});
	}

	async dispose(): Promise<void> {
		this.cancel();
		this.targetId = null;
		if (this.session) {
			await this.session.close();
		}
		this.session = null;
		this.client = null;
	}
}
