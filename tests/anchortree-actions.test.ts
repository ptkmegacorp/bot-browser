import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { BrowserContext, Page } from "playwright";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { AnchortreeEngine } from "../src/browser/engines/anchortree-engine.js";
import { AnchortreeSidecarClient } from "../src/browser/engines/anchortree-sidecar-client.js";
import { isConsequentialControl, isSensitiveField } from "../src/browser/safety.js";
import {
	launchDedicatedCdpBrowser,
	listCdpTargets,
	playwrightContext,
	type DedicatedCdpSession,
} from "./helpers/mcp-spike-harness.js";

const enabled = process.env.BOT_BROWSER_ANCHORTREE_ENGINE === "1";
const ORIGIN = "http://127.0.0.1";

function assertSnap<T extends { ok: boolean }>(snap: T, label: string): asserts snap is T & { ok: true } {
	expect(snap.ok, label).toBe(true);
	if (!snap.ok) throw new Error(`${label}: ${JSON.stringify(snap)}`);
}

async function openPage(ctx: BrowserContext, path: string, html: string): Promise<Page> {
	const page = await ctx.newPage();
	await page.route(`${ORIGIN}/**`, async (route) => {
		if (route.request().url().includes(path)) {
			await route.fulfill({ status: 200, contentType: "text/html", body: html });
			return;
		}
		await route.continue();
	});
	await page.goto(`${ORIGIN}${path}`);
	return page;
}

function cdpPort(endpoint: string): number {
	return Number(new URL(endpoint).port);
}

function refCtx(obs: { observationId: string; generation: number; bindingRevision: number }) {
	return {
		observationId: obs.observationId,
		generation: obs.generation,
		bindingRevision: obs.bindingRevision,
	};
}

describe.skipIf(!enabled)("Anchortree native actions + safety", () => {
	let session: DedicatedCdpSession;

	beforeEach(async () => {
		session = await launchDedicatedCdpBrowser({ attachPlaywright: false });
	});

	afterEach(async () => {
		await session?.cleanup();
	});

	it("native click, fill, and select mutate only the bound tab", async () => {
		const ctx = playwrightContext(session);
		const path = `/at-mut-${Date.now()}`;
		const pageA = await openPage(
			ctx,
			`${path}-a`,
			`<!doctype html><title>t</title><body><button id="btn-a" type="button">Tap</button><input id="a" name="a" aria-label="Input A" value="" /><select id="sel-a" name="sel-a" aria-label="Select A"><option value="x">X</option><option value="y">Y</option></select><p id="mark">TAB_A</p></body>`,
		);
		const pageB = await openPage(
			ctx,
			`${path}-b`,
			`<!doctype html><title>t</title><body><input id="b" name="b" value="" /><p id="mark">TAB_B</p></body>`,
		);
		await pageA.evaluate(() => {
			(window as unknown as { __clickTrusted: boolean | null }).__clickTrusted = null;
			document.querySelector("#btn-a")?.addEventListener("click", (e) => {
				(window as unknown as { __clickTrusted: boolean | null }).__clickTrusted = e.isTrusted;
			});
		});
		const targets = await listCdpTargets(session.cdpEndpoint);
		const idA = targets.find((t) => t.url.includes(`${path}-a`))?.id;
		const idB = targets.find((t) => t.url.includes(`${path}-b`))?.id;
		expect(idA && idB).toBeTruthy();

		const engine = new AnchortreeEngine({ cdpUrl: session.cdpEndpoint });
		try {
			await engine.bind(idA!);
			const snap = await engine.observe();
			assertSnap(snap, "observe tab A");
			const btnRef =
				snap.data.refs.find((r) => r.name.toLowerCase().includes("tap"))?.ref ??
				snap.data.refs.find((r) => r.role.includes("btn"))?.ref;
			expect(btnRef).toBeTruthy();
			const inputRef = snap.data.refs.find((r) => r.name.includes("Input A"))?.ref;
			const selectRef = snap.data.refs.find((r) => r.name.includes("Select A"))?.ref;
			expect(inputRef && selectRef).toBeTruthy();
			const opCtx = refCtx(snap.data);
			expect((await engine.describeControl(btnRef!, opCtx)).ok).toBe(true);
			const clickOut = await engine.click(btnRef!, opCtx);
			expect(clickOut.ok, clickOut.ok ? "" : JSON.stringify(clickOut)).toBe(true);
			expect(await pageA.evaluate(() => (window as unknown as { __clickTrusted: boolean | null }).__clickTrusted)).toBe(
				true,
			);
			const snapAfterClick = await engine.observe();
			assertSnap(snapAfterClick, "observe after click");
			const opCtx2 = refCtx(snapAfterClick.data);
			const inputRef2 = snapAfterClick.data.refs.find((r) => r.name.includes("Input A"))?.ref ?? inputRef;
			const selectRef2 = snapAfterClick.data.refs.find((r) => r.name.includes("Select A"))?.ref ?? selectRef;
			expect((await engine.describeControl(inputRef2!, opCtx2)).ok).toBe(true);
			expect((await engine.fill(inputRef2!, opCtx2, "alpha")).ok).toBe(true);
			expect(await pageA.inputValue("#a")).toBe("alpha");
			const snapAfterFill = await engine.observe();
			assertSnap(snapAfterFill, "observe after fill");
			const opCtx3 = refCtx(snapAfterFill.data);
			const selectRef3 =
				snapAfterFill.data.refs.find((r) => r.name.includes("Select A"))?.ref ?? selectRef2;
			expect((await engine.describeControl(selectRef3!, opCtx3)).ok).toBe(true);
			expect((await engine.selectOption(selectRef3!, opCtx3, "y")).ok).toBe(true);
			expect(await pageA.locator("#sel-a").inputValue()).toBe("y");
			expect(await pageB.inputValue("#b")).toBe("");

			await engine.bind(idB!);
			const snapB = await engine.observe();
			assertSnap(snapB, "observe tab B");
			const refB = snapB.data.refs.find((r) => r.editable)?.ref;
			const ctxB = refCtx(snapB.data);
			await engine.describeControl(refB!, ctxB);
			expect((await engine.fill(refB!, ctxB, "beta")).ok).toBe(true);
			expect(await pageB.inputValue("#b")).toBe("beta");
			expect(await pageA.inputValue("#a")).toBe("alpha");
		} finally {
			await engine.dispose();
			await pageA.close().catch(() => {});
			await pageB.close().catch(() => {});
		}
	});

	it("describeControl exposes live DOM metadata for safety", async () => {
		const path = `/at-desc-${Date.now()}`;
		const page = await openPage(
			playwrightContext(session),
			path,
			`<!doctype html><form><input id="pwd" name="token" type="password" autocomplete="current-password" /></form>`,
		);
		const target = (await listCdpTargets(session.cdpEndpoint)).find((t) => t.url.includes(path));
		const engine = new AnchortreeEngine({ cdpUrl: session.cdpEndpoint });
		try {
			await engine.bind(target!.id);
			const snap = await engine.observe();
			assertSnap(snap, "observe password field");
			const ref = snap.data.refs.find((r) => r.editable)?.ref;
			const ctx = refCtx(snap.data);
			const desc = await engine.describeControl(ref!, ctx);
			expect(desc.ok).toBe(true);
			if (!desc.ok) throw new Error(JSON.stringify(desc));
			expect(desc.data.tag).toBe("input");
			expect(desc.data.type).toBe("password");
			expect(desc.data.autocomplete).toMatch(/password/i);
			expect(isSensitiveField(desc.data.type, desc.data.autocomplete ?? null, desc.data.name ?? null)).toBe(
				true,
			);

			const controller = new BrowserController(
				new TabBindingStore(),
				cdpPort(session.cdpEndpoint),
				engine,
			);
			await controller.attachTab(target!.id);
			controller.originScope.approve(ORIGIN);
			const panelSnap = await controller.snapshot();
			const fill = await controller.fill(ref!, panelSnap.generation, "secret");
			expect(fill.ok).toBe(false);
			expect(fill.blocked).toBe("sensitive_field_human_only");
		} finally {
			await page.close().catch(() => {});
			await engine.dispose();
		}
	});

	it("blocks consequential click via controller policy", async () => {
		const path = `/at-risk-${Date.now()}`;
		const page = await openPage(
			playwrightContext(session),
			path,
			`<!doctype html><body><button id="buy" type="button">Purchase now</button></body>`,
		);
		const target = (await listCdpTargets(session.cdpEndpoint)).find((t) => t.url.includes(path));
		const engine = new AnchortreeEngine({ cdpUrl: session.cdpEndpoint });
		try {
			await engine.bind(target!.id);
			const snap = await engine.observe();
			assertSnap(snap, "observe risky button");
			const ref = snap.data.refs.find((r) => r.role.includes("btn") || r.name.toLowerCase().includes("purchase"))?.ref
				?? snap.data.refs[0]?.ref;
			expect(ref).toBeTruthy();
			const desc = await engine.describeControl(ref!, refCtx(snap.data));
			expect(desc.ok).toBe(true);
			if (!desc.ok) throw new Error(JSON.stringify(desc));
			expect(isConsequentialControl(desc.data)).toBe(true);

			const controller = new BrowserController(
				new TabBindingStore(),
				cdpPort(session.cdpEndpoint),
				engine,
			);
			await controller.attachTab(target!.id);
			controller.originScope.approve(ORIGIN);
			const panelSnap = await controller.snapshot();
			const click = await controller.click(ref!, panelSnap.generation);
			expect(click.ok).toBe(false);
			expect(click.blocked).toBe("risky_click_requires_human");
		} finally {
			await page.close().catch(() => {});
			await engine.dispose();
		}
	});

	it("rejects mutation when control meaning changes after preflight", async () => {
		const path = `/at-stale-${Date.now()}`;
		const page = await openPage(
			playwrightContext(session),
			path,
			`<!doctype html><body><button id="act" type="button">Safe action</button></body>`,
		);
		const target = (await listCdpTargets(session.cdpEndpoint)).find((t) => t.url.includes(path));
		const engine = new AnchortreeEngine({ cdpUrl: session.cdpEndpoint });
		try {
			await engine.bind(target!.id);
			const snap = await engine.observe();
			assertSnap(snap, "observe stale preflight");
			const ref = snap.data.refs[0]?.ref;
			const ctx = refCtx(snap.data);
			expect((await engine.describeControl(ref!, ctx)).ok).toBe(true);
			await page.evaluate(() => {
				const b = document.querySelector("#act") as HTMLButtonElement;
				b.textContent = "Purchase now";
			});
			const click = await engine.click(ref!, ctx);
			expect(click.ok).toBe(false);
			if (!click.ok) expect(click.code).toBe("stale_observation");
		} finally {
			await page.close().catch(() => {});
			await engine.dispose();
		}
	});

	it("retains durable eid across re-render with stable id", async () => {
		const path = `/at-rebind-${Date.now()}`;
		const page = await openPage(
			playwrightContext(session),
			path,
			`<!doctype html><body><input id="keep" name="keep" value="v1" /></body>`,
		);
		const target = (await listCdpTargets(session.cdpEndpoint)).find((t) => t.url.includes(path));
		const engine = new AnchortreeEngine({ cdpUrl: session.cdpEndpoint });
		try {
			await engine.bind(target!.id);
			const snap1 = await engine.observe();
			assertSnap(snap1, "observe re-render before");
			const ref1 = snap1.data.refs.find((r) => r.editable)?.ref;
			const ctx1 = refCtx(snap1.data);
			await engine.describeControl(ref1!, ctx1);
			expect((await engine.fill(ref1!, ctx1, "v2")).ok).toBe(true);
			await page.evaluate(() => {
				const el = document.querySelector("#keep")!;
				const parent = el.parentElement!;
				parent.innerHTML = '<input id="keep" name="keep" value="v2" />';
			});
			const snap2 = await engine.observe();
			assertSnap(snap2, "observe re-render after");
			const ref2 = snap2.data.refs.find((r) => r.editable)?.ref;
			expect(ref2).toBe(ref1);
		} finally {
			await page.close().catch(() => {});
			await engine.dispose();
		}
	});

	it("same-URL reload resets document identity", async () => {
		const path = `/at-reload-${Date.now()}`;
		const page = await openPage(
			playwrightContext(session),
			path,
			`<!doctype html><body><input id="r" name="r" value="" /></body>`,
		);
		const target = (await listCdpTargets(session.cdpEndpoint)).find((t) => t.url.includes(path));
		const engine = new AnchortreeEngine({ cdpUrl: session.cdpEndpoint });
		try {
			await engine.bind(target!.id);
			const snap1 = await engine.observe();
			assertSnap(snap1, "observe before reload");
			const refBefore = snap1.data.refs.find((r) => r.editable)?.ref;
			const ctx1 = refCtx(snap1.data);
			await page.reload();
			const snap2 = await engine.observe();
			assertSnap(snap2, "observe after reload");
			const staleFill = await engine.fill(refBefore!, ctx1, "lost");
			expect(staleFill.ok).toBe(false);
			if (!staleFill.ok) {
				expect(["stale_ref", "stale_observation"]).toContain(staleFill.code);
			}
		} finally {
			await page.close().catch(() => {});
			await engine.dispose();
		}
	});

	it("navigation resets document identity", async () => {
		const pathA = `/at-nav-a-${Date.now()}`;
		const pathB = `/at-nav-b-${Date.now()}`;
		const page = await openPage(
			playwrightContext(session),
			pathA,
			`<!doctype html><body><input id="x" name="x" /></body>`,
		);
		const target = (await listCdpTargets(session.cdpEndpoint)).find((t) => t.url.includes(pathA));
		const engine = new AnchortreeEngine({ cdpUrl: session.cdpEndpoint });
		try {
			await engine.bind(target!.id);
			const snap1 = await engine.observe();
			assertSnap(snap1, "observe before nav");
			const refBefore = snap1.data.refs.find((r) => r.editable)?.ref;
			const ctx1 = refCtx(snap1.data);
			await engine.navigate(`${ORIGIN}${pathB}`);
			await page.route(`${ORIGIN}/**`, async (route) => {
				if (route.request().url().includes(pathB)) {
					await route.fulfill({
						status: 200,
						contentType: "text/html",
						body: `<!doctype html><body><input id="y" name="y" /></body>`,
					});
					return;
				}
				await route.continue();
			});
			await page.goto(`${ORIGIN}${pathB}`);
			const snap2 = await engine.observe();
			assertSnap(snap2, "observe after nav");
			const staleFill = await engine.fill(refBefore!, ctx1, "lost");
			expect(staleFill.ok).toBe(false);
			if (!staleFill.ok) {
				expect(["stale_ref", "stale_observation"]).toContain(staleFill.code);
			}
		} finally {
			await page.close().catch(() => {});
			await engine.dispose();
		}
	});

	it("masks password and OTP values in observation IPC output", async () => {
		const path = `/at-mask-${Date.now()}`;
		const page = await openPage(
			playwrightContext(session),
			path,
			`<!doctype html><body><p>OTP code is 654321</p><input id="otp" name="otp" type="text" autocomplete="one-time-code" value="654321" /></body>`,
		);
		const target = (await listCdpTargets(session.cdpEndpoint)).find((t) => t.url.includes(path));
		const engine = new AnchortreeEngine({ cdpUrl: session.cdpEndpoint });
		try {
			await engine.bind(target!.id);
			const snap = await engine.observe();
			assertSnap(snap, "observe masked fields");
			const otpRef = snap.data.refs.find((r) => r.editable && r.value === "[masked]");
			expect(otpRef?.ref).toBeTruthy();
			expect(otpRef?.value).toBe("[masked]");
			expect(snap.data.bodyText).not.toContain("654321");
			expect(snap.data.bodyText).toContain("[masked]");
		} finally {
			await page.close().catch(() => {});
			await engine.dispose();
		}
	});

	it("cancel during slow native fill prevents DOM mutation (sidecar kill)", async () => {
		const prevSlow = process.env.BOT_BROWSER_SIDECAR_SLOW_ACT_MS;
		process.env.BOT_BROWSER_SIDECAR_SLOW_ACT_MS = "1500";
		const path = `/at-cancel-${Date.now()}`;
		const page = await openPage(
			playwrightContext(session),
			path,
			`<!doctype html><body><input id="slow" name="slow" value="" /></body>`,
		);
		const target = (await listCdpTargets(session.cdpEndpoint)).find((t) => t.url.includes(path));
		const engine = new AnchortreeEngine({ cdpUrl: session.cdpEndpoint });
		try {
			await engine.bind(target!.id);
			const snap = await engine.observe();
			assertSnap(snap, "observe slow fill");
			const ref = snap.data.refs.find((r) => r.editable)?.ref;
			const opCtx = refCtx(snap.data);
			await engine.describeControl(ref!, opCtx);
			const fillPromise = engine.fill(ref!, opCtx, "should-not-land");
			await new Promise((r) => setTimeout(r, 50));
			engine.cancel();
			const outcome = await fillPromise;
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) expect(outcome.code).toBe("operation_cancelled");
			expect(await page.inputValue("#slow")).toBe("");
		} finally {
			if (prevSlow === undefined) delete process.env.BOT_BROWSER_SIDECAR_SLOW_ACT_MS;
			else process.env.BOT_BROWSER_SIDECAR_SLOW_ACT_MS = prevSlow;
			await page.close().catch(() => {});
			await engine.dispose();
		}
	});
});

describe("AnchortreeSidecarClient cancellation", () => {
	it("settles pending promises promptly on cancel", async () => {
		const client = new AnchortreeSidecarClient({ requestTimeoutMs: 60_000 });
		const slow = client.call("observe", {});
		client.cancel();
		const outcome = await slow;
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error.code).toBe("operation_cancelled");
		await client.shutdown();
	});
});
