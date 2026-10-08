import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { API_VERSION, extensionIdFromEnv, MAX_CHAT_BODY_BYTES, MAX_WS_MESSAGE_BYTES } from "../config.js";
import { AgentPolicy, type BindingMode } from "./agent-policy.js";
import { finishChatRun } from "./control.js";
import { runTextToolCompatibilityLoop } from "../agent/text-tool-shim.js";
import type { AgentHost } from "../agent/session.js";
import type { BrowserController } from "../browser/controller.js";
import { cdpUrl } from "../config.js";
import { originFromUrl, type OriginPolicyMode } from "../browser/origin-scope.js";
import { listCdpPages } from "../chrome/cdp.js";
import { ensureBundledExtensionLoaded } from "../chrome/extension-load.js";
import type { ChromeRuntimeState } from "../chrome/state.js";
import { assertJsonSize, parseAuth } from "./auth.js";
import {
	AGENT_DISABLED_CODE,
	AGENT_DISABLED_MESSAGE,
	NO_TAB_ATTACHED_CODE,
	NO_TAB_USER_MESSAGE,
	ORIGIN_NOT_APPROVED_CODE,
	ORIGIN_NOT_APPROVED_MESSAGE,
	sanitizeAssistantTextForUser,
	toolActivityLabel,
} from "./presentation.js";

async function applyOriginPolicyChange(
	deps: ServerDeps,
	mode: OriginPolicyMode,
	broadcast: (event: object) => void,
): Promise<void> {
	const scope = deps.controller.originScope;
	const prev = scope.getMode();
	scope.setMode(mode);
	if (prev === "all_public_web" && mode === "approved_only") {
		if (deps.controller.getMode() === "running") {
			deps.controller.drainQueuedWork();
			deps.controller.invalidateObservations();
			await deps.agentHost.session.abort().catch(() => {});
			deps.controller.setMode("idle");
		}
		const tab = await deps.controller.syncLiveBinding();
		if (tab.attached && tab.url) {
			const ok = scope.revalidateCurrentUrl(tab.url);
			if (!ok.ok) {
				deps.onPause();
				deps.controller.setPaused("permission");
				broadcast({
					type: "site_permission_required",
					message: ORIGIN_NOT_APPROVED_MESSAGE,
					reason: ok.reason,
				});
			}
		}
	}
	if (mode === "all_public_web") {
		if (await deps.controller.tryClearPermissionPause()) {
			deps.onResume();
		}
	}
}

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export interface ServerDeps {
	host: string;
	port: number;
	pairingToken: string;
	chromeState: ChromeRuntimeState;
	controller: BrowserController;
	agentHost: AgentHost;
	runBudgetMs?: number;
	onPause: () => void;
	onResume: () => void;
	onHumanHandoff: (active: boolean) => void;
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, max: number): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > max) throw new Error("payload_too_large");
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export function createAppServer(deps: ServerDeps) {
	const extensionId = extensionIdFromEnv();
	const clients = new Set<ServerResponse>();
	const policy = new AgentPolicy();

	function authorize(req: IncomingMessage) {
		return parseAuth(req, deps.pairingToken, extensionId);
	}

	function broadcast(event: object): void {
		const line = `data: ${JSON.stringify(event)}\n\n`;
		for (const res of clients) {
			res.write(line);
		}
	}

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${deps.host}:${deps.port}`);
		try {
			if (url.pathname === "/health") {
				json(res, 200, { ok: true });
				return;
			}

			if (url.pathname.startsWith("/fixtures/") || url.pathname.startsWith("/assets/")) {
				const root = url.pathname.startsWith("/assets/") ? "assets" : "fixtures";
				const rel = normalize(url.pathname.replace(`/${root}/`, ""));
				if (rel.includes("..")) {
					json(res, 403, { error: "forbidden" });
					return;
				}
				const path = join(repoRoot, root, rel);
				const data = await readFile(path);
				let type = "application/octet-stream";
				if (path.endsWith(".html")) type = "text/html; charset=utf-8";
				else if (path.endsWith(".svg")) type = "image/svg+xml";
				else if (path.endsWith(".png")) type = "image/png";
				res.writeHead(200, { "Content-Type": type });
				res.end(data);
				return;
			}

			if (url.pathname === "/api/events") {
				const auth = authorize(req);
				if (!auth.ok) {
					json(res, 401, { error: auth.reason });
					return;
				}
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				clients.add(res);
				req.on("close", () => clients.delete(res));
				res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
				return;
			}

			if (url.pathname === "/api/extension/ensure" && (req.method === "POST" || req.method === "GET")) {
				const auth = authorize(req);
				if (!auth.ok) {
					json(res, 401, { error: auth.reason });
					return;
				}
				try {
					const id = await ensureBundledExtensionLoaded(deps.chromeState.cdpPort);
					if (!id) {
						json(res, 500, { error: "extension_not_loaded" });
						return;
					}
					json(res, 200, { ok: true, id, name: "Bot Browser" });
				} catch (err) {
					const message = err instanceof Error ? err.message : "extension_load_failed";
					json(res, 503, { error: "extension_load_failed", message });
				}
				return;
			}

			if (url.pathname === "/api/tabs") {
				const auth = authorize(req);
				if (!auth.ok) {
					json(res, 401, { error: auth.reason });
					return;
				}
				const pages = await listCdpPages(cdpUrl(deps.chromeState.cdpPort));
				const boundId = deps.controller.getBoundTargetId();
				json(res, 200, {
					attachedTargetId: boundId,
					tabs: pages.map((p) => ({ targetId: p.id, url: p.url, title: p.title })),
				});
				return;
			}

			if (url.pathname === "/api/status") {
				const auth = authorize(req);
				if (!auth.ok) {
					json(res, 401, { error: auth.reason });
					return;
				}
				const models = await deps.agentHost.listModels();
				const tab = await deps.controller.syncLiveBinding();
				if (tab.attached && tab.targetId && tab.url) {
					deps.chromeState.taskTargetId = tab.targetId;
					deps.chromeState.taskUrl = tab.url;
				}
				json(res, 200, {
					apiVersion: API_VERSION,
					mode: deps.controller.getMode(),
					agentEnabled: policy.agentEnabled,
					bindingMode: policy.bindingMode,
					bindingRevision: policy.bindingRevision,
					tabAttached: tab.attached,
					taskTab: tab.attached
						? { targetId: tab.targetId, url: tab.url, title: tab.title }
						: null,
					approvedOrigins: deps.controller.originScope.list(),
					originPolicyMode: deps.controller.originScope.getMode(),
					originPolicyRevision: deps.controller.originScope.getPolicyRevision(),
					models,
				});
				return;
			}

			if (url.pathname === "/api/chat" && req.method === "POST") {
				const auth = authorize(req);
				if (!auth.ok) {
					json(res, 401, { error: auth.reason });
					return;
				}
				const body = await readBody(req, MAX_CHAT_BODY_BYTES);
				assertJsonSize(body, MAX_CHAT_BODY_BYTES);
				const payload = JSON.parse(body) as { message?: string; model?: { provider: string; id: string } };
				if (!payload.message?.trim()) {
					json(res, 400, { error: "missing_message" });
					return;
				}
				if (!policy.agentEnabled || !deps.controller.isAgentEnabled()) {
					json(res, 409, { error: AGENT_DISABLED_CODE, message: AGENT_DISABLED_MESSAGE });
					return;
				}
				if (deps.controller.getMode() === "paused" || deps.controller.getMode() === "human_handoff") {
					json(res, 409, { error: "agent_paused" });
					return;
				}
				const tab = await deps.controller.syncLiveBinding();
				if (!tab.attached) {
					json(res, 409, {
						error: NO_TAB_ATTACHED_CODE,
						message: NO_TAB_USER_MESSAGE,
					});
					return;
				}
				if (tab.url) {
					const nav = deps.controller.originScope.validateNavigation(tab.url);
					if (!nav.ok) {
						json(res, 409, {
							error: ORIGIN_NOT_APPROVED_CODE,
							message: ORIGIN_NOT_APPROVED_MESSAGE,
							reason: nav.reason,
						});
						return;
					}
				}
				const priorProvider = deps.agentHost.session.model?.provider;
				if (payload.model) {
					const m = deps.agentHost.modelRuntime.getModel(payload.model.provider, payload.model.id);
					if (!m) {
						json(res, 400, { error: "unknown_model" });
						return;
					}
					await deps.agentHost.setModel(m);
				}
				deps.controller.setMode("running");
				const runId = randomUUID();
				broadcast({ type: "run_start", runId });
				const session = deps.agentHost.session;
				const budgetMs = deps.runBudgetMs ?? 120_000;
				const budget = setTimeout(() => {
					session.abort().catch(() => {});
				}, budgetMs);
				let unsub = () => {};
				unsub = session.subscribe((event) => {
					if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
						const delta = event.assistantMessageEvent.delta;
						if (!delta || /<tool_call|<function=/i.test(delta)) return;
						broadcast({ type: "text_delta", runId, delta });
					}
					if (event.type === "tool_execution_start") {
						broadcast({
							type: "tool_start",
							runId,
							name: event.toolName,
							label: toolActivityLabel(event.toolName),
						});
					}
					if (event.type === "tool_execution_end") {
						broadcast({ type: "tool_end", runId, name: event.toolName });
					}
				});
				try {
					if (payload.model && priorProvider && payload.model.provider !== priorProvider) {
						broadcast({
							type: "provider_warning",
							message: "Switching provider may send conversation context to a new destination.",
						});
					}
					await session.prompt(payload.message);
					const provider = session.model?.provider ?? "";
					if (Array.isArray(session.messages) && provider === "saturn") {
						await runTextToolCompatibilityLoop(session, deps.controller);
					}
					const raw = session.getLastAssistantText() ?? "";
					const text = sanitizeAssistantTextForUser(raw);
					broadcast({ type: "run_end", runId, text });
					json(res, 200, { text, runId });
				} catch (err) {
					const message = err instanceof Error ? err.message : "agent_error";
					broadcast({ type: "error", runId, message });
					json(res, 500, { error: message, runId });
				} finally {
					clearTimeout(budget);
					unsub();
					deps.controller.setMode(finishChatRun(deps.controller.getMode()));
				}
				return;
			}

			if (url.pathname === "/api/control" && req.method === "POST") {
				const auth = authorize(req);
				if (!auth.ok) {
					json(res, 401, { error: auth.reason });
					return;
				}
				const body = await readBody(req, MAX_WS_MESSAGE_BYTES);
				const payload = JSON.parse(body) as {
					action: string;
					confirmedSafe?: boolean;
					origin?: string;
					targetId?: string;
					enabled?: boolean;
					mode?: BindingMode;
					revision?: number;
					url?: string;
					title?: string;
					windowId?: number;
					originPolicyMode?: OriginPolicyMode;
				};
				if (payload.action === "set_origin_policy" && payload.originPolicyMode) {
					await applyOriginPolicyChange(deps, payload.originPolicyMode, broadcast);
					json(res, 200, {
						originPolicyMode: deps.controller.originScope.getMode(),
						originPolicyRevision: deps.controller.originScope.getPolicyRevision(),
						mode: deps.controller.getMode(),
					});
					return;
				}
				if (payload.action === "set_agent_enabled") {
					await policy.setAgentEnabled(payload.enabled === true, deps.controller, deps.agentHost);
					json(res, 200, {
						agentEnabled: policy.agentEnabled,
						mode: deps.controller.getMode(),
					});
					return;
				}
				if (payload.action === "set_binding_mode" && payload.mode) {
					policy.setBindingMode(payload.mode);
					json(res, 200, { bindingMode: policy.bindingMode });
					return;
				}
				if (payload.action === "register_agent_window" && payload.windowId != null) {
					policy.registerAgentWindow(payload.windowId);
					json(res, 200, { ok: true });
					return;
				}
				if (payload.action === "select_tab") {
					if (payload.revision == null) {
						json(res, 400, { error: "missing_revision" });
						return;
					}
					const result = await policy.applyTabSelection(
						{
							revision: payload.revision,
							targetId: payload.targetId,
							url: payload.url,
							title: payload.title,
							windowId: payload.windowId,
						},
						deps.controller,
						deps.agentHost,
						deps.chromeState.cdpPort,
						() => {
							broadcast({
								type: "tab_changed",
								message: "Tab changed — send a new request to continue.",
							});
						},
					);
					if (!result.ok) {
						json(res, 409, { error: result.error });
						return;
					}
					deps.chromeState.taskTargetId = result.targetId;
					deps.chromeState.taskUrl = result.url;
					json(res, 200, { taskTab: result, bindingRevision: policy.bindingRevision });
					return;
				}
				if (payload.action === "pause") {
					deps.onPause();
					deps.controller.setPaused("manual");
					deps.controller.drainQueuedWork();
					deps.controller.invalidateObservations();
					await deps.agentHost.session.abort();
					json(res, 200, { mode: deps.controller.getMode() });
					return;
				}
				if (payload.action === "resume") {
					if (deps.controller.getMode() === "human_handoff") {
						json(res, 409, { error: "confirm_handoff_done" });
						return;
					}
					deps.onResume();
					deps.controller.setMode("idle");
					json(res, 200, { mode: "idle" });
					return;
				}
				if (payload.action === "human_handoff") {
					deps.onHumanHandoff(true);
					deps.controller.setMode("human_handoff");
					deps.controller.drainQueuedWork();
					deps.controller.invalidateObservations();
					await deps.agentHost.session.abort();
					json(res, 200, { mode: deps.controller.getMode() });
					return;
				}
				if (payload.action === "human_handoff_done") {
					if (!payload.confirmedSafe) {
						json(res, 400, { error: "confirmed_safe_required" });
						return;
					}
					deps.onHumanHandoff(false);
					deps.controller.invalidateObservations();
					deps.controller.setMode("idle");
					json(res, 200, { mode: "idle" });
					return;
				}
				if (payload.action === "approve_origin" && payload.origin) {
					deps.controller.originScope.approve(payload.origin);
					if (await deps.controller.tryClearPermissionPause()) {
						deps.onResume();
					}
					json(res, 200, { ok: true, mode: deps.controller.getMode() });
					return;
				}
				if (payload.action === "attach_tab") {
					const targetId = payload.targetId ?? deps.chromeState.taskTargetId;
					if (!targetId) {
						json(res, 400, { error: "missing_target_id" });
						return;
					}
					const revision = payload.revision ?? policy.bindingRevision + 1;
					const result = await policy.applyTabSelection(
						{
							revision,
							targetId,
							manualPin: true,
							windowId: payload.windowId,
						},
						deps.controller,
						deps.agentHost,
						deps.chromeState.cdpPort,
						() => {
							broadcast({
								type: "tab_changed",
								message: "Tab changed — send a new request to continue.",
							});
						},
					);
					if (!result.ok) {
						json(res, 409, { error: result.error });
						return;
					}
					deps.chromeState.taskTargetId = result.targetId;
					deps.chromeState.taskUrl = result.url;
					json(res, 200, { taskTab: result, bindingRevision: policy.bindingRevision });
					return;
				}
				if (payload.action === "detach_tab") {
					deps.controller.detachAgent();
					deps.chromeState.taskTargetId = "";
					json(res, 200, { mode: deps.controller.getMode(), tabAttached: false });
					return;
				}
				json(res, 400, { error: "unknown_action" });
				return;
			}

			json(res, 404, { error: "not_found" });
		} catch (err) {
			const message = err instanceof Error ? err.message : "server_error";
			json(res, 500, { error: message });
		}
	});

	return { server, broadcast, policy };
}
