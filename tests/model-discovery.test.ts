import { describe, expect, it } from "vitest";
import { buildModelList } from "../src/agent/model-discovery.js";

describe("model discovery", () => {
	it("puts live-served ids first and annotates them", () => {
		const catalog = [
			{ provider: "saturn", id: "qwen3.8-27b-huihui-swift-gsq-rco-iq2_xs-local" },
			{ provider: "saturn", id: "qwen3.8-flash-next-q2_0" },
			{ provider: "openai-codex", id: "gpt-6-luna" },
	 ];
		const models = buildModelList(catalog, ["qwen3.8-flash-next-q2_0"]);
		expect(models[0].id).toBe("qwen3.8-flash-next-q2_0");
		expect(models[0].source).toBe("live");
		expect(models[0].label).toBe("saturn/qwen3.8-flash-next-q2_0 (served)");
		expect(models.map((m) => m.id)).toHaveLength(3);
	});

	it("adds served ids missing from the catalog", () => {
		const models = buildModelList([{ provider: "saturn", id: "old-model" }], ["brand-new-9b"]);
		expect(models[0].id).toBe("brand-new-9b");
		expect(models[0].provider).toBe("saturn");
		expect(models[0].label).toBe("saturn/brand-new-9b (served)");
	});

	it("deduplicates repeated served ids", () => {
		const models = buildModelList([], ["a", "a", "b"]);
		expect(models.map((m) => m.id)).toEqual(["a", "b"]);
	});

	it("falls back to the catalog when nothing is served", () => {
		const models = buildModelList([{ provider: "saturn", id: "catalog-only" }], []);
		expect(models[0].source).toBe("catalog");
		expect(models[0].label).toBe("saturn/catalog-only");
	});
});
