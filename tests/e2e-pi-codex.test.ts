import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { createAgentHost } from "../src/agent/session.js";
import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_THINKING_LEVEL } from "../src/config.js";
import { loadSyntheticHtml, TEST_ORIGIN } from "./helpers/test-page.js";

const enabled = process.env.BOT_BROWSER_E2E_CODEX === "1";

function assistantText(messages: { role: string; content: unknown }[]): string {
	const last = messages.filter((m) => m.role === "assistant").at(-1);
	if (!last) return "";
	if (typeof last.content === "string") return last.content;
	if (Array.isArray(last.content)) {
		return last.content
			.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}

describe.skipIf(!enabled)("Pi SDK + Codex OAuth E2E", () => {
	let browser: Awaited<ReturnType<typeof chromium.launch>>;
	let controller: BrowserController;
	let agentHost: Awaited<ReturnType<typeof createAgentHost>>;

	afterEach(async () => {
		await agentHost?.dispose();
		await controller?.dispose();
		await browser?.close();
	});

	it(
		"real Codex inference through Pi session",
		async () => {
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage();
			await loadSyntheticHtml(page, `<p>Codex smoke page</p>`);

			controller = new BrowserController(new TabBindingStore(), 9333);
			controller.forTestingAttachPage(page);
			controller.originScope.approve(TEST_ORIGIN);

			agentHost = await createAgentHost(controller, {
				provider: DEFAULT_CODEX_MODEL.provider,
				modelId: DEFAULT_CODEX_MODEL.id,
				thinkingLevel: DEFAULT_CODEX_THINKING_LEVEL,
			});

			await agentHost.session.prompt("Reply with exactly: CODEX_OK");
			const assistants = agentHost.session.messages.filter((m) => m.role === "assistant");
			expect(assistants.length).toBeGreaterThan(0);
			const last = assistants.at(-1) as {
				stopReason?: string;
				errorMessage?: string;
				usage?: { totalTokens?: number };
			};
			expect(last?.stopReason).not.toBe("error");
			expect(last?.errorMessage ?? "").toBe("");
			const text = assistantText(agentHost.session.messages) || agentHost.session.getLastAssistantText() || "";
			expect(text).toMatch(/CODEX_OK/i);
		},
		120_000,
	);
});
