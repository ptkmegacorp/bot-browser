import type { Page } from "playwright";

const TEST_ORIGIN = "http://127.0.0.1";

export async function loadSyntheticHtml(page: Page, html: string): Promise<void> {
	await page.route(`${TEST_ORIGIN}/**`, (route) => {
		route.fulfill({ status: 200, contentType: "text/html", body: html });
	});
	await page.goto(`${TEST_ORIGIN}/test`);
}

export { TEST_ORIGIN };
