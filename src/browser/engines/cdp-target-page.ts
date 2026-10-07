import { chromium, type Page } from "playwright";
import { getCdpTargetId } from "../cdp-page.js";

async function withPageForCdpTarget<T>(
	cdpUrl: string,
	targetId: string,
	fn: (page: Page) => Promise<T>,
): Promise<T | null> {
	const browser = await chromium.connectOverCDP(cdpUrl);
	try {
		for (const context of browser.contexts()) {
			for (const page of context.pages()) {
				try {
					const id = await getCdpTargetId(page);
					if (id === targetId) return await fn(page);
				} catch {
					/* try next */
				}
			}
		}
		return null;
	} finally {
		await browser.close().catch(() => {});
	}
}

/** Resolve the Playwright page handle for an exact CDP target id (attach mode). */
export async function findPageForCdpTarget(cdpUrl: string, targetId: string): Promise<Page | null> {
	let found: Page | null = null;
	await withPageForCdpTarget(cdpUrl, targetId, async (page) => {
		found = page;
		return null;
	});
	return found;
}

export async function readMainBodyTextForCdpTarget(cdpUrl: string, targetId: string): Promise<string | null> {
	return withPageForCdpTarget(cdpUrl, targetId, async (page) => {
		try {
			return await page.evaluate(() => document.body?.innerText ?? "");
		} catch {
			return "";
		}
	});
}

/** Load the task tab after the local HTTP server is listening (welcome fixture). */
export async function navigateCdpTarget(cdpUrl: string, targetId: string, url: string): Promise<void> {
	const ok = await withPageForCdpTarget(cdpUrl, targetId, async (page) => {
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
		return true;
	});
	if (!ok) throw new Error("unknown_tab");
}
