import type { Page } from "playwright";
import { debugEvent, type DebugContext } from "../debug-log.js";
import { cdpUrl } from "../config.js";
import { listCdpPages } from "../chrome/cdp.js";
import type { TabBindingStore } from "./binding.js";
import type { BrowserEngine, EngineErrorCode, EngineOutcome } from "./engine.js";
import { createBrowserEngine } from "./create-engine.js";
import { PlaywrightPageEngine } from "./engines/playwright-page.js";
import { OriginScope, originFromUrl } from "./origin-scope.js";
import { bumpDocumentGeneration, currentDocumentGeneration, type PageSnapshot } from "./snapshot.js";
import { isConsequentialControl, isSensitiveField, maskFieldValue } from "./safety.js";
import type { ActionVerification } from "./verification.js";
import {
	classifyPageLoad,
	describeClickNavigation,
	describeFieldValue,
	describeScroll,
} from "./verification.js";

export type AgentControlMode = "idle" | "running" | "paused" | "human_handoff";

/** Why the agent is paused; manual Stop survives reload until Resume. */
export type PauseReason = "manual" | "permission";

interface SnapshotCache {
	generation: number;
	observationId: string;
	bindingRevision: number;
	refs: Set<string>;
}

function throwEngineFailure(outcome: { ok: false; code: EngineErrorCode; message?: string }): never {
	const code = outcome.code;
	if (code === "stale_observation" || code === "stale_ref") {
		if (outcome.message?.includes("ref_element_missing")) {
			throw new Error("ref_element_missing");
		}
		throw new Error(code === "stale_observation" ? "stale_snapshot_generation" : "stale_snapshot_generation");
	}
	if (code === "unknown_ref") throw new Error("unknown_ref");
	if (code === "operation_cancelled") throw new Error("operation_cancelled");
	if (code === "not_bound") throw new Error("no_tab_attached");
	if (code === "target_unavailable") throw new Error("tab_not_attached");
	if (code === "invalid_argument" && outcome.message?.includes("not_a_select")) {
		throw new Error("not_a_select");
	}
	if (code === "invalid_argument" && outcome.message?.includes("ambiguous_tab_match")) {
		throw new Error("ambiguous_tab_match");
	}
	throw new Error(outcome.message ?? code);
}

function assertEngineOk<T>(outcome: EngineOutcome<T>): T {
	if (!outcome.ok) throwEngineFailure(outcome);
	return outcome.data;
}

export class BrowserController {
	private engine: BrowserEngine;
	private boundTargetId: string | null = null;
	private actionQueue: Promise<void> = Promise.resolve();
	private mode: AgentControlMode = "idle";
	private snapshotCache: SnapshotCache | null = null;
	private snapshotGeneration = 0;
	private operationEpoch = 0;
	private testMode = false;
	private testHold: (() => Promise<void>) | null = null;
	private pageEngine: PlaywrightPageEngine | null = null;
	private testPage: Page | null = null;
	private testBindReady: Promise<void> = Promise.resolve();
	private agentEnabled = true;
	private pauseReason: PauseReason | null = null;
	readonly originScope = new OriginScope();

	forTestingHoldSnapshot(hold: () => Promise<void>): void {
		this.testHold = hold;
		this.pageEngine?.forTestingHoldObserve(hold);
	}

	/** Attach a fake or stub engine binding without CDP (unit tests). */
	forTestingBindTarget(targetId: string): void {
		this.testMode = true;
		this.boundTargetId = targetId;
		this.bindings.setTarget(targetId, currentDocumentGeneration());
	}

	forTestingAttachPage(page: Page): void {
		this.testMode = true;
		this.testPage = page;
		this.pageEngine = new PlaywrightPageEngine(page);
		this.engine = this.pageEngine;
		this.boundTargetId = "test";
		this.bindings.setTarget("test", currentDocumentGeneration());
		this.testBindReady = this.pageEngine.bind("test").then(() => undefined);
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) this.invalidateObservations();
		});
	}

	constructor(
		private readonly bindings: TabBindingStore,
		private readonly cdpPort: number,
		engine?: BrowserEngine,
	) {
		this.engine = engine ?? createBrowserEngine(cdpPort);
	}

	/** Cached metadata only: logging never performs extra browser calls. */
	getDebugState(): DebugContext {
		return {
			engine: this.engine.constructor.name,
			targetId: this.boundTargetId,
			generation: this.snapshotGeneration,
			bindingRevision: this.snapshotCache?.bindingRevision,
		};
	}

	getMode(): AgentControlMode {
		return this.mode;
	}

	getAttachedTabUrl(): string | null {
		if (!this.boundTargetId) return null;
		if (this.testMode && this.testPage) return this.testPage.url();
		return null;
	}

	getBoundTargetId(): string | null {
		return this.boundTargetId;
	}

	isTabAttached(): boolean {
		return !!this.boundTargetId;
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
		if (this.testMode && this.pageEngine && this.boundTargetId) {
			await this.testBindReady;
			const state = await this.pageEngine.getBindingState();
			if (!state.live) {
				this.clearBinding();
				return { attached: false, targetId: null, url: null, title: null };
			}
			return {
				attached: true,
				targetId: this.boundTargetId,
				url: state.url,
				title: state.title,
			};
		}
		if (!this.boundTargetId) {
			return { attached: false, targetId: null, url: null, title: null };
		}
		const state = await this.engine.getBindingState();
		if (!state.live || state.targetId !== this.boundTargetId) {
			this.clearBinding();
			return { attached: false, targetId: null, url: null, title: null };
		}
		try {
			const pages = await listCdpPages(cdpUrl(this.cdpPort));
			const meta = pages.find((p) => p.id === this.boundTargetId);
			if (!meta) {
				this.clearBinding();
				return { attached: false, targetId: null, url: null, title: null };
			}
			return {
				attached: true,
				targetId: this.boundTargetId,
				url: state.url ?? meta.url,
				title: state.title ?? meta.title ?? "",
			};
		} catch {
			this.clearBinding();
			return { attached: false, targetId: null, url: null, title: null };
		}
	}

	setMode(mode: AgentControlMode): void {
		this.mode = mode;
		if (mode !== "paused") this.pauseReason = null;
	}

	getPauseReason(): PauseReason | null {
		return this.pauseReason;
	}

	setPaused(reason: PauseReason): void {
		this.pauseReason = reason;
		this.mode = "paused";
	}

	/** Clear permission pause when the task tab URL is allowed again. */
	async tryClearPermissionPause(): Promise<boolean> {
		if (this.mode !== "paused" || this.pauseReason !== "permission") return false;
		const state = await this.engine.getBindingState();
		if (!state.live || !state.url) return false;
		if (!this.originScope.revalidateCurrentUrl(state.url).ok) return false;
		this.setMode("idle");
		return true;
	}

	invalidateObservations(): void {
		this.snapshotCache = null;
		bumpDocumentGeneration();
		this.bumpOperationEpoch();
	}

	drainQueuedWork(): void {
		debugEvent("operation_cancel", this.getDebugState());
		this.bumpOperationEpoch();
		this.actionQueue = Promise.resolve();
		this.engine.cancel();
	}

	private bumpOperationEpoch(): void {
		this.operationEpoch += 1;
	}

	private observationsAllowed(): boolean {
		return this.mode !== "paused" && this.mode !== "human_handoff";
	}

	private maybeVerify(): boolean {
		return this.observationsAllowed();
	}

	private assertObservationsAllowed(): void {
		this.assertAgentEnabled();
		if (!this.observationsAllowed()) throw new Error("observations_paused");
	}

	private async assertOriginForUrl(url: string): Promise<void> {
		if (this.testMode) return;
		const origin = originFromUrl(url);
		if (!origin) throw new Error("invalid_url");
		const check = this.originScope.validateNavigation(url);
		if (!check.ok) throw new Error(check.reason);
	}

	async attachTab(targetId: string): Promise<{ url: string; targetId: string }> {
		if (this.testMode && this.pageEngine) {
			this.boundTargetId = targetId;
			await this.pageEngine.bind(targetId);
			this.bindings.setTarget(targetId, currentDocumentGeneration());
			const state = await this.pageEngine.getBindingState();
			return { url: state.url ?? "", targetId };
		}
		if (this.boundTargetId === targetId) {
			const state = await this.engine.getBindingState();
			if (state.live && state.targetId === targetId) {
				return { url: state.url ?? "", targetId };
			}
		}
		await this.connect(targetId);
		const state = await this.engine.getBindingState();
		return { url: state.url ?? "", targetId };
	}

	detachAgent(): void {
		this.drainQueuedWork();
		this.invalidateObservations();
		this.clearBinding();
		if (this.mode === "running") this.setMode("idle");
	}

	async connect(targetId: string): Promise<void> {
		if (this.testMode && this.pageEngine) {
			assertEngineOk(await this.pageEngine.bind(targetId));
			this.boundTargetId = targetId;
			this.bindings.setTarget(targetId, currentDocumentGeneration());
			return;
		}
		if (this.boundTargetId === targetId) {
			const state = await this.engine.getBindingState();
			if (state.live && state.targetId === targetId) return;
		}

		const meta = (await listCdpPages(cdpUrl(this.cdpPort))).find((p) => p.id === targetId);
		if (!meta) throw new Error("unknown_tab");

		const bound = await this.engine.bind(targetId);
		if (!bound.ok) {
			if (bound.code === "target_unavailable") throw new Error("tab_not_attached");
			throwEngineFailure(bound);
		}

		this.boundTargetId = targetId;
		this.bindings.setTarget(targetId, currentDocumentGeneration());
	}

	private async assertBound(): Promise<void> {
		if (this.testMode) {
			await this.testBindReady;
			if (!this.boundTargetId) throw new Error("no_tab_attached");
			return;
		}
		if (!this.boundTargetId) throw new Error("no_tab_attached");
		const state = await this.engine.getBindingState();
		if (!state.live || state.targetId !== this.boundTargetId) {
			throw new Error("stale_tab_binding");
		}
	}

	private async withBound<T>(fn: () => Promise<T>): Promise<T> {
		this.assertObservationsAllowed();
		await this.assertBound();
		const state = await this.engine.getBindingState();
		await this.assertOriginForUrl(state.url ?? "about:blank");
		if (!this.testMode) {
			const binding = this.bindings.get();
			if (!binding) throw new Error("no_tab_binding");
		}
		return fn();
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

	private refContext(generation: number): {
		observationId: string;
		generation: number;
		bindingRevision: number;
	} {
		if (!this.snapshotCache || this.snapshotCache.generation !== generation) {
			throw new Error("stale_snapshot_generation");
		}
		return {
			observationId: this.snapshotCache.observationId,
			generation: this.snapshotCache.generation,
			bindingRevision: this.snapshotCache.bindingRevision,
		};
	}

	private observationToPageSnapshot(obs: {
		url: string;
		title: string;
		generation: number;
		bodyText?: string;
		refs: Array<{ ref: string; role: string; name: string; value?: string; editable?: boolean }>;
	}): PageSnapshot {
		return {
			url: obs.url,
			title: obs.title,
			generation: obs.generation,
			readableText: obs.bodyText,
			nodes: obs.refs.map((n) => ({
				ref: n.ref,
				role: n.role,
				name: n.name,
				value: n.value,
				editable: n.editable,
			})),
		};
	}

	private async revalidateBoundOriginAfterAction(): Promise<void> {
		const state = await this.engine.getBindingState();
		if (!state.live || !state.url) throw new Error("tab_not_attached");
		await this.assertOriginForUrl(state.url);
	}

	async snapshot(): Promise<PageSnapshot> {
		if (!this.observationsAllowed()) throw new Error("observations_paused");
		return this.enqueue(async (epoch) => {
			if (this.testHold) await this.testHold();
			if (epoch !== this.operationEpoch || !this.observationsAllowed()) {
				throw new Error("observations_paused");
			}
			this.assertObservationsAllowed();
			await this.assertBound();
			if (epoch !== this.operationEpoch) throw new Error("operation_cancelled");

			const outcome = await this.engine.observe();
			if (epoch !== this.operationEpoch || !this.observationsAllowed()) {
				throw new Error("observations_paused");
			}
			const obs = assertEngineOk(outcome);
			await this.assertOriginForUrl(obs.url);

			this.snapshotGeneration = obs.generation;
			this.snapshotCache = {
				generation: obs.generation,
				observationId: obs.observationId,
				bindingRevision: obs.bindingRevision,
				refs: new Set(obs.refs.map((r) => r.ref)),
			};
			return this.observationToPageSnapshot(obs);
		});
	}

	async navigate(url: string): Promise<{ url: string; verification?: ActionVerification }> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) throw new Error("operation_cancelled");
			return this.withBound(async () => {
				const check = this.originScope.validateNavigation(url);
				if (!check.ok) throw new Error(check.reason);
				const state = await this.engine.getBindingState();
				const before = state.url ?? "";
				const outcome = await this.engine.navigate(url);
				const after = assertEngineOk(outcome).url;
				const landed = this.originScope.validateNavigation(after);
				if (!landed.ok) throw new Error(landed.reason);
				const redirect = this.originScope.checkRedirect(before || url, after);
				if (!redirect.ok) throw new Error(redirect.reason);
				this.invalidateObservations();
				let verification: ActionVerification | undefined;
				if (this.maybeVerify()) {
					const facts = assertEngineOk(await this.engine.readPageFacts());
					verification = classifyPageLoad(facts, url);
				}
				return { url: after, verification };
			});
		});
	}

	async click(
		ref: string,
		generation: number,
	): Promise<{ ok: boolean; blocked?: string; verification?: ActionVerification }> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) throw new Error("operation_cancelled");
			return this.withBound(async () => {
				this.validateRef(generation, ref);
				const ctx = this.refContext(generation);
				const descOutcome = await this.engine.describeControl(ref, ctx);
				const desc = assertEngineOk(descOutcome);
				if (isConsequentialControl(desc)) {
					return { ok: false, blocked: "risky_click_requires_human" };
				}
				const beforeBinding = await this.engine.getBindingState();
				const before = { url: beforeBinding.url ?? "", title: beforeBinding.title ?? "" };
				assertEngineOk(await this.engine.click(ref, ctx));
				await this.revalidateBoundOriginAfterAction();
				let verification: ActionVerification | undefined;
				if (this.maybeVerify()) {
					const afterBinding = await this.engine.getBindingState();
					verification = describeClickNavigation(before, {
						url: afterBinding.url ?? "",
						title: afterBinding.title ?? "",
					});
				}
				this.invalidateObservations();
				return { ok: true, verification };
			});
		});
	}

	async fill(
		ref: string,
		generation: number,
		text: string,
	): Promise<{ ok: boolean; blocked?: string; verification?: ActionVerification }> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) throw new Error("operation_cancelled");
			return this.withBound(async () => {
				this.validateRef(generation, ref);
				const ctx = this.refContext(generation);
				const descOutcome = await this.engine.describeControl(ref, ctx);
				const desc = assertEngineOk(descOutcome);
				if (isSensitiveField(desc.type, desc.autocomplete ?? null, desc.name ?? null)) {
					return { ok: false, blocked: "sensitive_field_human_only" };
				}
				assertEngineOk(await this.engine.fill(ref, ctx, text));
				let verification: ActionVerification | undefined;
				if (this.maybeVerify()) {
					const readback = assertEngineOk(await this.engine.describeControl(ref, ctx));
					const masked = maskFieldValue(
						readback.type,
						readback.autocomplete ?? null,
						readback.name ?? null,
						readback.value ?? "",
					);
					verification = describeFieldValue(readback.label, masked, text);
				}
				return { ok: true, verification };
			});
		});
	}

	async selectOption(
		ref: string,
		generation: number,
		value: string,
	): Promise<{ ok: boolean; verification?: ActionVerification }> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) throw new Error("operation_cancelled");
			return this.withBound(async () => {
				this.validateRef(generation, ref);
				const ctx = this.refContext(generation);
				assertEngineOk(await this.engine.selectOption(ref, ctx, value));
				let verification: ActionVerification | undefined;
				if (this.maybeVerify()) {
					const readback = assertEngineOk(await this.engine.describeControl(ref, ctx));
					const masked = maskFieldValue(
						readback.type,
						readback.autocomplete ?? null,
						readback.name ?? null,
						readback.value ?? "",
					);
					verification = describeFieldValue(readback.label, masked, value);
				}
				this.invalidateObservations();
				return { ok: true, verification };
			});
		});
	}

	async scroll(direction: "up" | "down"): Promise<{ ok: boolean; verification?: ActionVerification }> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) throw new Error("operation_cancelled");
			return this.withBound(async () => {
				let verification: ActionVerification | undefined;
				if (this.maybeVerify()) {
					const beforeFacts = assertEngineOk(await this.engine.readPageFacts());
					assertEngineOk(await this.engine.scroll(direction));
					const afterFacts = assertEngineOk(await this.engine.readPageFacts());
					verification = describeScroll(afterFacts, beforeFacts.scrollY);
				} else {
					assertEngineOk(await this.engine.scroll(direction));
				}
				return { ok: true, verification };
			});
		});
	}

	async screenshot(): Promise<{ mimeType: "image/png"; base64: string }> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) throw new Error("operation_cancelled");
			return this.withBound(async () => {
				return assertEngineOk(await this.engine.screenshot());
			});
		});
	}

	async dispose(): Promise<void> {
		await this.engine.dispose();
		this.boundTargetId = null;
	}
}
