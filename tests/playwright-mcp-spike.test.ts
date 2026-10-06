import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Browser } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
	isConsequentialControl,
	isSensitiveField,
} from "../src/browser/safety.js";
import {
	agentChromeReachable,
	createInProcessMcpClient,
	refMatchingSnapshotLine,
launchDedicatedCdpBrowser,
	listCdpTargets,
	mcpCall,
	mcpConfigForCdp,
	toolText,
} from "./helpers/mcp-spike-harness.js";

const spikeEnabled = process.env.USBA_MCP_SPIKE === "1";
const SPIKE_ORIGIN = "http://127.0.0.1";
const DUP_PATH = "/spike-dup-url";

function tabIndicesForUrl(listText: string, url: string): number[] {
	const indices: number[] = [];
	for (const line of listText.split("\n")) {
		const m = line.match(/^- (\d+):/);
		if (m && line.includes(url)) indices.push(Number(m[1]));
	}
	return indices;
}

async function openSameUrlTab(sessionBrowser: Browser, marker: string) {
	const ctx = sessionBrowser.contexts()[0]!;
	const page = await ctx.newPage();
	await page.route(`${SPIKE_ORIGIN}/**`, async (route) => {
		const reqUrl = route.request().url();
		if (reqUrl.includes(DUP_PATH)) {
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

describe.skipIf(!spikeEnabled)("playwright MCP spike (USBA_MCP_SPIKE=1)", () => {
	let session: DedicatedCdpSession;
	let outputDir: string;
	let agentCdpUp = false;

	beforeAll(async () => {
		agentCdpUp = await agentChromeReachable();
		session = await launchDedicatedCdpBrowser();
		outputDir = await mkdtemp(join(tmpdir(), "usba-mcp-out-"));
	});

	afterAll(async () => {
		await session?.cleanup();
		if (outputDir) await rm(outputDir, { recursive: true, force: true }).catch(() => {});
	});

	let fixtureSeq = 0;

	async function openFixturePage(html: string) {
		const ctx = session.browser.contexts()[0]!;
		const page = await ctx.newPage();
		const path = `/spike-fixture-${fixtureSeq++}`;
		await page.route(`${SPIKE_ORIGIN}/**`, async (route) => {
			if (route.request().url().includes(path)) {
				await route.fulfill({ status: 200, contentType: "text/html", body: html });
				return;
			}
			await route.continue();
		});
		const url = `${SPIKE_ORIGIN}${path}`;
		await page.goto(url);
		return url;
	}

	async function selectTabByUrl(client: Client, url: string) {
		const listText = toolText(await mcpCall(client, "browser_tabs", { action: "list" }));
		const indices = tabIndicesForUrl(listText, url);
		const index = indices[indices.length - 1];
		expect(index).toBeGreaterThanOrEqual(0);
		await mcpCall(client, "browser_tabs", { action: "select", index });
	}

	it("records Agent Chrome CDP reachability (9333)", () => {
		expect(typeof agentCdpUp).toBe("boolean");
	});

	it("selects distinct tabs with the same URL via browser_tabs index (CDP target ids differ)", async () => {
		const fullUrl = `${SPIKE_ORIGIN}${DUP_PATH}`;
		await openSameUrlTab(session.browser, "TAB_MARKER_ALPHA");
		await openSameUrlTab(session.browser, "TAB_MARKER_BETA");
		const targetsBefore = await listCdpTargets(session.cdpEndpoint);
		const dupTargets = targetsBefore.filter((t) => t.url === fullUrl);
		expect(dupTargets.length).toBeGreaterThanOrEqual(2);
		expect(new Set(dupTargets.map((t) => t.id)).size).toBeGreaterThanOrEqual(2);

		const mcp = await createInProcessMcpClient(mcpConfigForCdp(session.cdpEndpoint, outputDir));
		try {
			const listText = toolText(await mcpCall(mcp.client, "browser_tabs", { action: "list" }));
			const indices = tabIndicesForUrl(listText, fullUrl);
			expect(indices.length).toBeGreaterThanOrEqual(2);
			const [a, b] = indices.slice(-2);

			await mcpCall(mcp.client, "browser_tabs", { action: "select", index: a });
			const snap0 = toolText(await mcpCall(mcp.client, "browser_snapshot", {}));
			await mcpCall(mcp.client, "browser_tabs", { action: "select", index: b });
			const snap1 = toolText(await mcpCall(mcp.client, "browser_snapshot", {}));

			expect(snap0).not.toEqual(snap1);
			expect(snap0.includes("TAB_MARKER_ALPHA") || snap0.includes("TAB_MARKER_BETA")).toBe(true);
			expect(snap1.includes("TAB_MARKER_ALPHA") || snap1.includes("TAB_MARKER_BETA")).toBe(true);
		} finally {
			await mcp.close();
		}
	});

	it("returns accessibility snapshot text for ordinary page content", async () => {
		const url = await openFixturePage(
			`<!doctype html><title>snap</title><body><h1>Spike Heading</h1><input aria-label="nickname" /></body>`,
		);
		const mcp = await createInProcessMcpClient(mcpConfigForCdp(session.cdpEndpoint, outputDir));
		try {
			await selectTabByUrl(mcp.client, url);
			const snap = toolText(await mcpCall(mcp.client, "browser_snapshot", {}));
			expect(snap).toMatch(/Spike Heading/);
			expect(snap.toLowerCase()).toMatch(/nickname|textbox|input/);
		} finally {
			await mcp.close();
		}
	});

	it("fills a harmless synthetic field and captures a screenshot", async () => {
		const url = await openFixturePage(
			`<!doctype html><title>fill</title><body><label>Name <input id="name" name="name" type="text" aria-label="spike-name" /></label></body>`,
		);
		const mcp = await createInProcessMcpClient(mcpConfigForCdp(session.cdpEndpoint, outputDir));
		try {
			await selectTabByUrl(mcp.client, url);
			const snap = toolText(await mcpCall(mcp.client, "browser_snapshot", {}));
			const ref =
				refMatchingSnapshotLine(snap, "textbox") ??
				refMatchingSnapshotLine(snap, "spike-name");
			expect(ref).toBeTruthy();
			const fill = await mcpCall(mcp.client, "browser_type", {
				element: "Name input",
				target: ref,
				text: "spike-user",
			});
			expect(fill.isError).not.toBe(true);
			const shot = await mcpCall(mcp.client, "browser_take_screenshot", { type: "png" });
			expect(shot.isError).not.toBe(true);
			const hasImage = (shot.content ?? []).some((c) => c.type === "image" || c.type === "text");
			expect(hasImage).toBe(true);
		} finally {
			await mcp.close();
		}
	});

	it("after tab close, upstream selects a neighbor tab (not an unavailable terminal state)", async () => {
		// Isolated browser: shared session accumulates tabs from earlier spike cases.
		const isolated = await launchDedicatedCdpBrowser();
		const isolatedOut = await mkdtemp(join(tmpdir(), "usba-mcp-close-"));
		const ctx = isolated.browser.contexts()[0]!;
		const closeOrigin = "http://127.0.0.1";
		async function openCloseFixture(html: string, slug: string) {
			const page = await ctx.newPage();
			const path = `/spike-close-${slug}`;
			await page.route(`${closeOrigin}/**`, async (route) => {
				if (route.request().url().includes(path)) {
					await route.fulfill({ status: 200, contentType: "text/html", body: html });
					return;
				}
				await route.continue();
			});
			const url = `${closeOrigin}${path}`;
			await page.goto(url);
			return url;
		}
		const keepUrl = await openCloseFixture(
			`<!doctype html><title>close-a</title><body><p>CLOSE_KEEP_NEIGHBOR</p></body>`,
			"keep",
		);
		const victimUrl = await openCloseFixture(
			`<!doctype html><title>close-b</title><body><p>CLOSE_VICTIM</p></body>`,
			"victim",
		);
		const mcp = await createInProcessMcpClient(mcpConfigForCdp(isolated.cdpEndpoint, isolatedOut));
		try {
			const listBefore = toolText(await mcpCall(mcp.client, "browser_tabs", { action: "list" }));
			const victim = tabIndicesForUrl(listBefore, victimUrl).pop()!;
			await mcpCall(mcp.client, "browser_tabs", { action: "select", index: victim });
			await mcpCall(mcp.client, "browser_tabs", { action: "close", index: victim });
			expect(tabIndicesForUrl(listBefore, keepUrl).length).toBeGreaterThan(0);
			const snap = toolText(await mcpCall(mcp.client, "browser_snapshot", {}));
			expect(snap).toMatch(/CLOSE_KEEP_NEIGHBOR/);
			expect(snap).not.toMatch(/CLOSE_VICTIM/);
		} finally {
			await mcp.close();
			await isolated.cleanup();
			await rm(isolatedOut, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("adapter disconnect leaves the dedicated Chrome process alive", async () => {
		const mcp = await createInProcessMcpClient(mcpConfigForCdp(session.cdpEndpoint, outputDir));
		await mcpCall(mcp.client, "browser_snapshot", {});
		await mcp.close();
		expect(session.browser.isConnected()).toBe(true);
		const targets = await listCdpTargets(session.cdpEndpoint);
		expect(targets.length).toBeGreaterThan(0);
	});

	it("documents safety preflight remains application-owned (MCP does not classify controls)", () => {
		expect(
			isConsequentialControl({
				tag: "button",
				type: "submit",
				role: null,
				inForm: true,
				label: "Send application",
			}),
		).toBe(true);
		expect(isSensitiveField("password", null, null)).toBe(true);
	});

	it("supports in-process cancellation via AbortSignal on long wait", async () => {
		await openFixturePage(`<!doctype html><title>wait</title><body><p>wait page</p></body>`);
		const mcp = await createInProcessMcpClient(mcpConfigForCdp(session.cdpEndpoint, outputDir));
		try {
			const ac = new AbortController();
			const pending = mcpCall(
				mcp.client,
				"browser_wait_for",
				{ time: 30 },
				ac.signal,
			);
			ac.abort();
			await expect(pending).rejects.toThrow(/abort/i);
		} finally {
			await mcp.close();
		}
	});
});

describe.skipIf(!spikeEnabled)("playwright MCP subprocess smoke (USBA_MCP_SPIKE=1)", () => {
	it("stdio subprocess can list tools when given isolated browser config", async () => {
		const outputDir = await mkdtemp(join(tmpdir(), "usba-mcp-stdio-out-"));
		const cli = join(process.cwd(), "node_modules/@playwright/mcp/cli.js");
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [cli, "--isolated", "--headless", "--output-dir", outputDir],
		});
		const client = new Client({ name: "usba-mcp-stdio-spike", version: "1.0.0" });
		try {
			await client.connect(transport);
			const tools = await client.listTools();
			expect(tools.tools.some((t) => t.name === "browser_snapshot")).toBe(true);
		} finally {
			await client.close().catch(() => {});
			await rm(outputDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});
