import { DEFAULT_MODEL_PROVIDER, llamaBaseUrl } from "../config.js";

export interface CatalogModel {
	provider: string;
	id: string;
}

export interface DiscoveredModel {
	provider: string;
	id: string;
	label: string;
	source: "live" | "catalog";
}

/**
 * Ask the OpenAI-compatible llama-server what it is actually serving.
 * Returns [] when the endpoint is unreachable or malformed.
 */
export async function discoverServedModels(
	baseUrl = llamaBaseUrl(),
	timeoutMs = 3000,
): Promise<string[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${baseUrl}/models`, {
			signal: controller.signal,
			headers: { accept: "application/json" },
		});
		if (!res.ok) return [];
		const payload = (await res.json()) as { data?: Array<{ id?: string }> };
		const ids = (payload.data ?? [])
			.map((m) => (typeof m.id === "string" ? m.id.trim() : ""))
			.filter(Boolean);
		return [...new Set(ids)];
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Resolve the model to use: an explicit pin, then the live llama-server id,
 * then the first catalog entry. `label` is the human-readable name shown in the
 * side panel; `id` is the wire id sent to the provider.
 */
export async function resolveDefaultModel(
	modelRuntime: { getAvailable(): Promise<readonly CatalogModel[]> },
	options: { provider?: string; modelId?: string; baseUrl?: string } = {},
): Promise<DiscoveredModel> {
	const provider = options.provider ?? DEFAULT_MODEL_PROVIDER;
	const served = await discoverServedModels(options.baseUrl);
	const available = await modelRuntime.getAvailable();
	const pin = options.modelId;

	if (pin) {
		const match = available.find((m) => m.id === pin);
		const wireProvider = match?.provider ?? provider;
		return { provider: wireProvider, id: pin, label: `${wireProvider}/${pin}`, source: "catalog" };
	}

	if (served.length > 0) {
		const id = served[0];
		const match = available.find((m) => m.id === id);
		const wireProvider = match?.provider ?? provider;
		return { provider: wireProvider, id, label: `${wireProvider}/${id}`, source: "live" };
	}

	if (available.length === 0) throw new Error("no_authorized_models");
	const first = available[0];
	return { provider: first.provider, id: first.id, label: `${first.provider}/${first.id}`, source: "catalog" };
}

/**
 * Build the picker list: live-served ids first, then the rest of the catalog.
 * A served id that also exists in the catalog keeps its catalog entry so the
 * wire id stays valid; the label is annotated with the live name.
 */
export function buildModelList(
	available: readonly CatalogModel[],
	served: string[],
): DiscoveredModel[] {
	const servedSet = new Set(served);
	const seen = new Set<string>();
	const models: DiscoveredModel[] = [];

	for (const id of served) {
		const match = available.find((m) => m.id === id);
		const key = `${match?.provider ?? DEFAULT_MODEL_PROVIDER}::${id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		models.push({
			provider: match?.provider ?? DEFAULT_MODEL_PROVIDER,
			id,
			label: match ? `${match.provider}/${id} (served)` : `${DEFAULT_MODEL_PROVIDER}/${id} (served)`,
			source: "live",
		});
	}

	for (const m of available) {
		const key = `${m.provider}::${m.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
	 models.push({
		provider: m.provider,
		id: m.id,
		label: servedSet.has(m.id) ? `${m.provider}/${m.id} (served)` : `${m.provider}/${m.id}`,
		source: "catalog",
	});
	}

	return models;
}
