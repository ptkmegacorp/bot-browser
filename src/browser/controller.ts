import { chromium, type BrowserContext, type Page } from "playwright";
import { cdpUrl } from "../config.js";
import { listCdpPages } from "../chrome/cdp.js";
import type { TabBindingStore } from "./binding.js";
import { getCdpTargetId } from "./cdp-page.js";
import { collectInteractiveElements, ElementRegistry } from "./element-registry.js";
import { OriginScope, originFromUrl } from "./origin-scope.js";
import {
	bumpDocumentGeneration,
	buildSnapshotFromHandles,
	currentDocumentGeneration,
	MAX_SNAPSHOT_NODES,
	type PageSnapshot,
} from "./snapshot.js";
import { isConsequentialControl, isSensitiveField } from "./safety.js";

export type AgentControlMode = "idle" | "running" | "paused" | "human_handoff";

interface SnapshotCache {
	generation: number;
	refs: Set<string>;
}

export class BrowserController {
	private browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
	private context: BrowserContext | null = null;
	private page: Page | null = null;
	private boundTargetId: string | null = null;
	private actionQueue: Promise<void> = Promise.resolve();
	private mode: AgentControlMode = "idle";
	private snapshotCache: SnapshotCache | null = null;
	private snapshotGeneration = 0;
	private operationEpoch = 0;
	private readonly elementRegistry = new ElementRegistry();
	private testMode = false;
	private testHold: (() => Promise<void>) | null = null;
	private agentEnabled = true;
	readonly originScope = new OriginScope();

	forTestingHoldSnapshot(hold: () => Promise<void>): void {
		this.testHold = hold;
	}

	forTestingAttachPage(page: Page): void {
		this.testMode = true;
		this.page = page;
		this.boundTargetId = "test";
		this.bindings.setTarget("test", currentDocumentGeneration());
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) this.invalidateObservations();
		});
	}

	constructor(
		private readonly bindings: TabBindingStore,
		private readonly cdpPort: number,
	) {}

	getMode(): AgentControlMode {
		return this.mode;
	}

	getAttachedTabUrl(): string | null {
		if (!this.page || !this.boundTargetId) return null;
		return this.page.url();
	}

	getBoundTargetId(): string | null {
		return this.boundTargetId;
	}

	isTabAttached(): boolean {
		return !!(this.page && this.boundTargetId);
	}

	setAgentEnabled(enabled: boolean): void {
		this.agentEnabled = enabled;
	}

	isAgentEnabled(): boolean {
		return this.agentEnabled;
	}

	private assertAgentEnabled(): void {
		if (!this.agentEnabled) throw new Error("agent_disabled");
	}

	private clearBinding(): void {
		this.page = null;
		this.boundTargetId = null;
		this.bindings.clear();
	}

	/** Verify CDP binding; clear stale state when tab closed or detached. */
	async syncLiveBinding(): Promise<{
		attached: boolean;
		targetId: string | null;
		url: string | null;
		title: string | null;
	}> {
		if (this.testMode && this.page && this.boundTargetId) {
			const title = await this.page.title().catch(() => "");
			return {
				attached: true,
				targetId: this.boundTargetId,
				url: this.page.url(),
				title,
			};
		}
		if (!this.page || !this.boundTargetId) {
			return { attached: false, targetId: null, url: null, title: null };
		}
		try {
			const id = await getCdpTargetId(this.page);
			if (id !== this.boundTargetId) {
				this.clearBinding();
				return { attached: false, targetId: null, url: null, title: null };
			}
			const pages = await listCdpPages(cdpUrl(this.cdpPort));
			const meta = pages.find((p) => p.id === id);
			if (!meta) {
				this.clearBinding();
				return { attached: false, targetId: null, url: null, title: null };
			}
			return {
				attached: true,
				targetId: id,
				url: this.page.url(),
				title: meta.title ?? "",
			};
		} catch {
			this.clearBinding();
			return { attached: false, targetId: null, url: null, title: null };
		}
	}

	setMode(mode: AgentControlMode): void {
		this.mode = mode;
	}

	invalidateObservations(): void {
		this.snapshotCache = null;
		this.elementRegistry.clear();
		bumpDocumentGeneration();
		this.bumpOperationEpoch();
	}

	drainQueuedWork(): void {
		this.bumpOperationEpoch();
		this.actionQueue = Promise.resolve();
	}

	private bumpOperationEpoch(): void {
		this.operationEpoch += 1;
	}

	private observationsAllowed(): boolean {
		return this.mode !== "paused" && this.mode !== "human_handoff";
	}

	private assertObservationsAllowed(): void {
		this.assertAgentEnabled();
		if (!this.observationsAllowed()) throw new Error("observations_paused");
	}

	private assertOriginForPage(page: Page): void {
		if (this.testMode) return;
		const origin = originFromUrl(page.url());
		if (!origin) throw new Error("invalid_url");
		const check = this.originScope.validateNavigation(page.url());
		if (!check.ok) throw new Error(check.reason);
	}

	private async isBoundTo(targetId: string): Promise<boolean> {
		if (!this.page || this.boundTargetId !== targetId) return false;
		try {
			const id = await getCdpTargetId(this.page);
			return id === targetId;
		} catch {
			return false;
		}
	}

	async attachTab(targetId: string): Promise<{ url: string; targetId: string }> {
		if (this.testMode) {
			this.boundTargetId = targetId;
			this.bindings.setTarget(targetId, currentDocumentGeneration());
			return { url: this.page?.url() ?? "", targetId };
		}
		if (await this.isBoundTo(targetId)) {
			const page = await this.assertBoundPage();
			return { url: page.url(), targetId };
		}
		await this.connect(targetId);
		const page = await this.assertBoundPage();
		return { url: page.url(), targetId };
	}

	detachAgent(): void {
		this.drainQueuedWork();
		this.invalidateObservations();
		this.clearBinding();
		if (this.mode === "running") this.setMode("idle");
	}

	async connect(targetId: string): Promise<void> {
		if (await this.isBoundTo(targetId)) return;
		if (!this.browser) this.browser = await chromium.connectOverCDP(cdpUrl(this.cdpPort));
		const contexts = this.browser.contexts();
		this.context = contexts[0] ?? null;
		if (!this.context) throw new Error("no_browser_context");

		const pages = this.context.pages();
		let matched: Page | null = null;
		for (const page of pages) {
			try {
				const id = await getCdpTargetId(page);
				if (id === targetId) {
					matched = page;
					break;
				}
			} catch {
				/* try next */
			}
		}
		if (!matched) {
			const meta = (await listCdpPages(cdpUrl(this.cdpPort))).find((p) => p.id === targetId);
			if (!meta) throw new Error("unknown_tab");
			throw new Error("tab_not_attached");
		}

		this.page = matched;
		this.boundTargetId = targetId;
		this.page.on("close", () => {
			this.page = null;
			this.boundTargetId = null;
			this.bindings.clear();
			this.invalidateObservations();
		});
		this.page.on("framenavigated", (frame) => {
			if (frame === this.page?.mainFrame()) {
				this.invalidateObservations();
			}
		});

		this.bindings.setTarget(targetId, currentDocumentGeneration());
	}

	private async assertBoundPage(): Promise<Page> {
		if (this.testMode && this.page) return this.page;
		if (!this.page || !this.boundTargetId) throw new Error("no_tab_attached");
		const id = await getCdpTargetId(this.page);
		if (id !== this.boundTargetId) throw new Error("stale_tab_binding");
		return this.page;
	}

	private async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
		this.assertObservationsAllowed();
		const page = await this.assertBoundPage();
		this.assertOriginForPage(page);
		if (!this.testMode) {
			const binding = this.bindings.get();
			if (!binding) throw new Error("no_tab_binding");
		}
		return fn(page);
	}

	private enqueue<T>(fn: (epoch: number) => Promise<T>): Promise<T> {
		const epoch = this.operationEpoch;
		const run = this.actionQueue.then(async () => {
			if (epoch !== this.operationEpoch) throw new Error("operation_cancelled");
			return fn(epoch);
		});
		this.actionQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private validateRef(generation: number, ref: string): void {
		if (!this.snapshotCache || this.snapshotCache.generation !== generation) {
			throw new Error("stale_snapshot_generation");
		}
		if (!this.snapshotCache.refs.has(ref)) {
			throw new Error("unknown_ref");
		}
		if (generation !== this.snapshotGeneration) {
			throw new Error("stale_snapshot_generation");
		}
	}

	async snapshot(): Promise<PageSnapshot> {
		if (!this.observationsAllowed()) throw new Error("observations_paused");
		return this.enqueue(async (epoch) => {
			if (this.testHold) await this.testHold();
			if (epoch !== this.operationEpoch || !this.observationsAllowed()) {
				throw new Error("observations_paused");
			}
			this.assertObservationsAllowed();
			const page = await this.assertBoundPage();
			this.assertOriginForPage(page);
			if (epoch !== this.operationEpoch) throw new Error("operation_cancelled");

			this.snapshotGeneration += 1;
			const generation = this.snapshotGeneration;
			this.elementRegistry.clear();
			const handles = await collectInteractiveElements(page, MAX_SNAPSHOT_NODES);
			for (let i = 0; i < handles.length; i++) {
				this.elementRegistry.set(`e${i + 1}`, generation, handles[i]!);
			}
			const snap = await buildSnapshotFromHandles(page, generation, handles);

			if (!this.observationsAllowed() || epoch !== this.operationEpoch) {
				throw new Error("observations_paused");
			}

			this.snapshotCache = {
				generation: snap.generation,
				refs: new Set(snap.nodes.map((n) => n.ref)),
			};
			return snap;
		});
	}

	async navigate(url: string): Promise<{ url: string }> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) throw new Error("operation_cancelled");
			return this.withPage(async (page) => {
				const check = this.originScope.validateNavigation(url);
				if (!check.ok) throw new Error(check.reason);
				const before = page.url();
				await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
				const after = page.url();
				const redirect = this.originScope.checkRedirect(before, after);
				if (!redirect.ok) throw new Error(redirect.reason);
				this.invalidateObservations();
				return { url: after };
			});
		});
	}

	async click(ref: string, generation: number): Promise<{ ok: boolean; blocked?: string }> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) throw new Error("operation_cancelled");
			return this.withPage(async () => {
				this.validateRef(generation, ref);
				const handle = await this.elementRegistry.resolveConnected(ref, generation);
				const desc = await handle.evaluate((el) => {
					const tag = el.tagName.toLowerCase();
					const type = el.getAttribute("type");
					const role = el.getAttribute("role");
					const formId = el.getAttribute("form");
					let inForm = false;
					if ("form" in el && (el as HTMLButtonElement).form) inForm = true;
					else if (formId && document.getElementById(formId)) inForm = true;
					else if (el.closest("form")) inForm = true;
					const label =
						el.getAttribute("aria-label") ||
						(el.textContent ?? "").trim() ||
						el.getAttribute("value") ||
						"";
					return { tag, type, role, inForm, label };
				});
				if (isConsequentialControl(desc)) {
					return { ok: false, blocked: "risky_click_requires_human" };
				}
				await handle.click({ timeout: 10_000 });
				this.invalidateObservations();
				return { ok: true };
			});
		});
	}

	async fill(ref: string, generation: number, text: string): Promise<{ ok: boolean; blocked?: string }> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) throw new Error("operation_cancelled");
			return this.withPage(async () => {
				this.validateRef(generation, ref);
				const handle = await this.elementRegistry.resolveConnected(ref, generation);
				const meta = await handle.evaluate((el) => ({
					type: el.getAttribute("type"),
					autocomplete: el.getAttribute("autocomplete"),
					name: el.getAttribute("name"),
				}));
				if (isSensitiveField(meta.type, meta.autocomplete, meta.name)) {
					return { ok: false, blocked: "sensitive_field_human_only" };
				}
				await handle.fill(text);
				return { ok: true };
			});
		});
	}

	async selectOption(ref: string, generation: number, value: string): Promise<{ ok: boolean }> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) throw new Error("operation_cancelled");
			return this.withPage(async () => {
				this.validateRef(generation, ref);
				const handle = await this.elementRegistry.resolveConnected(ref, generation);
				const tag = await handle.evaluate((el) => el.tagName.toLowerCase());
				if (tag !== "select") throw new Error("not_a_select");
				await handle.selectOption(value);
				return { ok: true };
			});
		});
	}

	async scroll(direction: "up" | "down"): Promise<{ ok: boolean }> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) throw new Error("operation_cancelled");
			return this.withPage(async (page) => {
				const delta = direction === "down" ? 600 : -600;
				await page.mouse.wheel(0, delta);
				return { ok: true };
			});
		});
	}

	async dispose(): Promise<void> {
		this.elementRegistry.clear();
		this.page = null;
		this.context = null;
		this.boundTargetId = null;
		await this.browser?.close().catch(() => {});
		this.browser = null;
	}
}
