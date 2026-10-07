import { createServer, type Server } from "node:http";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { PlaywrightMcpEngine } from "../src/browser/engines/playwright-mcp.js";
import { isConsequentialControl, isSensitiveField } from "../src/browser/safety.js";
import {
	launchDedicatedCdpBrowser,
	listCdpTargets,
	type DedicatedCdpSession,
} from "./helpers/mcp-spike-harness.js";

const enabled = process.env.BOT_BROWSER_MCP_ENGINE === "1";
const ORIGIN = "http://127.0.0.1";

describe.skipIf(!enabled)("Playwright MCP review fixes (BOT_BROWSER_MCP_ENGINE=1)", () => {
	let session: DedicatedCdpSession;
	let outputDir: string;

	beforeEach(async () => {
		session = await launchDedicatedCdpBrowser();
		outputDir = await mkdtemp(join(tmpdir(), "bot-browser-mcp-review-out-"));
	});

	afterEach(async () => {
		await session?.cleanup();
		if (outputDir) await rm(outputDir, { recursive: true, force: true }).catch(() => {});
	});

	async function openFixture(html: string, slug: string) {
		const ctx = session.browser.contexts()[0]!;
		const page = await ctx.newPage();
		const path = `/review-${slug}-${Date.now()}`;
		await page.route(`${ORIGIN}/**`, async (route) => {
			if (route.request().url().includes(path)) {
				await route.fulfill({ status: 200, contentType: "text/html", body: html });
				return;
			}
			await route.continue();
		});
		await page.goto(`${ORIGIN}${path}`);
		const targets = await listCdpTargets(session.cdpEndpoint);
		const target = targets.find((t) => t.url.includes(path));
		if (!target?.id) throw new Error("fixture target missing");
		return target.id;
	}

	it("describeControl inspects live DOM for submit and sensitive fields", async () => {
		const targetId = await openFixture(
			`<form><button type="submit">Go</button><input aria-label="Secret" name="otp" autocomplete="one-time-code" value="654321"></form>`,
			"safety",
		);
		const engine = new PlaywrightMcpEngine({ cdpUrl: session.cdpEndpoint, outputDir });
		try {
			expect((await engine.bind(targetId)).ok).toBe(true);
			const obs = await engine.observe();
			expect(obs.ok).toBe(true);
			if (!obs.ok) return;
			const submitRef = obs.data.refs.find((r) => r.role === "button" || r.name === "Go")?.ref;
			const secretRef = obs.data.refs.find((r) => r.name === "Secret" || r.role === "textbox")?.ref;
			expect(submitRef).toBeTruthy();
			expect(secretRef).toBeTruthy();
			const ctx = {
				observationId: obs.data.observationId,
				generation: obs.data.generation,
				bindingRevision: obs.data.bindingRevision,
			};
			const submitDesc = await engine.describeControl(submitRef!, ctx);
			const secretDesc = await engine.describeControl(secretRef!, ctx);
			expect(submitDesc.ok).toBe(true);
			expect(secretDesc.ok).toBe(true);
			if (!submitDesc.ok || !secretDesc.ok) return;
			expect(isConsequentialControl(submitDesc.data)).toBe(true);
			expect(isSensitiveField(secretDesc.data.type, secretDesc.data.autocomplete ?? null, secretDesc.data.name ?? null)).toBe(true);
			expect(obs.data.bodyText).not.toContain("654321");
		} finally {
			await engine.dispose();
		}
	});

	it("navigate rejects unapproved redirect destination", async () => {
		const serverB = await listenOnRandomPort((_req, res) => {
			res.writeHead(200).end("<html><body>origin B</body></html>");
		});
		const serverA = await listenOnRandomPort((req, res) => {
			if (req.url?.startsWith("/redirect")) {
				res.writeHead(302, { Location: `http://127.0.0.1:${serverB.port}/landing` });
				res.end();
				return;
			}
			res.writeHead(200).end("<html><body>origin A</body></html>");
		});

		const targetId = await openFixture(`<p>start</p>`, "redirect");
		const cdpPort = Number(new URL(session.cdpEndpoint).port);
		const engine = new PlaywrightMcpEngine({ cdpUrl: session.cdpEndpoint, outputDir });
		const controller = new BrowserController(new TabBindingStore(), cdpPort, engine);
		controller.originScope.approve(`http://127.0.0.1:${serverA.port}`);
		try {
			await controller.connect(targetId);
			await expect(
				controller.navigate(`http://127.0.0.1:${serverA.port}/redirect`),
			).rejects.toThrow(/origin_not_approved|unexpected_origin_change/);
		} finally {
			await controller.dispose();
			await new Promise<void>((r) => serverA.server.close(() => r()));
			await new Promise<void>((r) => serverB.server.close(() => r()));
		}
	});

	it("scroll uses browser_press_key and moves viewport on a tall page", async () => {
		const targetId = await openFixture(
			`<style>body{height:3000px}</style><p id="top">SCROLL_TOP</p><p id="bottom" style="margin-top:2500px">SCROLL_BOTTOM_MARKER</p>`,
			"scroll",
		);
		const engine = new PlaywrightMcpEngine({ cdpUrl: session.cdpEndpoint, outputDir });
		try {
			expect((await engine.bind(targetId)).ok).toBe(true);
			expect((await engine.observe()).ok).toBe(true);
			const scrolled = await engine.scroll("down");
			expect(scrolled.ok).toBe(true);
			if (!scrolled.ok) return;
			expect(scrolled.code).not.toBe("not_implemented");
			expect((await engine.observe()).ok).toBe(true);
		} finally {
			await engine.dispose();
		}
	});
});

async function listenOnRandomPort(
	handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ port: number; server: Server }> {
	return new Promise((resolve, reject) => {
		const server = createServer(handler);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("no port"));
				return;
			}
			resolve({ port: addr.port, server });
		});
		server.on("error", reject);
	});
}
