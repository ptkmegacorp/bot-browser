import type { ControlDescriptor } from "./safety.js";

/** Distinguishable failure codes for controller policy and Pi tools. */
export type EngineErrorCode =
	| "not_bound"
	| "target_unavailable"
	| "stale_observation"
	| "stale_ref"
	| "unknown_ref"
	| "operation_cancelled"
	| "observations_paused"
	| "timeout"
	| "not_implemented"
	| "invalid_argument";

export type EngineOutcome<T> =
	| { ok: true; data: T }
	| { ok: false; code: EngineErrorCode; message?: string };

export interface EngineBindingState {
	live: boolean;
	targetId: string | null;
	url: string | null;
	title: string | null;
	bindingRevision: number;
}

export interface EngineBindResult {
	targetId: string;
	url: string;
	title: string;
	bindingRevision: number;
}

/** Interactive ref from a single observation; opaque outside the issuing observation. */
export interface EngineObservationRef {
	ref: string;
	role: string;
	name: string;
	value?: string;
	editable?: boolean;
}

/**
 * Bounded page observation. `observationId` and refs are valid only for the current
 * binding revision until invalidated by navigation, rebind, or cancel.
 */
export interface EngineObservation {
	observationId: string;
	targetId: string;
	url: string;
	title: string;
	/** Monotonic per-binding counter; tools may pass this as `generation` during migration. */
	generation: number;
	bindingRevision: number;
	/** Readable page text (bounded upstream / adapter output). */
	bodyText: string;
	refs: EngineObservationRef[];
}

/** Provenance required for ref-based mutations and preflight. */
export interface RefOperationContext {
	observationId: string;
	generation: number;
	bindingRevision: number;
}

export interface EngineScreenshot {
	mimeType: "image/png";
	base64: string;
}

/** Engine-neutral browser mechanics; authority and policy stay in BrowserController. */
export interface BrowserEngine {
	bind(targetId: string): Promise<EngineOutcome<EngineBindResult>>;

	getBindingState(): Promise<EngineBindingState>;

	observe(): Promise<EngineOutcome<EngineObservation>>;

	navigate(url: string): Promise<EngineOutcome<{ url: string }>>;

	click(ref: string, ctx: RefOperationContext): Promise<EngineOutcome<{ clicked: true }>>;

	fill(
		ref: string,
		ctx: RefOperationContext,
		text: string,
	): Promise<EngineOutcome<{ filled: true }>>;

	selectOption(
		ref: string,
		ctx: RefOperationContext,
		value: string,
	): Promise<EngineOutcome<{ selected: true }>>;

	scroll(direction: "up" | "down"): Promise<EngineOutcome<{ scrolled: true }>>;

	screenshot(): Promise<EngineOutcome<EngineScreenshot>>;

	/** Trusted introspection of the referenced control for safety preflight. */
	describeControl(ref: string, ctx: RefOperationContext): Promise<EngineOutcome<ControlDescriptor>>;

	/** Invalidate observations and reject queued / in-flight work where possible. */
	cancel(): void;

	dispose(): Promise<void>;
}

export const MAX_OBSERVATION_BODY_CHARS = 32_000;

export function truncateObservationText(text: string, max = MAX_OBSERVATION_BODY_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}
