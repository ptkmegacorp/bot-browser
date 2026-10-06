import type { Page } from "playwright";
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
import { collectInteractiveElements, ElementRegistry } from "../element-registry.js";
import { buildSnapshotFromHandles, MAX_SNAPSHOT_NODES } from "../snapshot.js";
import type { ControlDescriptor } from "../safety.js";
import { getCdpTargetId } from "../cdp-page.js";

/** Synthetic target id used by BrowserController.forTestingAttachPage. */
export const PLAYWRIGHT_PAGE_TEST_TARGET_ID = "test";

/** In-process Playwright page engine for unit tests (real DOM + element handles). */
export class PlaywrightPageEngine implements BrowserEngine {
	private targetId: string | null = null;
	private bindingRevision = 0;
	private observationSeq = 0;
	private lastObservation: EngineObservation | null = null;
	private readonly elementRegistry = new ElementRegistry();
	private observeHold: (() => Promise<void>) | null = null;

	constructor(private page: Page) {}

	forTestingHoldObserve(hold: () => Promise<void>): void {
		this.observeHold = hold;
	}

	setPage(page: Page): void {
		this.page = page;
		this.invalidateObservations();
	}

	private invalidateObservations(): void {
		this.lastObservation = null;
		this.elementRegistry.clear();
		this.bindingRevision += 1;
	}

	private fail<T>(code: EngineErrorCode, message?: string): EngineOutcome<T> {
		return { ok: false, code, message };
	}

	private validateRef(ctx: RefOperationContext, ref: string): EngineOutcome<void> {
		if (!this.lastObservation) {
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

	async bind(targetId: string): Promise<EngineOutcome<EngineBindResult>> {
		this.targetId = targetId;
		this.invalidateObservations();
		const title = await this.page.title().catch(() => "");
		return {
			ok: true,
			data: {
				targetId,
				url: this.page.url(),
				title,
				bindingRevision: this.bindingRevision,
			},
		};
	}

	async getBindingState(): Promise<EngineBindingState> {
		if (!this.targetId) {
			return { live: false, targetId: null, url: null, title: null, bindingRevision: this.bindingRevision };
		}
		if (this.targetId === PLAYWRIGHT_PAGE_TEST_TARGET_ID) {
			const title = await this.page.title().catch(() => "");
			return {
				live: true,
				targetId: this.targetId,
				url: this.page.url(),
				title,
				bindingRevision: this.bindingRevision,
			};
		}
		try {
			const id = await getCdpTargetId(this.page);
			if (id !== this.targetId) {
				return { live: false, targetId: null, url: null, title: null, bindingRevision: this.bindingRevision };
			}
		} catch {
			return { live: false, targetId: null, url: null, title: null, bindingRevision: this.bindingRevision };
		}
		const title = await this.page.title().catch(() => "");
		return {
			live: true,
			targetId: this.targetId,
			url: this.page.url(),
			title,
			bindingRevision: this.bindingRevision,
		};
	}

	async observe(): Promise<EngineOutcome<EngineObservation>> {
		if (!this.targetId) return this.fail("not_bound");
		if (this.observeHold) await this.observeHold();

		this.observationSeq += 1;
		const generation = this.observationSeq;
		const observationId = `obs-${generation}`;
		this.elementRegistry.clear();
		const handles = await collectInteractiveElements(this.page, MAX_SNAPSHOT_NODES);
		for (let i = 0; i < handles.length; i++) {
			this.elementRegistry.set(`e${i + 1}`, generation, handles[i]!);
		}
		const snap = await buildSnapshotFromHandles(this.page, generation, handles);
		const refs = snap.nodes.map((n) => ({
			ref: n.ref,
			role: n.role,
			name: n.name,
			value: n.value,
			editable: n.editable,
		}));

		const observation: EngineObservation = {
			observationId,
			targetId: this.targetId,
			url: snap.url,
			title: snap.title,
			generation,
			bindingRevision: this.bindingRevision,
			bodyText: truncateObservationText(""),
			refs,
		};
		this.lastObservation = observation;
		return { ok: true, data: observation };
	}

	async navigate(url: string): Promise<EngineOutcome<{ url: string }>> {
		if (!this.targetId) return this.fail("not_bound");
		await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
		this.invalidateObservations();
		return { ok: true, data: { url: this.page.url() } };
	}

	async click(ref: string, ctx: RefOperationContext): Promise<EngineOutcome<{ clicked: true }>> {
		const check = this.validateRef(ctx, ref);
		if (!check.ok) return check;
		try {
			const handle = await this.elementRegistry.resolveConnected(ref, ctx.generation);
			await handle.click({ timeout: 10_000 });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("ref_element_missing")) return this.fail("stale_ref", "ref_element_missing");
			if (msg.includes("stale_snapshot")) return this.fail("stale_observation");
			throw err;
		}
		this.invalidateObservations();
		return { ok: true, data: { clicked: true } };
	}

	async fill(
		ref: string,
		ctx: RefOperationContext,
		text: string,
	): Promise<EngineOutcome<{ filled: true }>> {
		const check = this.validateRef(ctx, ref);
		if (!check.ok) return check;
		try {
			const handle = await this.elementRegistry.resolveConnected(ref, ctx.generation);
			await handle.fill(text);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("ref_element_missing")) return this.fail("stale_ref", "ref_element_missing");
			if (msg.includes("stale_snapshot")) return this.fail("stale_observation");
			throw err;
		}
		return { ok: true, data: { filled: true } };
	}

	async selectOption(
		ref: string,
		ctx: RefOperationContext,
		value: string,
	): Promise<EngineOutcome<{ selected: true }>> {
		const check = this.validateRef(ctx, ref);
		if (!check.ok) return check;
		try {
			const handle = await this.elementRegistry.resolveConnected(ref, ctx.generation);
			const tag = await handle.evaluate((el) => el.tagName.toLowerCase());
			if (tag !== "select") return this.fail("invalid_argument", "not_a_select");
			await handle.selectOption(value);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("ref_element_missing")) return this.fail("stale_ref", "ref_element_missing");
			throw err;
		}
		this.invalidateObservations();
		return { ok: true, data: { selected: true } };
	}

	async scroll(direction: "up" | "down"): Promise<EngineOutcome<{ scrolled: true }>> {
		if (!this.targetId) return this.fail("not_bound");
		const delta = direction === "down" ? 600 : -600;
		await this.page.mouse.wheel(0, delta);
		return { ok: true, data: { scrolled: true } };
	}

	async screenshot(): Promise<EngineOutcome<EngineScreenshot>> {
		if (!this.targetId) return this.fail("not_bound");
		const buf = await this.page.screenshot({ type: "png" });
		return { ok: true, data: { mimeType: "image/png", base64: buf.toString("base64") } };
	}

	async describeControl(ref: string, ctx: RefOperationContext): Promise<EngineOutcome<ControlDescriptor>> {
		if (!this.targetId) return this.fail("not_bound");
		const check = this.validateRef(ctx, ref);
		if (!check.ok) return check;
		try {
			const handle = await this.elementRegistry.resolveConnected(ref, ctx.generation);
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
				const autocomplete = el.getAttribute("autocomplete");
				const name = el.getAttribute("name");
				return { tag, type, role, inForm, label, autocomplete, name };
			});
			return { ok: true, data: desc };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("ref_element_missing")) return this.fail("stale_ref", "ref_element_missing");
			throw err;
		}
	}

	cancel(): void {
		this.invalidateObservations();
	}

	async dispose(): Promise<void> {
		this.elementRegistry.clear();
		this.targetId = null;
	}
}
