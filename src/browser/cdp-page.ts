import type { Page } from "playwright";

export async function getCdpTargetId(page: Page): Promise<string> {
	const cdp = await page.context().newCDPSession(page);
	const { targetInfo } = await cdp.send("Target.getTargetInfo");
	await cdp.detach().catch(() => {});
	return targetInfo.targetId;
}
