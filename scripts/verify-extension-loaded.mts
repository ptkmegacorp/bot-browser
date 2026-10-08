import { chromium } from "playwright";
import { cdpHealthy } from "../src/chrome/cdp.ts";
import { cdpUrl, DEFAULT_CDP_PORT } from "../src/config.ts";

const port = Number(process.env.BOT_BROWSER_CDP_PORT ?? DEFAULT_CDP_PORT);
const base = cdpUrl(port);
const expectName = "Bot Browser";

if (!(await cdpHealthy(base))) {
	console.error("verify-extension: CDP not reachable at", base);
	process.exit(1);
}

const browser = await chromium.connectOverCDP(base);
const session = await browser.newBrowserCDPSession();
try {
	const { extensions } = await session.send("Extensions.getExtensions", {});
	const ext = extensions?.find((e) => e.name === expectName && e.enabled);
	if (!ext?.id) {
		console.error("verify-extension: no enabled extension named", expectName);
		console.error("listed:", JSON.stringify(extensions ?? []));
		process.exit(1);
	}
	const panelUrl = `chrome-extension://${ext.id}/sidepanel.html`;
	const ctx = browser.contexts()[0];
	if (!ctx) {
		console.error("verify-extension: no browser context");
		process.exit(1);
	}
	const panel = await ctx.newPage();
	await panel.goto(panelUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
	const fields = await panel.locator("#baseUrl, #token").count();
	if (fields < 2) {
		console.error("verify-extension: side panel UI missing settings fields");
		process.exit(1);
	}
	console.log(`verify-extension: ok (${ext.id})`);
} finally {
	await session.detach().catch(() => {});
	await browser.close();
}
