import { chromium } from "playwright";
import { DEFAULT_MODEL } from "../src/config.js";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { apiHeaders, startPiE2eServer } from "../tests/helpers/pi-e2e-server.js";
import { loadSyntheticHtml, TEST_ORIGIN } from "../tests/helpers/test-page.js";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await loadSyntheticHtml(page, '<form><input name="name" /></form>');
const controller = new BrowserController(new TabBindingStore(), 9333);
controller.forTestingAttachPage(page);
controller.originScope.approve(TEST_ORIGIN);
const { server, agentHost } = await startPiE2eServer({
	port: 19668,
	token: "t",
	controller,
	taskUrl: page.url(),
	agentOptions: { provider: DEFAULT_MODEL.provider, modelId: DEFAULT_MODEL.id },
});
const res = await fetch("http://127.0.0.1:19668/api/chat", {
	method: "POST",
	headers: apiHeaders("t"),
	body: JSON.stringify({
		message: "Call page_snapshot, then browser_fill the name field with Qwen E2E User using generation from snapshot.",
	}),
});
console.log("status", res.status);
console.log("body", await res.text());
console.log("tools", agentHost.session.getActiveToolNames());
console.log("messages", JSON.stringify(agentHost.session.messages, null, 2));
console.log("input", await page.inputValue('input[name="name"]'));
server.close();
await agentHost.dispose();
await browser.close();
