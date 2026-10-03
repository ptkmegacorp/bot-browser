import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "../src/config.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const live = process.env.USBA_E2E_LIVE === "1";

describe.skipIf(!live)("live provider smoke", () => {
	it("default model is available for tool calling", async () => {
		const runtime = await ModelRuntime.create();
		const model = runtime.getModel(DEFAULT_MODEL.provider, DEFAULT_MODEL.id);
		expect(model).toBeTruthy();
		const available = await runtime.getAvailable();
		expect(available.some((m) => m.provider === DEFAULT_MODEL.provider)).toBe(true);
	});
});
