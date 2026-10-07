import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { apiHeaders, startPiE2eServer } from "./helpers/pi-e2e-server.js";
import { loadSyntheticHtml, TEST_ORIGIN } from "./helpers/test-page.js";

const enabled = process.env.BOT_BROWSER_E2E_PI === "1";
const port = 19670;
const token = "handoff-pi-token";

describe.skipIf(!enabled)("live handoff over HTTP with real Pi session", () => {
	let browser: Awaited<ReturnType<typeof chromium.launch>>;
	let controller: BrowserController;
	let server: Awaited<ReturnType<typeof startPiE2eServer>>["server"];
	let agentHost: Awaited<ReturnType<typeof startPiE2eServer>>["agentHost"];

	afterEach(async () => {
		server?.close();
		await agentHost?.dispose();
		await controller?.dispose();
		await browser?.close();
	});

	it(
		"human_handoff blocks observations while idle chat is rejected",
		async () => {
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage();
			await loadSyntheticHtml(page, `<input name="secret" autocomplete="one-time-code" value="123456" />`);

			controller = new BrowserController(new TabBindingStore(), 9333);
			controller.forTestingAttachPage(page);
			controller.originScope.approve(TEST_ORIGIN);

			const started = await startPiE2eServer({ port, token, controller, taskUrl: page.url() });
			server = started.server;
			agentHost = started.agentHost;

			const headers = apiHeaders(token);
			await fetch(`http://127.0.0.1:${port}/api/control`, {
				method: "POST",
				headers,
				body: JSON.stringify({ action: "human_handoff" }),
			});

			expect(controller.getMode()).toBe("human_handoff");
			await expect(controller.snapshot()).rejects.toThrow(/observations_paused/);

			const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
				method: "POST",
				headers,
				body: JSON.stringify({ message: "snapshot the page" }),
			});
			expect(chatRes.status).toBe(409);

			await fetch(`http://127.0.0.1:${port}/api/control`, {
				method: "POST",
				headers,
				body: JSON.stringify({ action: "human_handoff_done", confirmedSafe: true }),
			});
			expect(controller.getMode()).toBe("idle");
		},
		60_000,
	);
});
