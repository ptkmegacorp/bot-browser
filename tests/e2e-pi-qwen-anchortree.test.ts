import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "../src/config.js";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { AnchortreeEngine } from "../src/browser/engines/anchortree-engine.js";
import { apiHeaders, startPiE2eServer } from "./helpers/pi-e2e-server.js";
import { loadSyntheticHtml, TEST_ORIGIN } from "./helpers/test-page.js";
import {
	launchDedicatedCdpBrowser,
	listCdpTargets,
	playwrightContext,
	type DedicatedCdpSession,
} from "./helpers/mcp-spike-harness.js";

const enabled = process.env.BOT_BROWSER_E2E_ANCHORTREE_QWEN === "1";
const port = 19669;
const token = "pi-anchortree-e2e";
const FILL_VALUE = "Anchortree Qwen User";

/** Pi session messages → ordered tool names for acceptance evidence. */
function toolSequenceFromMessages(messages: { role: string; toolName?: string; content?: unknown }[]): string[] {
	const out: string[] = [];
	for (const m of messages) {
		if (m.role === "tool" && m.toolName) out.push(m.toolName);
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const part of m.content) {
				const p = part as { type?: string; name?: string };
				if (p.type === "toolCall" && p.name) out.push(p.name);
			}
		}
	}
	return out;
}

function cdpPortFromEndpoint(endpoint: string): number {
	const u = new URL(endpoint);
	return Number(u.port);
}

describe.skipIf(!enabled)("Pi + Qwen + Anchortree engine E2E", () => {
	let session: DedicatedCdpSession;
	let controller: BrowserController;
	let server: Awaited<ReturnType<typeof startPiE2eServer>>["server"];
	let agentHost: Awaited<ReturnType<typeof startPiE2eServer>>["agentHost"];

	afterEach(async () => {
		server?.close();
		await agentHost?.dispose();
		await controller?.dispose();
		await session?.cleanup();
	});

	it(
		"observe → fill via Pi tools using native Anchortree CDP (no MCP)",
		async () => {
			session = await launchDedicatedCdpBrowser({ attachPlaywright: false });
			const ctx = playwrightContext(session);
			const page = await ctx.newPage();
			await loadSyntheticHtml(
				page,
				`<form><label>Name <input name="name" autocomplete="name" /></label><button type="button">noop</button></form>`,
			);
			const targets = await listCdpTargets(session.cdpEndpoint);
			const target = targets.find((t) => t.url.startsWith(TEST_ORIGIN));
			expect(target?.id).toBeTruthy();

			const engine = new AnchortreeEngine({ cdpUrl: session.cdpEndpoint });
			controller = new BrowserController(
				new TabBindingStore(),
				cdpPortFromEndpoint(session.cdpEndpoint),
				engine,
			);
			await controller.attachTab(target!.id);
			controller.originScope.approve(TEST_ORIGIN);

			const started = await startPiE2eServer({
				port,
				token,
				controller,
				taskUrl: page.url(),
				agentOptions: {
					provider: DEFAULT_MODEL.provider,
					modelId: DEFAULT_MODEL.id,
					systemPromptAppend: `For form-fill tasks: call page_snapshot once, then browser_fill the name input with exactly "${FILL_VALUE}". Never click buttons.`,
				},
				runBudgetMs: 180_000,
			});
			server = started.server;
			agentHost = started.agentHost;

			const chatStarted = Date.now();
			const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
				method: "POST",
				headers: apiHeaders(token),
				body: JSON.stringify({
					message: `Fill the contact form name field with exactly: ${FILL_VALUE}. Do not submit.`,
				}),
			});
			const body = await chatRes.json();
			const chatElapsedMs = Date.now() - chatStarted;
			if (!chatRes.ok) throw new Error(`chat failed: ${JSON.stringify(body)}`);
			expect(String(body.text ?? "").length).toBeGreaterThan(0);

			const value = await page.inputValue('input[name="name"]');
			expect(value).toBe(FILL_VALUE);
			expect(controller.getMode()).toBe("idle");

			const tools = toolSequenceFromMessages(agentHost.session.messages);
			const evidence = {
				engine: "anchortree",
				model: { provider: DEFAULT_MODEL.provider, id: DEFAULT_MODEL.id },
				runId: body.runId,
				chatElapsedMs,
				runBudgetMs: 180_000,
				toolSequence: tools,
				assistantTextChars: String(body.text ?? "").length,
				domInputValue: value,
			};
			// Vitest stdout — copied into ANCHORTREE_VERIFICATION.md after runs.
			console.log(`ANCHORTREE_QWEN_E2E_EVIDENCE ${JSON.stringify(evidence)}`);
			expect(tools.some((t) => t === "page_snapshot" || t === "browser_snapshot")).toBe(true);
			expect(tools.some((t) => t === "browser_fill")).toBe(true);
		},
		180_000,
	);
});
