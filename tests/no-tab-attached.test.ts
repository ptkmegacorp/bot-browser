import { chromium } from "playwright";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { createAppServer } from "../src/server/http.js";
import { loadSyntheticHtml, TEST_ORIGIN } from "./helpers/test-page.js";

const port = 19669;
const token = "no-tab-token";

describe("no_tab_attached", () => {
	let server: Server;
	let controller: BrowserController;
	let browser: Awaited<ReturnType<typeof chromium.launch>>;
	let promptCalls = 0;

	afterEach(async () => {
		server?.close();
		await browser?.close();
		await controller?.dispose();
	});

	it("chat returns 409 without calling the model when detached", async () => {
		browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();
		await loadSyntheticHtml(page, "<p>x</p>");
		controller = new BrowserController(new TabBindingStore(), 9333);
		controller.forTestingAttachPage(page);
		controller.originScope.approve(TEST_ORIGIN);
		controller.detachAgent();

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
				taskTargetId: "",
				taskUrl: "",
				pairingToken: token,
				updatedAt: "",
			},
			controller,
			agentHost,
		});
		server = app.server;
		await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));

		const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Bot-Browser-Token": token },
			body: JSON.stringify({ message: "what is on the page" }),
		});
		const body = await res.json();
		expect(res.status).toBe(409);
		expect(body.error).toBe("no_tab_attached");
		expect(promptCalls).toBe(0);

		const status = await fetch(`http://127.0.0.1:${port}/api/status`, {
			headers: { "X-Bot-Browser-Token": token },
		}).then((r) => r.json());
		expect(status.tabAttached).toBe(false);
		expect(status.taskTab).toBeNull();
	});
});
