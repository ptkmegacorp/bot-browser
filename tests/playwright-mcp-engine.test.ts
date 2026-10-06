import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Browser } from "playwright";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { FakeBrowserEngine } from "../src/browser/engines/fake-engine.js";
import { PlaywrightMcpEngine } from "../src/browser/engines/playwright-mcp.js";
import { PLAYWRIGHT_MCP_VERSION } from "../src/browser/engines/mcp-client.js";
import {
	launchDedicatedCdpBrowser,
	listCdpTargets,
	type DedicatedCdpSession,
} from "./helpers/mcp-spike-harness.js";

const engineTestsEnabled = process.env.USBA_MCP_ENGINE === "1";
const SPIKE_ORIGIN = "http://127.0.0.1";
const DUP_PATH = "/engine-dup-url";

async function openSameUrlTab(sessionBrowser: Browser, marker: string) {
	const ctx = sessionBrowser.contexts()[0]!;
	const page = await ctx.newPage();
	await page.route(`${SPIKE_ORIGIN}/**`, async (route) => {
		if (route.request().url().includes(DUP_PATH)) {
			await route.fulfill({
				status: 200,
				contentType: "text/html",
				body: `<!doctype html><title>dup</title><body><p>${marker}</p></body>`,
			});
			return;
		}
		await route.continue();
	});
	await page.goto(`${SPIKE_ORIGIN}${DUP_PATH}`);
}

describe.skipIf(!engineTestsEnabled)("PlaywrightMcpEngine (USBA_MCP_ENGINE=1)", () => {
	let session: DedicatedCdpSession;
	let outputDir: string;

	beforeAll(async () => {
		session = await launchDedicatedCdpBrowser();
		outputDir = await mkdtemp(join(tmpdir(), "usba-mcp-engine-out-"));
	});

	afterAll(async () => {
		await session?.cleanup();
		if (outputDir) await rm(outputDir, { recursive: true, force: true }).catch(() => {});
	});

	it("pins expected @playwright/mcp version", () => {
		expect(PLAYWRIGHT_MCP_VERSION).toBe("0.0.83");
		const engine = new PlaywrightMcpEngine({ cdpUrl: session.cdpEndpoint, outputDir });
		expect(engine.getPackageVersion()).toBe("0.0.83");
	});

	it("observes only the bound target when two tabs share URL/title", async () => {
		const fullUrl = `${SPIKE_ORIGIN}${DUP_PATH}`;
		await openSameUrlTab(session.browser, "ENGINE_TAB_ALPHA");
		await openSameUrlTab(session.browser, "ENGINE_TAB_BETA");
		const targets = (await listCdpTargets(session.cdpEndpoint)).filter((t) => t.url === fullUrl);
		expect(targets.length).toBeGreaterThanOrEqual(2);
		const [targetA, targetB] = targets.slice(-2);

		const engine = new PlaywrightMcpEngine({ cdpUrl: session.cdpEndpoint, outputDir });
		try {
			expect((await engine.bind(targetA!.id)).ok).toBe(true);
			const snapA = await engine.observe();
			expect(snapA.ok).toBe(true);
			if (!snapA.ok) return;
			expect(snapA.data.bodyText).toMatch(/ENGINE_TAB_(ALPHA|BETA)/);
			const markerA = snapA.data.bodyText.includes("ENGINE_TAB_ALPHA") ? "ALPHA" : "BETA";

			expect((await engine.bind(targetB!.id)).ok).toBe(true);
			const snapB = await engine.observe();
			expect(snapB.ok).toBe(true);
			if (!snapB.ok) return;
			const markerB = snapB.data.bodyText.includes("ENGINE_TAB_ALPHA") ? "ALPHA" : "BETA";
			expect(markerA).not.toBe(markerB);
		} finally {
			await engine.dispose();
		}
	});

	it("returns target_unavailable after the bound CDP target is closed", async () => {
		const ctx = session.browser.contexts()[0]!;
		const page = await ctx.newPage();
		const path = `/engine-close-${Date.now()}`;
		await page.route(`${SPIKE_ORIGIN}/**`, async (route) => {
			if (route.request().url().includes(path)) {
				await route.fulfill({
					status: 200,
					contentType: "text/html",
					body: `<!doctype html><title>victim</title><body><p>VICTIM_CLOSE</p></body>`,
				});
				return;
			}
			await route.continue();
		});
		await page.goto(`${SPIKE_ORIGIN}${path}`);
		const targets = await listCdpTargets(session.cdpEndpoint);
		const victim = targets.find((t) => t.url.includes(path));
		expect(victim?.id).toBeTruthy();

		const engine = new PlaywrightMcpEngine({ cdpUrl: session.cdpEndpoint, outputDir });
		try {
			expect((await engine.bind(victim!.id)).ok).toBe(true);
			await page.close();
			const state = await engine.getBindingState();
			expect(state.live).toBe(false);
			const obs = await engine.observe();
			expect(obs.ok).toBe(false);
			if (obs.ok) return;
			expect(obs.code).toBe("target_unavailable");
		} finally {
			await engine.dispose();
		}
	});

	it("cancel clears binding epoch; observe works after re-bind", async () => {
		const engine = new PlaywrightMcpEngine({ cdpUrl: session.cdpEndpoint, outputDir });
		const ctx = session.browser.contexts()[0]!;
		const page = await ctx.newPage();
		const path = `/engine-cancel-${Date.now()}`;
		await page.route(`${SPIKE_ORIGIN}/**`, async (route) => {
			if (route.request().url().includes(path)) {
				await route.fulfill({
					status: 200,
					contentType: "text/html",
					body: `<!doctype html><title>c</title><body><p>CANCEL_OK</p></body>`,
				});
				return;
			}
			await route.continue();
		});
		await page.goto(`${SPIKE_ORIGIN}${path}`);
		const targets = await listCdpTargets(session.cdpEndpoint);
		const target = targets.find((t) => t.url.includes(path));
		expect(target?.id).toBeTruthy();
		try {
			expect((await engine.bind(target!.id)).ok).toBe(true);
			engine.cancel();
			expect((await engine.bind(target!.id)).ok).toBe(true);
			const obs = await engine.observe();
			expect(obs.ok).toBe(true);
			if (obs.ok) expect(obs.data.bodyText).toMatch(/CANCEL_OK/);
		} finally {
			await page.close().catch(() => {});
			await engine.dispose();
		}
	});
});

describe("BrowserController + FakeBrowserEngine", () => {
	it("still drives snapshots and fill through the engine seam", async () => {
		const fake = new FakeBrowserEngine({
			url: "https://fixture.test/",
			title: "Fixture",
			bodyText: "hello",
			elements: [{ ref: "e1", tag: "input", role: "textbox", name: "q", editable: true }],
		});
		const controller = new BrowserController(new TabBindingStore(), 9333, fake);
		await fake.bind("target-1");
		controller.forTestingBindTarget("target-1");
		controller.originScope.approve("https://fixture.test");
		const snap = await controller.snapshot();
		expect(snap.nodes[0]?.ref).toBe("e1");
		const fill = await controller.fill("e1", snap.generation, "typed");
		expect(fill.ok).toBe(true);
		const shot = await controller.screenshot();
		expect(shot.mimeType).toBe("image/png");
		expect(shot.base64.length).toBeGreaterThan(0);
		await controller.dispose();
	});
});
