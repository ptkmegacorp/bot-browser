import { chromium } from "playwright";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { createAppServer } from "../src/server/http.js";
import { loadSyntheticHtml, TEST_ORIGIN } from "./helpers/test-page.js";

const port = 19670;
const token = "disabled-token";

describe("agent_disabled", () => {
	let server: Server;
	let controller: BrowserController;
	let browser: Awaited<ReturnType<typeof chromium.launch>>;
	let promptCalls = 0;

	afterEach(async () => {
		server?.close();
		await browser?.close();
		await controller?.dispose();
	});

	it("blocks chat and tools when agent is disabled", async () => {
		browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();
		await loadSyntheticHtml(page, "<p>x</p>");
		controller = new BrowserController(new TabBindingStore(), 9333);
		controller.forTestingAttachPage(page);
		controller.originScope.approve(TEST_ORIGIN);

		const agentHost = {
			session: {
				model: { provider: "saturn", id: "test" },
				subscribe: () => () => {},
				prompt: async () => {
					promptCalls += 1;
				},
				abort: async () => {},
				getLastAssistantText: () => "",
			},
			modelRuntime: { getModel: () => undefined },
			setModel: async () => {},
			listModels: async () => [],
			dispose: async () => {},
		};

		const app = createAppServer({
			host: "127.0.0.1",
			port,
			pairingToken: token,
			chromeState: {
				pid: 1,
				cdpPort: 9333,
				taskTargetId: "test",
				taskUrl: page.url(),
				pairingToken: token,
				updatedAt: "",
			},
			controller,
			agentHost,
		});
		server = app.server;
		await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));

		await fetch(`http://127.0.0.1:${port}/api/control`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-USBA-Token": token },
			body: JSON.stringify({ action: "set_agent_enabled", enabled: false }),
		});

		const chat = await fetch(`http://127.0.0.1:${port}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-USBA-Token": token },
			body: JSON.stringify({ message: "hello" }),
		});
		expect(chat.status).toBe(409);
		expect(promptCalls).toBe(0);
		expect(controller.isAgentEnabled()).toBe(false);
	});
});
