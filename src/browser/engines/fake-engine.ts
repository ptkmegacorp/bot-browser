import {
	type BrowserEngine,
	type EngineBindResult,
	type EngineBindingState,
	type EngineErrorCode,
	type EngineObservation,
	type EngineObservationRef,
	type EngineOutcome,
	type EngineScreenshot,
	type RefOperationContext,
	truncateObservationText,
} from "../engine.js";
import type { ControlDescriptor } from "../safety.js";

export interface FakePageElement {
	ref: string;
	tag: string;
	role: string;
	name: string;
	value?: string;
	editable?: boolean;
	type?: string | null;
	autocomplete?: string | null;
	inForm?: boolean;
	options?: string[];
}

export interface FakePageState {
	url: string;
	title: string;
	bodyText: string;
	elements: FakePageElement[];
}

const DEFAULT_PAGE: FakePageState = {
	url: "https://fixture.test/",
	title: "Fixture",
	bodyText: "",
	elements: [],
};

export class FakeBrowserEngine implements BrowserEngine {
	private targetId: string | null = null;
	private bindingRevision = 0;
	private operationEpoch = 0;
	private observationSeq = 0;
	private page: FakePageState = { ...DEFAULT_PAGE, elements: [] };
	private lastObservation: EngineObservation | null = null;
	private actionQueue: Promise<void> = Promise.resolve();
	private observeHold: (() => Promise<void>) | null = null;
	private disposed = false;

	constructor(initial?: Partial<FakePageState>) {
		if (initial) this.setPage(initial);
	}

	forTestingHoldObserve(hold: () => Promise<void>): void {
		this.observeHold = hold;
	}

	setPage(partial: Partial<FakePageState>): void {
		this.page = {
			url: partial.url ?? this.page.url,
			title: partial.title ?? this.page.title,
			bodyText: partial.bodyText ?? this.page.bodyText,
			elements: (partial.elements ?? this.page.elements).map((el) => ({ ...el })),
		};
		this.invalidateObservations();
	}

	private invalidateObservations(): void {
		this.lastObservation = null;
		this.bindingRevision += 1;
	}

	private bumpEpoch(): void {
		this.operationEpoch += 1;
	}

	cancel(): void {
		if (this.disposed) return;
		this.bumpEpoch();
		this.actionQueue = Promise.resolve();
		this.invalidateObservations();
	}

	private assertNotDisposed(): void {
		if (this.disposed) throw new Error("engine_disposed");
	}

	private fail<T>(code: EngineErrorCode, message?: string): EngineOutcome<T> {
		return { ok: false, code, message };
	}

	private enqueue<T>(fn: (epoch: number) => Promise<EngineOutcome<T>>): Promise<EngineOutcome<T>> {
		const epoch = this.operationEpoch;
		const run = this.actionQueue.then(() => {
			if (epoch !== this.operationEpoch) {
				return this.fail<T>("operation_cancelled");
			}
			return fn(epoch);
		});
		this.actionQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
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
		const el = this.page.elements.find((e) => e.ref === ref);
		if (!el) {
			return this.fail("stale_ref", "element removed from page");
		}
		return { ok: true, data: undefined };
	}

	async bind(targetId: string): Promise<EngineOutcome<EngineBindResult>> {
		this.assertNotDisposed();
		this.targetId = targetId;
		this.invalidateObservations();
		return {
			ok: true,
			data: {
				targetId,
				url: this.page.url,
				title: this.page.title,
				bindingRevision: this.bindingRevision,
			},
		};
	}

	async getBindingState(): Promise<EngineBindingState> {
		return {
			live: this.targetId !== null && !this.disposed,
			targetId: this.targetId,
			url: this.targetId ? this.page.url : null,
			title: this.targetId ? this.page.title : null,
			bindingRevision: this.bindingRevision,
		};
	}

	async observe(): Promise<EngineOutcome<EngineObservation>> {
		return this.enqueue(async (epoch) => {
			if (!this.targetId) return this.fail("not_bound");
			if (this.observeHold) await this.observeHold();
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");

			this.observationSeq += 1;
			const observationId = `obs-${this.observationSeq}`;
			const generation = this.observationSeq;
			const refs: EngineObservationRef[] = this.page.elements.map((el) => ({
				ref: el.ref,
				role: el.role,
				name: el.name,
				value: el.value,
				editable: el.editable,
			}));

			const observation: EngineObservation = {
				observationId,
				targetId: this.targetId,
				url: this.page.url,
				title: this.page.title,
				generation,
				bindingRevision: this.bindingRevision,
				bodyText: truncateObservationText(this.page.bodyText),
				refs,
			};
			this.lastObservation = observation;
			return { ok: true, data: observation };
		});
	}

	async navigate(url: string): Promise<EngineOutcome<{ url: string }>> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			if (!this.targetId) return this.fail("not_bound");
			this.page.url = url;
			try {
				this.page.title = new URL(url).hostname;
			} catch {
				this.page.title = url;
			}
			this.invalidateObservations();
			return { ok: true, data: { url: this.page.url } };
		});
	}

	async click(ref: string, ctx: RefOperationContext): Promise<EngineOutcome<{ clicked: true }>> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			if (!this.targetId) return this.fail("not_bound");
			const check = this.validateRef(ctx, ref);
			if (!check.ok) return check;
			return { ok: true, data: { clicked: true } };
		});
	}

	async fill(
		ref: string,
		ctx: RefOperationContext,
		text: string,
	): Promise<EngineOutcome<{ filled: true }>> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			if (!this.targetId) return this.fail("not_bound");
			const check = this.validateRef(ctx, ref);
			if (!check.ok) return check;
			const el = this.page.elements.find((e) => e.ref === ref);
			if (!el) return this.fail("stale_ref");
			el.value = text;
			if (this.lastObservation) {
				const node = this.lastObservation.refs.find((r) => r.ref === ref);
				if (node) node.value = text;
			}
			return { ok: true, data: { filled: true } };
		});
	}

	async selectOption(
		ref: string,
		ctx: RefOperationContext,
		value: string,
	): Promise<EngineOutcome<{ selected: true }>> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			if (!this.targetId) return this.fail("not_bound");
			const check = this.validateRef(ctx, ref);
			if (!check.ok) return check;
			const el = this.page.elements.find((e) => e.ref === ref);
			if (!el || el.tag !== "select") return this.fail("invalid_argument", "not_a_select");
			if (el.options && !el.options.includes(value)) {
				return this.fail("invalid_argument", "unknown_option");
			}
			el.value = value;
			return { ok: true, data: { selected: true } };
		});
	}

	async scroll(_direction: "up" | "down"): Promise<EngineOutcome<{ scrolled: true }>> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			if (!this.targetId) return this.fail("not_bound");
			return { ok: true, data: { scrolled: true } };
		});
	}

	async screenshot(): Promise<EngineOutcome<EngineScreenshot>> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			if (!this.targetId) return this.fail("not_bound");
			const payload = Buffer.from(`fake-screenshot:${this.page.url}`, "utf8").toString("base64");
			const shot: EngineScreenshot = { mimeType: "image/png", base64: payload };
			return { ok: true, data: shot };
		});
	}

	async describeControl(ref: string, ctx: RefOperationContext): Promise<EngineOutcome<ControlDescriptor>> {
		if (!this.targetId) return this.fail("not_bound");
		const check = this.validateRef(ctx, ref);
		if (!check.ok) return check;
		const el = this.page.elements.find((e) => e.ref === ref);
		if (!el) return this.fail("stale_ref");
		const desc: ControlDescriptor = {
			tag: el.tag,
			type: el.type ?? null,
			role: el.role,
			inForm: el.inForm ?? false,
			label: el.name,
		};
		return { ok: true, data: desc };
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.cancel();
		this.targetId = null;
	}
}
