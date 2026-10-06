import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const OUT = "/tmp/usba-e2e-verify";
mkdirSync(OUT, { recursive: true });
const BASE = "http://127.0.0.1:9477";
const MODEL = "saturn::qwen3.8-27b-huihui-swift-gsq-rco-iq2_xs-local";
const REPO_EXT = "/home/bot/projects/ubuntu-shared-browser-agent/extension";

const state = JSON.parse(
	readFileSync(`${process.env.HOME}/.local/share/ubuntu-shared-browser-agent/state/chrome-runtime.json`, "utf8"),
);
const token = state.pairingToken;

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const session = await browser.newBrowserCDPSession();
const { extensions } = await session.send("Extensions.getExtensions", {});
await session.detach();
const ext = extensions?.find(
	(e) => e.path === REPO_EXT || e.name === "Ubuntu Shared Browser Agent",
);
if (!ext?.id) throw new Error("extension not loaded");
const EXT_ID = ext.id;
writeFileSync(`${OUT}/extension-id.txt`, EXT_ID + "\n");

const apiHeaders = {
	"Content-Type": "application/json",
	"X-USBA-Token": token,
	Origin: `chrome-extension://${EXT_ID}`,
};

const context = browser.contexts()[0] ?? (await browser.newContext());

let welcome = context.pages().find((p) => p.url().includes("/fixtures/welcome"));
if (!welcome) {
	welcome = await context.newPage();
	await welcome.goto(`${BASE}/fixtures/welcome.html`, { waitUntil: "domcontentloaded" });
}
await welcome.screenshot({ path: `${OUT}/01-welcome-tab.png`, fullPage: true });

let panel = context.pages().find((p) => p.url().includes("/sidepanel.html"));
if (!panel) {
	panel = await context.newPage();
	await panel.goto(`chrome-extension://${EXT_ID}/sidepanel.html`, { timeout: 30_000 });
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
await panel.screenshot({ path: `${OUT}/02-sidepanel-paired.png`, fullPage: true });

await fetch(`${BASE}/api/control`, {
	method: "POST",
	headers: apiHeaders,
	body: JSON.stringify({ action: "attach_tab", targetId: state.taskTargetId }),
});

const formPage = await context.newPage();
await formPage.goto(`${BASE}/fixtures/form.html`);
const marker = `E2E-${Date.now().toString(36)}`;
await formPage.locator("#name").fill(marker);
const cdp = await context.newCDPSession(formPage);
const { targetInfo } = await cdp.send("Target.getTargetInfo");
await cdp.detach();
await formPage.screenshot({ path: `${OUT}/03-form-before.png`, fullPage: true });

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
	signal: AbortSignal.timeout(240_000),
});
const fillBody = await fillRes.json();
if (!fillRes.ok) throw new Error(`form chat ${fillRes.status}: ${JSON.stringify(fillBody)}`);

const gotEmail = await formPage.locator("#email").inputValue();
const gotName = await formPage.locator("#name").inputValue();
if (gotEmail !== email || gotName !== marker) {
	throw new Error(`form verify failed email=${gotEmail} name=${gotName}`);
}
await formPage.screenshot({ path: `${OUT}/04-form-after-fill.png`, fullPage: true });

writeFileSync(
	`${OUT}/result.json`,
	JSON.stringify(
		{
			ok: true,
			extensionId: EXT_ID,
			email,
			marker,
			reply: (fillBody.text ?? "").slice(0, 400),
		},
		null,
		2,
	) + "\n",
);

await formPage.close();
await browser.close();
console.log("e2e PASS", OUT);
