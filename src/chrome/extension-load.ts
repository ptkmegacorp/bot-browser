import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { bundledExtensionDir, cdpUrl, DEFAULT_CDP_PORT } from "../config.js";

/** Chrome requires a per-extension opt-in; not controllable from manifest alone. */
async function ensureExtensionIncognitoEnabled(browser: Browser, extensionId: string): Promise<void> {
	const context = browser.contexts()[0];
	if (!context) return;
	const page = await context.newPage();
	try {
		await page.goto("chrome://extensions");
		await page.evaluate((extId) => {
			return new Promise<void>((resolve, reject) => {
				const dev = (globalThis as { chrome?: { developerPrivate?: {
					updateExtensionConfiguration: (
						opts: { extensionId: string; incognitoAccess: boolean },
						cb: () => void,
					) => void;
				} } }).chrome?.developerPrivate;
				if (!dev) {
					reject(new Error("developerPrivate_unavailable"));
					return;
				}
				dev.updateExtensionConfiguration({ extensionId: extId, incognitoAccess: true }, () => {
					resolve();
				});
			});
		}, extensionId);
	} finally {
		await page.close();
	}
}

/** Google Chrome 137+ ignores --load-extension; install via CDP instead. */
export async function ensureBundledExtensionLoaded(port = DEFAULT_CDP_PORT): Promise<string | undefined> {
	const extDir = bundledExtensionDir();
	if (!existsSync(join(extDir, "manifest.json"))) return undefined;

	const browser = await chromium.connectOverCDP(cdpUrl(port));
	const session = await browser.newBrowserCDPSession();
	let extensionId: string | undefined;
	try {
		const listed = await session.send("Extensions.getExtensions", {});
		const already = listed.extensions?.find((e) => e.path === extDir);
		if (already?.enabled) {
			extensionId = already.id;
		} else {
			const { id } = await session.send("Extensions.loadUnpacked", { path: extDir });
			extensionId = id;
		}
	} finally {
		await session.detach().catch(() => {});
	}
	try {
		if (extensionId) await ensureExtensionIncognitoEnabled(browser, extensionId);
	} finally {
		await browser.close();
	}
	return extensionId;
}
