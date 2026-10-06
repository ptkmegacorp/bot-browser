import { describe, expect, it } from "vitest";
import { MAX_OBSERVATION_BODY_CHARS } from "../src/browser/engine.js";
import { FakeBrowserEngine } from "../src/browser/engines/fake-engine.js";

function ctxFromObservation(obs: {
	observationId: string;
	generation: number;
	bindingRevision: number;
}) {
	return {
		observationId: obs.observationId,
		generation: obs.generation,
		bindingRevision: obs.bindingRevision,
	};
}

describe("FakeBrowserEngine contract", () => {
	it("returns a bounded observation envelope with target and ref provenance", async () => {
		const engine = new FakeBrowserEngine({
			url: "https://fixture.test/form",
			title: "Demo",
			bodyText: "Hello fixture page",
			elements: [{ ref: "e1", tag: "input", role: "textbox", name: "q", editable: true }],
		});
		await engine.bind("target-abc");

		const outcome = await engine.observe();
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		const obs = outcome.data;
		expect(obs.observationId).toMatch(/^obs-\d+$/);
		expect(obs.targetId).toBe("target-abc");
		expect(obs.url).toBe("https://fixture.test/form");
		expect(obs.title).toBe("Demo");
		expect(obs.generation).toBeGreaterThan(0);
		expect(obs.bindingRevision).toBeGreaterThan(0);
		expect(obs.bodyText).toBe("Hello fixture page");
		expect(obs.refs).toEqual([
			{ ref: "e1", role: "textbox", name: "q", editable: true, value: undefined },
		]);

		const state = await engine.getBindingState();
		expect(state.live).toBe(true);
		expect(state.targetId).toBe("target-abc");
		expect(state.bindingRevision).toBe(obs.bindingRevision);

		await engine.dispose();
	});

	it("truncates oversized observation body text", async () => {
		const longText = "x".repeat(MAX_OBSERVATION_BODY_CHARS + 50);
		const engine = new FakeBrowserEngine({ bodyText: longText });
		await engine.bind("t1");
		const outcome = await engine.observe();
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.data.bodyText.length).toBe(MAX_OBSERVATION_BODY_CHARS);
		expect(outcome.data.bodyText.endsWith("…")).toBe(true);
		await engine.dispose();
	});

	it("rejects stale refs after DOM replacement invalidates the observation", async () => {
		const engine = new FakeBrowserEngine({
			elements: [{ ref: "e1", tag: "input", role: "textbox", name: "a", editable: true }],
		});
		await engine.bind("t1");
		const snap = await engine.observe();
		expect(snap.ok).toBe(true);
		if (!snap.ok) return;

		engine.setPage({
			elements: [{ ref: "e1", tag: "input", role: "textbox", name: "b", editable: true }],
		});

		const fill = await engine.fill("e1", ctxFromObservation(snap.data), "next");
		expect(fill.ok).toBe(false);
		if (fill.ok) return;
		expect(fill.code).toBe("stale_observation");

		await engine.dispose();
	});

	it("cancels in-flight observe and rejects subsequent queued work", async () => {
		const engine = new FakeBrowserEngine({
			elements: [{ ref: "e1", tag: "input", role: "textbox", name: "a", editable: true }],
		});
		await engine.bind("t1");

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		engine.forTestingHoldObserve(() => gate);

		const pending = engine.observe();
		engine.cancel();
		release();

		const outcome = await pending;
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe("operation_cancelled");

		const after = await engine.observe();
		expect(after.ok).toBe(true);

		await engine.dispose();
	});

	it("describeControl succeeds for a live ref and fails for unknown ref", async () => {
		const engine = new FakeBrowserEngine({
			elements: [
				{
					ref: "e1",
					tag: "button",
					role: "button",
					name: "Save",
					inForm: true,
					type: "button",
				},
			],
		});
		await engine.bind("t1");
		const obs = await engine.observe();
		expect(obs.ok).toBe(true);
		if (!obs.ok) return;

		const desc = await engine.describeControl("e1", ctxFromObservation(obs.data));
		expect(desc.ok).toBe(true);
		if (!desc.ok) return;
		expect(desc.data.tag).toBe("button");
		expect(desc.data.inForm).toBe(true);

		const bad = await engine.describeControl("e99", ctxFromObservation(obs.data));
		expect(bad.ok).toBe(false);
		if (bad.ok) return;
		expect(bad.code).toBe("unknown_ref");

		await engine.dispose();
	});
});
