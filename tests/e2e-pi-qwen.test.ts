import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "../src/config.js";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { apiHeaders, startPiE2eServer } from "./helpers/pi-e2e-server.js";
import { loadSyntheticHtml, TEST_ORIGIN } from "./helpers/test-page.js";

const enabled = process.env.USBA_E2E_PI === "1";
const port = 19668;
const token = "pi-e2e-token";
const FILL_VALUE = "Qwen E2E User";

describe.skipIf(!enabled)("Pi SDK + Qwen browser-tool E2E", () => {
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
		"HTTP chat runs real Pi session and fills synthetic form via browser tools",
		async () => {
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage();
			await loadSyntheticHtml(
				page,
				`<form><label>Name <input name="name" autocomplete="name" /></label><button type="button">noop</button></form>`,
			);

			controller = new BrowserController(new TabBindingStore(), 9333);
			controller.forTestingAttachPage(page);
			controller.originScope.approve(TEST_ORIGIN);

			const started = await startPiE2eServer({
				port,
				token,
				controller,
				taskUrl: page.url(),
				agentOptions: {
					provider: DEFAULT_MODEL.provider,
					modelId: DEFAULT_MODEL.id,
					systemPromptAppend: `For form-fill tasks: call page_snapshot once, then browser_fill the name input with exactly "${FILL_VALUE}". Never click buttons.`,
				},
				runBudgetMs: 180_000,
			});
			server = started.server;
			agentHost = started.agentHost;

			const headers = apiHeaders(token);
			const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					message: `Fill the contact form name field with exactly: ${FILL_VALUE}. Do not submit.`,
				}),
			});
			const body = await chatRes.json();
			if (!chatRes.ok) throw new Error(`chat failed: ${JSON.stringify(body)}`);
			expect(String(body.text ?? "").length).toBeGreaterThan(0);

			const value = await page.inputValue('input[name="name"]');
			expect(value).toBe(FILL_VALUE);
			expect(controller.getMode()).toBe("idle");
		},
		180_000,
	);
});
