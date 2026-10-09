import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Browser, BrowserContext } from "playwright";
import { AnchortreeEngine, ANCHORTREE_UPSTREAM_REVISION } from "../src/browser/engines/anchortree-engine.js";
import { readMainBodyTextForCdpTarget } from "../src/browser/engines/cdp-target-page.js";
import {
	launchDedicatedCdpBrowser,
	listCdpTargets,
	playwrightContext,
	type DedicatedCdpSession,
} from "./helpers/mcp-spike-harness.js";

const engineTestsEnabled = process.env.BOT_BROWSER_ANCHORTREE_ENGINE === "1";
const SPIKE_ORIGIN = "http://127.0.0.1";
const DUP_PATH = "/anchortree-dup-url";

async function openSameUrlTab(sessionBrowser: Browser | BrowserContext, marker: string) {
	const ctx = "contexts" in sessionBrowser ? sessionBrowser.contexts()[0]! : sessionBrowser;
	const page = await ctx.newPage();
	await page.route(`${SPIKE_ORIGIN}/**`, async (route) => {
		if (route.request().url().includes(DUP_PATH)) {
			await route.fulfill({
				status: 200,
				contentType: "text/html",
				body: `<!doctype html><title>dup</title><body><p>loading</p></body>`,
			});
			return;
		}
		await route.continue();
	});
	await page.goto(`${SPIKE_ORIGIN}${DUP_PATH}`);
	await page.evaluate((m) => {
		document.body.innerHTML = `<p>${m}</p>`;
	}, marker);
}

describe.skipIf(!engineTestsEnabled)("AnchortreeEngine (BOT_BROWSER_ANCHORTREE_ENGINE=1)", () => {
	let session: DedicatedCdpSession;

	beforeEach(async () => {
		session = await launchDedicatedCdpBrowser({ attachPlaywright: false });
	});

	afterEach(async () => {
		await session?.cleanup();
	});

	it("pins upstream revision constant", () => {
		expect(ANCHORTREE_UPSTREAM_REVISION).toBe("2f085c506e9fa92e24940ba7c280545a35bee529");
	});

	it("observes only the bound target when two tabs share URL/title", async () => {
		await openSameUrlTab(playwrightContext(session), "AT_TAB_ALPHA");
		await openSameUrlTab(playwrightContext(session), "AT_TAB_BETA");
		const targets = (await listCdpTargets(session.cdpEndpoint)).filter((t) => t.url.includes(DUP_PATH));
		expect(targets.length).toBeGreaterThanOrEqual(2);
		const withMarkers = await Promise.all(
			targets.map(async (t) => ({
				t,
				body: (await readMainBodyTextForCdpTarget(session.cdpEndpoint, t.id)) ?? "",
			})),
		);
		const targetA = withMarkers.find((x) => x.body.includes("AT_TAB_ALPHA"))?.t;
		const targetB = withMarkers.find((x) => x.body.includes("AT_TAB_BETA"))?.t;
		expect(targetA?.id && targetB?.id).toBeTruthy();

		const engine = new AnchortreeEngine({ cdpUrl: session.cdpEndpoint });
		try {
			const bindA = await engine.bind(targetA!.id);
			expect(bindA.ok, bindA.ok ? "" : JSON.stringify(bindA)).toBe(true);
			const snapA = await engine.observe();
			expect(snapA.ok).toBe(true);
			if (!snapA.ok) throw new Error(JSON.stringify(snapA));
			expect(snapA.data.bodyText).toContain("AT_TAB_ALPHA");
			expect(snapA.data.bodyText).not.toContain("AT_TAB_BETA");

			expect((await engine.bind(targetB!.id)).ok).toBe(true);
			const snapB = await engine.observe();
			expect(snapB.ok).toBe(true);
			if (!snapB.ok) throw new Error(JSON.stringify(snapB));
			expect(snapB.data.bodyText).toContain("AT_TAB_BETA");
			expect(snapB.data.bodyText).not.toContain("AT_TAB_ALPHA");
		} finally {
			await engine.dispose();
		}
	});

	it("advances binding revision on each bind", async () => {
		const engine = new AnchortreeEngine({ cdpUrl: session.cdpEndpoint });
		const ctx = playwrightContext(session);
		const page = await ctx.newPage();
		const path = `/bind-rev-${Date.now()}`;
		await page.route(`${SPIKE_ORIGIN}/**`, async (route) => {
			if (route.request().url().includes(path)) {
				await route.fulfill({
					status: 200,
					contentType: "text/html",
					body: `<!doctype html><title>x</title><body><p>REV</p></body>`,
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
			const bind1 = await engine.bind(target!.id);
			expect(bind1.ok).toBe(true);
			if (!bind1.ok) return;
			const bind2 = await engine.bind(target!.id);
			expect(bind2.ok).toBe(true);
			if (!bind2.ok) return;
			expect(bind2.data.bindingRevision).toBeGreaterThan(bind1.data.bindingRevision);
		} finally {
			await page.close().catch(() => {});
			await engine.dispose();
		}
	});
});
