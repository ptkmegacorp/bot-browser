import { chromium } from "playwright";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { createAppServer } from "../src/server/http.js";

const port = 19671;
const token = "origin-policy-token";

describe("origin policy HTTP", () => {
	let server: Server;
	let controller: BrowserController;
	let browser: Awaited<ReturnType<typeof chromium.launch>>;

	afterEach(async () => {
		server?.close();
		await browser?.close();
		await controller?.dispose();
	});

	it("denies chat on unapproved origin in approved_only mode", async () => {
		browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();
		await page.route("https://unapproved.test/**", (route) => {
			route.fulfill({ status: 200, contentType: "text/html", body: "<p>remote</p>" });
		});
		await page.goto("https://unapproved.test/page");
		controller = new BrowserController(new TabBindingStore(), 9333);
		controller.forTestingAttachPage(page);

		const agentHost = {
			session: {
				model: { provider: "saturn", id: "test" },
				subscribe: () => () => {},
				prompt: async () => {},
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

		const chat = await fetch(`http://127.0.0.1:${port}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-USBA-Token": token },
			body: JSON.stringify({ message: "hi" }),
		});
		expect(chat.status).toBe(409);
		const body = await chat.json();
		expect(body.error).toBe("origin_not_approved");

		const chatOk = await fetch(`http://127.0.0.1:${port}/api/control`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-USBA-Token": token },
			body: JSON.stringify({ action: "set_origin_policy", originPolicyMode: "all_public_web" }),
		});
		expect(chatOk.status).toBe(200);

		const chatAfter = await fetch(`http://127.0.0.1:${port}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-USBA-Token": token },
			body: JSON.stringify({ message: "hi" }),
		});
		expect(chatAfter.status).toBe(200);
	});
});
