import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const EXT_ID = "ibdinaladaneiiljiihiohdmklbnobim";
const BASE = "http://127.0.0.1:9477";
const MODEL = "saturn::qwen3.8-27b-huihui-swift-gsq-rco-iq2_xs-local";
const state = JSON.parse(
	readFileSync(`${process.env.HOME}/.local/share/bot-browser/state/chrome-runtime.json`, "utf8"),
);
const token = state.pairingToken;
const taskTargetId = state.taskTargetId;

const apiHeaders = {
	"Content-Type": "application/json",
	"X-Bot-Browser-Token": token,
	Origin: `chrome-extension://${EXT_ID}`,
};

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const context = browser.contexts()[0] ?? (await browser.newContext());

let panel = context.pages().find((p) => p.url().includes("/sidepanel.html"));
if (!panel) {
	panel = await context.newPage();
	await panel.goto(`chrome-extension://${EXT_ID}/sidepanel.html`, { timeout: 20_000 });
}

await panel.evaluate(
	async ({ base, tok, model }) => {
		document.querySelector("#baseUrl").value = base;
		document.querySelector("#token").value = tok;
		const sel = document.querySelector("#model");
		if (sel) sel.value = model;
		await chrome.storage.local.set({ baseUrl: base, token: tok, selectedModel: model });
		await globalThis.refreshStatus();
	},
	{ base: BASE, tok: token, model: MODEL },
);

await fetch(`${BASE}/api/control`, {
	method: "POST",
	headers: apiHeaders,
	body: JSON.stringify({ action: "attach_tab", targetId: taskTargetId }),
});

await panel.evaluate(async () => {
	await globalThis.refreshStatus();
});

const statusRes = await fetch(`${BASE}/api/status`, { headers: apiHeaders });
const status = await statusRes.json();
if (!statusRes.ok) throw new Error(`status ${statusRes.status}: ${JSON.stringify(status)}`);
console.log("paired", {
	tabAttached: status.tabAttached,
	taskUrl: status.taskTab?.url,
	modelCount: status.models?.length,
});

const chatRes = await fetch(`${BASE}/api/chat`, {
	method: "POST",
	headers: apiHeaders,
	body: JSON.stringify({
		message:
			"On the attached welcome page, use page_snapshot once and reply with the page title only. Do not navigate or click.",
		model: { provider: "saturn", id: "qwen3.8-27b-huihui-swift-gsq-rco-iq2_xs-local" },
	}),
	signal: AbortSignal.timeout(180_000),
});
const chat = await chatRes.json();
if (!chatRes.ok) throw new Error(`chat ${chatRes.status}: ${JSON.stringify(chat)}`);
console.log("welcome_chat_ok", (chat.text ?? "").slice(0, 300));

const formPage = await context.newPage();
await formPage.goto(`${BASE}/fixtures/form.html`);
const marker = `E2E-${Date.now().toString(36)}`;
await formPage.locator("#name").fill(marker);
const cdp = await context.newCDPSession(formPage);
const { targetInfo } = await cdp.send("Target.getTargetInfo");
await cdp.detach();

await fetch(`${BASE}/api/control`, {
	method: "POST",
	headers: apiHeaders,
	body: JSON.stringify({ action: "attach_tab", targetId: targetInfo.targetId }),
});

const email = `e2e-${Date.now().toString(36)}@example.invalid`;
const fillRes = await fetch(`${BASE}/api/chat`, {
	method: "POST",
	headers: apiHeaders,
	body: JSON.stringify({
		message: `Use page_snapshot on the attached form. Fill only the email field with ${email}. Leave name as-is. Do not submit.`,
		model: { provider: "saturn", id: "qwen3.8-27b-huihui-swift-gsq-rco-iq2_xs-local" },
	}),
	signal: AbortSignal.timeout(180_000),
});
const fillBody = await fillRes.json();
if (!fillRes.ok) throw new Error(`form chat ${fillRes.status}: ${JSON.stringify(fillBody)}`);
const gotEmail = await formPage.locator("#email").inputValue();
const gotName = await formPage.locator("#name").inputValue();
if (gotEmail !== email || gotName !== marker) {
	throw new Error(`form verify failed email=${gotEmail} name=${gotName}`);
}
console.log("form_fill_ok", { email, name: gotName, reply: (fillBody.text ?? "").slice(0, 120) });

await formPage.close();
await browser.close();
