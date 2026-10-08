import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { bundledExtensionDir, cdpUrl, DEFAULT_CDP_PORT } from "../config.js";

/** Google Chrome 137+ ignores --load-extension; install via CDP instead. */
export async function ensureBundledExtensionLoaded(port = DEFAULT_CDP_PORT): Promise<string | undefined> {
	const extDir = bundledExtensionDir();
	if (!existsSync(join(extDir, "manifest.json"))) return undefined;

	const browser = await chromium.connectOverCDP(cdpUrl(port));
	const session = await browser.newBrowserCDPSession();
	try {
		const listed = await session.send("Extensions.getExtensions", {});
		const already = listed.extensions?.find((e) => e.path === extDir);
		if (already?.enabled) return already.id;

		const { id } = await session.send("Extensions.loadUnpacked", { path: extDir });
		return id;
	} finally {
		await session.detach().catch(() => {});
		await browser.close();
	}
}
