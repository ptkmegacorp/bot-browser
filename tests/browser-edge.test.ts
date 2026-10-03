import { chromium, type Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { loadSyntheticHtml, TEST_ORIGIN } from "./helpers/test-page.js";

describe("browser edge cases", () => {
	let page: Page;
	let browser: Awaited<ReturnType<typeof chromium.launch>>;
	let controller: BrowserController;

	beforeEach(async () => {
		browser = await chromium.launch({ headless: true });
		page = await browser.newPage();
		controller = new BrowserController(new TabBindingStore(), 9333);
		controller.forTestingAttachPage(page);
		controller.setMode("idle");
		controller.originScope.approve(TEST_ORIGIN);
	});

	afterEach(async () => {
		await browser?.close();
	});

	it("cancels queued snapshot during human handoff", async () => {
		await loadSyntheticHtml(page, `<input />`);
		let releaseHold!: () => void;
		controller.forTestingHoldSnapshot(() => new Promise<void>((resolve) => {
			releaseHold = resolve;
		}));

		const pending = controller.snapshot();
		await new Promise((r) => setTimeout(r, 30));
		controller.setMode("human_handoff");
		controller.drainQueuedWork();
		releaseHold();
		await expect(pending).rejects.toThrow(/observations_paused|operation_cancelled/);
	});

	it("rejects fill when DOM node replaced by clone with same attribute", async () => {
		await loadSyntheticHtml(page, `<input id="a" value="old" />`);
		const snap = await controller.snapshot();
		const ref = snap.nodes[0]!.ref;
		await page.evaluate(() => {
			const a = document.getElementById("a")!;
			const clone = a.cloneNode(true) as HTMLElement;
			a.replaceWith(clone);
		});
		await expect(controller.fill(ref, snap.generation, "new")).rejects.toThrow(/ref_element_missing/);
	});

	it("blocks button associated to form via form attribute", async () => {
		await loadSyntheticHtml(
			page,
			`<form id="f" onsubmit="event.preventDefault();window.didSubmit=true"></form><button form="f">Go</button>`,
		);
		const snap = await controller.snapshot();
		const btn = snap.nodes.find((n) => n.role === "button")!;
		const result = await controller.click(btn.ref, snap.generation);
		expect(result.ok).toBe(false);
	});
});
