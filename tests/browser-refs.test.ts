import { chromium, type Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { loadSyntheticHtml, TEST_ORIGIN } from "./helpers/test-page.js";

describe("browser refs", () => {
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
		await browser.close();
	});

	it("rejects stale generation after DOM change", async () => {
		await loadSyntheticHtml(page, `<input id="a" /><input id="b" />`);
		const snap = await controller.snapshot();
		const firstRef = snap.nodes[0]!.ref;
		await page.evaluate(() => {
			const a = document.getElementById("a");
			a?.remove();
		});
		await expect(controller.fill(firstRef, snap.generation, "x")).rejects.toThrow(/ref_element_missing/);
	});

	it("rejects fill without matching snapshot generation", async () => {
		await loadSyntheticHtml(page, `<input name="x" />`);
		const snap = await controller.snapshot();
		await expect(controller.fill(snap.nodes[0]!.ref, snap.generation - 1, "nope")).rejects.toThrow(
			/stale_snapshot_generation/,
		);
	});

	it("blocks submit-style button in form", async () => {
		await loadSyntheticHtml(page, `<form><button>Continue</button></form>`);
		const snap = await controller.snapshot();
		const btn = snap.nodes.find((n) => n.role === "button")!;
		const result = await controller.click(btn.ref, snap.generation);
		expect(result.ok).toBe(false);
		expect(result.blocked).toBe("risky_click_requires_human");
	});
});
