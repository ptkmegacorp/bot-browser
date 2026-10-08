import { describe, expect, it } from "vitest";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { FakeBrowserEngine } from "../src/browser/engines/fake-engine.js";
import { createBrowserTools } from "../src/agent/tools.js";

const FIXTURE_ORIGIN = "https://fixture.test";
const LONG_BODY = "x".repeat(80);

function fixtureController(fake: FakeBrowserEngine): BrowserController {
	const controller = new BrowserController(new TabBindingStore(), 9333, fake);
	controller.forTestingBindTarget("target-1");
	controller.originScope.approve(FIXTURE_ORIGIN);
	controller.setMode("running");
	return controller;
}

describe("BrowserController action verification", () => {
	it("navigate attaches landed verification from page facts", async () => {
		const fake = new FakeBrowserEngine({
			url: `${FIXTURE_ORIGIN}/`,
			title: "Fixture",
			bodyText: LONG_BODY,
		});
		await fake.bind("target-1");
		const controller = fixtureController(fake);
		const result = await controller.navigate(`${FIXTURE_ORIGIN}/home`);
		expect(result.verification?.status).toBe("ok");
		expect(result.verification?.summary).toMatch(/ok — landed/);
		await controller.dispose();
	});

	it("fill reports field value and warns on mismatch", async () => {
		const fake = new FakeBrowserEngine({
			url: `${FIXTURE_ORIGIN}/`,
			bodyText: LONG_BODY,
			elements: [{ ref: "e1", tag: "input", role: "textbox", name: "Full name", editable: true }],
		});
		await fake.bind("target-1");
		const controller = fixtureController(fake);
		const snap = await controller.snapshot();
		const ok = await controller.fill("e1", snap.generation, "Alice");
		expect(ok.verification?.status).toBe("ok");
		expect(ok.verification?.summary).toContain('field "Full name" now "Alice"');

		fake.setPage({
			elements: [
				{
					ref: "e1",
					tag: "input",
					role: "textbox",
					name: "Full name",
					editable: true,
					readbackValue: "Bob",
				},
			],
		});
		const snap2 = await controller.snapshot();
		const warn = await controller.fill("e1", snap2.generation, "Alice");
		expect(warn.verification?.status).toBe("warn");
		expect(warn.verification?.summary).toContain("expected");
		await controller.dispose();
	});

	it("scroll at bottom warns instead of reporting success", async () => {
		const fake = new FakeBrowserEngine({
			url: `${FIXTURE_ORIGIN}/`,
			bodyText: LONG_BODY,
			scrollY: 200,
			scrollHeight: 800,
			viewportHeight: 600,
		});
		await fake.bind("target-1");
		const controller = fixtureController(fake);
		const result = await controller.scroll("down");
		expect(result.verification?.status).toBe("warn");
		expect(result.verification?.summary).toContain("already at bottom");
		await controller.dispose();
	});

	it("omits verification when observations are paused during readback", async () => {
		const fake = new FakeBrowserEngine({
			url: `${FIXTURE_ORIGIN}/`,
			title: "Fixture",
			bodyText: LONG_BODY,
			elements: [{ ref: "e1", tag: "input", role: "textbox", name: "q", editable: true }],
		});
		await fake.bind("target-1");
		const controller = fixtureController(fake);

		let releaseNavigate!: () => void;
		fake.forTestingHoldMutation(
			() =>
				new Promise<void>((resolve) => {
					releaseNavigate = resolve;
				}),
		);
		const navPromise = controller.navigate(`${FIXTURE_ORIGIN}/held`);
		await new Promise((r) => setTimeout(r, 10));
		controller.setMode("paused");
		releaseNavigate();
		const nav = await navPromise;
		expect(nav.verification).toBeUndefined();

		controller.setMode("running");
		let releaseFill!: () => void;
		fake.forTestingHoldMutation(
			() =>
				new Promise<void>((resolve) => {
					releaseFill = resolve;
				}),
		);
		const snap = await controller.snapshot();
		const fillPromise = controller.fill("e1", snap.generation, "typed");
		await new Promise((r) => setTimeout(r, 10));
		controller.setMode("paused");
		releaseFill();
		const fill = await fillPromise;
		expect(fill.verification).toBeUndefined();
		await controller.dispose();
	});

	it("blocked sensitive fill has no verification and never echoes the password", async () => {
		const fake = new FakeBrowserEngine({
			url: `${FIXTURE_ORIGIN}/`,
			bodyText: LONG_BODY,
			elements: [
				{
					ref: "e1",
					tag: "input",
					type: "password",
					role: "textbox",
					name: "Password",
					editable: true,
					value: "hunter2",
				},
			],
		});
		await fake.bind("target-1");
		const controller = fixtureController(fake);
		const snap = await controller.snapshot();
		const result = await controller.fill("e1", snap.generation, "hunter2");
		expect(result.ok).toBe(false);
		expect(result.verification).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain("hunter2");
		await controller.dispose();
	});

	it("fill verification does not invalidate snapshot generation", async () => {
		const fake = new FakeBrowserEngine({
			url: `${FIXTURE_ORIGIN}/`,
			bodyText: LONG_BODY,
			elements: [{ ref: "e1", tag: "input", role: "textbox", name: "q", editable: true }],
		});
		await fake.bind("target-1");
		const controller = fixtureController(fake);
		const snap = await controller.snapshot();
		const generation = snap.generation;
		const fill = await controller.fill("e1", generation, "typed");
		expect(fill.verification?.status).toBe("ok");
		await expect(controller.fill("e1", generation, "again")).resolves.toMatchObject({ ok: true });
		await controller.dispose();
	});
});

describe("browser tools verification line", () => {
	it("browser_navigate content includes verification when wired to fake engine", async () => {
		const fake = new FakeBrowserEngine({
			url: `${FIXTURE_ORIGIN}/`,
			title: "Fixture",
			bodyText: LONG_BODY,
		});
		await fake.bind("target-1");
		const controller = fixtureController(fake);
		const tools = createBrowserTools(controller);
		const navigate = tools.find((t) => t.name === "browser_navigate")!;
		const out = await navigate.execute("call-1", { url: `${FIXTURE_ORIGIN}/tool` });
		const text = out.content[0]?.type === "text" ? out.content[0].text : "";
		expect(text).toMatch(/^navigated:/);
		expect(text).toContain("verification:");
		expect(text).toContain("ok — landed");
		await controller.dispose();
	});
});
