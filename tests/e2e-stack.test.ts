import { chromium } from "playwright";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { loadSyntheticHtml, TEST_ORIGIN } from "./helpers/test-page.js";
import { createAppServer } from "../src/server/http.js";

const port = 19667;
const token = "e2e-token";

function mockHost(controller: BrowserController) {
	return {
		session: {
			model: { provider: "saturn", id: "test" },
			subscribe: () => () => {},
			prompt: async (message: string) => {
				if (message.includes("fill form")) {
					const snap = await controller.snapshot();
					const name = snap.nodes.find((n) => n.name === "name" || n.role === "text")!;
					await controller.fill(name.ref, snap.generation, "E2E User");
				}
			},
			abort: async () => {},
			getLastAssistantText: () => "done",
		},
		modelRuntime: {
			getModel: () => undefined,
		},
		setModel: async () => {},
		listModels: async () => [{ provider: "saturn", id: "test", label: "saturn/test" }],
		dispose: async () => {},
	};
}

describe("synthetic full-stack e2e", () => {
	let server: Server;
	let controller: BrowserController;
	let browser: Awaited<ReturnType<typeof chromium.launch>>;

	afterEach(async () => {
		server?.close();
		await browser?.close();
		await controller?.dispose();
	});

	it("HTTP chat drives browser tools on synthetic form", async () => {
		browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();
		await loadSyntheticHtml(
			page,
			`<form><label>Name <input name="name" /></label><button type="button" id="noop">noop</button></form>`,
		);

		controller = new BrowserController(new TabBindingStore(), 9333);
		controller.forTestingAttachPage(page);
		controller.originScope.approve(TEST_ORIGIN);

		const app = createAppServer({
			host: "127.0.0.1",
			port,
			pairingToken: token,
			chromeState: {
				pid: 1,
				cdpPort: 9333,
				taskTargetId: "t",
				taskUrl: page.url(),
				pairingToken: token,
				updatedAt: "",
			},
			controller,
			agentHost: mockHost(controller) as never,
			runBudgetMs: 5000,
			onPause: () => {},
			onResume: () => {},
			onHumanHandoff: () => {},
		});
		server = app.server;
		await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));

		const headers = {
			"Content-Type": "application/json",
			"X-USBA-Token": token,
			Origin: "chrome-extension://e2e",
		};

		const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
			method: "POST",
			headers,
			body: JSON.stringify({ message: "fill form please" }),
		});
		if (!chatRes.ok) {
			const err = await chatRes.text();
			throw new Error(`chat failed: ${chatRes.status} ${err}`);
		}

		const value = await page.inputValue('input[name="name"]');
		expect(value).toBe("E2E User");

		const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`, { headers });
		const status = await statusRes.json();
		expect(status.mode).toBe("idle");
		expect(status.taskTab.url).toContain("127.0.0.1");
	});
});
