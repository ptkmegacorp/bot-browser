import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cdpWebSocketUrl, listCdpPages } from "../../chrome/cdp.js";
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
import { maskFieldValue } from "../safety.js";
import type { PageFacts } from "../verification.js";
import { AnchortreeSidecarClient } from "./anchortree-sidecar-client.js";

export interface AnchortreeEngineOptions {
	cdpUrl: string;
	sidecarPath?: string;
}

export const ANCHORTREE_UPSTREAM_REVISION = "2f085c506e9fa92e24940ba7c280545a35bee529";

function maskRefs(obs: EngineObservation): EngineObservation {
	return {
		...obs,
		refs: obs.refs.map((r) => ({
			...r,
			value: r.value
				? maskFieldValue(null, null, r.name, r.value)
				: undefined,
		})),
		bodyText: obs.bodyText,
	};
}

function fromSidecar<T>(result: Awaited<ReturnType<AnchortreeSidecarClient["call"]>>): EngineOutcome<T> {
	if (result.ok) return { ok: true, data: result.data as T };
	return { ok: false, code: result.error.code, message: result.error.message };
}

export class AnchortreeEngine implements BrowserEngine {
	private readonly client: AnchortreeSidecarClient;
	private readonly preparedControls = new Map<
		string,
		{ bindingRevision: number; desc: ControlDescriptor }
	>();
	private targetId: string | null = null;
	private bindingRevision = 0;
	private lastObservation: EngineObservation | null = null;
	private actionQueue: Promise<void> = Promise.resolve();
	private operationEpoch = 0;

	constructor(private readonly options: AnchortreeEngineOptions) {
		this.client = new AnchortreeSidecarClient({ sidecarPath: options.sidecarPath });
	}

	private fail<T>(code: EngineErrorCode, message?: string): EngineOutcome<T> {
		return { ok: false, code, message };
	}

	private bumpEpoch(): void {
		this.operationEpoch += 1;
		this.client.cancel();
	}

	private invalidateObservations(): void {
		this.lastObservation = null;
		this.preparedControls.clear();
		this.bindingRevision += 1;
	}

	cancel(): void {
		this.bumpEpoch();
		this.actionQueue = Promise.resolve();
		this.invalidateObservations();
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

	async bind(targetId: string): Promise<EngineOutcome<EngineBindResult>> {
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			const pages = await listCdpPages(this.options.cdpUrl);
			const meta = pages.find((p) => p.id === targetId);
			if (!meta) return this.fail("target_unavailable", "unknown_tab");

			const nextRevision = this.bindingRevision + 1;
			const wsUrl = await cdpWebSocketUrl(this.options.cdpUrl);
			const result = fromSidecar<EngineBindResult>(
				await this.client.call("bind", {
					cdpWsUrl: wsUrl,
					targetId,
					bindingRevision: nextRevision,
				}),
			);
			if (!result.ok) return result;
			if (result.data.bindingRevision !== nextRevision) {
				return this.fail("stale_ref", "stale sidecar bind acknowledgement");
			}
			if (result.data.targetId !== targetId) {
				return this.fail("target_unavailable", "bind target mismatch");
			}

			this.targetId = targetId;
			this.bindingRevision = result.data.bindingRevision;
			this.lastObservation = null;
			return { ok: true, data: result.data };
		});
	}

	async getBindingState(): Promise<EngineBindingState> {
		if (!this.targetId) {
			return { live: false, targetId: null, url: null, title: null, bindingRevision: this.bindingRevision };
		}
		const remote = fromSidecar<EngineBindingState>(await this.client.call("getBindingState", {}));
		if (!remote.ok) {
			return { live: false, targetId: this.targetId, url: null, title: null, bindingRevision: this.bindingRevision };
		}
		const data = remote.data;
		if (!data.live || data.targetId !== this.targetId) {
			return { live: false, targetId: this.targetId, url: null, title: null, bindingRevision: this.bindingRevision };
		}
		return data;
	}

	async observe(): Promise<EngineOutcome<EngineObservation>> {
		return this.enqueue(async (epoch) => {
			if (!this.targetId) return this.fail("not_bound");
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			const result = fromSidecar<EngineObservation>(await this.client.call("observe", {}));
			if (!result.ok) return result;
			const obs = maskRefs({
				...result.data,
				bodyText: truncateObservationText(result.data.bodyText),
				bindingRevision: this.bindingRevision,
			});
			this.lastObservation = obs;
			return { ok: true, data: obs };
		});
	}

	async navigate(url: string): Promise<EngineOutcome<{ url: string }>> {
		return this.enqueue(async (epoch) => {
			if (!this.targetId) return this.fail("not_bound");
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			const result = fromSidecar<{ url: string }>(await this.client.call("navigate", { url }));
			if (!result.ok) return result;
			this.invalidateObservations();
			return result;
		});
	}

	async click(ref: string, ctx: RefOperationContext): Promise<EngineOutcome<{ clicked: true }>> {
		return this.mutate(ref, ctx, "click", { clicked: true });
	}

	async fill(
		ref: string,
		ctx: RefOperationContext,
		text: string,
	): Promise<EngineOutcome<{ filled: true }>> {
		return this.mutate(ref, ctx, "fill", { filled: true }, { text });
	}

	async selectOption(
		ref: string,
		ctx: RefOperationContext,
		value: string,
	): Promise<EngineOutcome<{ selected: true }>> {
		return this.mutate(ref, ctx, "selectOption", { selected: true }, { value });
	}

	private mutate<T extends { clicked: true } | { filled: true } | { selected: true }>(
		ref: string,
		ctx: RefOperationContext,
		method: string,
		success: T,
		extra?: Record<string, string>,
	): Promise<EngineOutcome<T>> {
		return this.enqueue(async (epoch) => {
			if (!this.targetId) return this.fail("not_bound");
			const check = this.validateRef(ctx, ref);
			if (!check.ok) return check;
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			const prepared = this.preparedControls.get(ref);
			if (!prepared || prepared.bindingRevision !== ctx.bindingRevision) {
				return this.fail("stale_observation", "missing prepared control preflight");
			}
			const result = fromSidecar<T>(
				await this.client.call(method, {
					ref,
					bindingRevision: ctx.bindingRevision,
					prepared: prepared.desc,
					...extra,
				}),
			);
			if (!result.ok) return result;
			this.invalidateObservations();
			return { ok: true, data: success };
		});
	}

	async scroll(direction: "up" | "down"): Promise<EngineOutcome<{ scrolled: true }>> {
		return this.enqueue(async (epoch) => {
			if (!this.targetId) return this.fail("not_bound");
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			const result = fromSidecar<{ scrolled: true }>(
				await this.client.call("scroll", { direction }),
			);
			if (!result.ok) return result;
			return { ok: true, data: { scrolled: true } };
		});
	}

	async screenshot(): Promise<EngineOutcome<EngineScreenshot>> {
		return this.enqueue(async (epoch) => {
			if (!this.targetId) return this.fail("not_bound");
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			return fromSidecar<EngineScreenshot>(await this.client.call("screenshot", {}));
		});
	}

	async readPageFacts(): Promise<EngineOutcome<PageFacts>> {
		return this.enqueue(async (epoch) => {
			if (!this.targetId) return this.fail("not_bound");
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			return fromSidecar<PageFacts>(await this.client.call("readPageFacts", {}));
		});
	}

	async describeControl(ref: string, ctx: RefOperationContext): Promise<EngineOutcome<ControlDescriptor>> {
		if (!this.targetId) return this.fail("not_bound");
		const check = this.validateRef(ctx, ref);
		if (!check.ok) return check;
		return this.enqueue(async (epoch) => {
			if (epoch !== this.operationEpoch) return this.fail("operation_cancelled");
			const result = fromSidecar<ControlDescriptor>(
				await this.client.call("describeControl", {
					ref,
					bindingRevision: ctx.bindingRevision,
				}),
			);
			if (result.ok) {
				this.preparedControls.set(ref, {
					bindingRevision: ctx.bindingRevision,
					desc: result.data,
				});
			}
			return result;
		});
	}

	async dispose(): Promise<void> {
		this.cancel();
		this.targetId = null;
		await this.client.shutdown();
	}

	static vendorDir(): string {
		return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "vendor", "anchortree");
	}
}
