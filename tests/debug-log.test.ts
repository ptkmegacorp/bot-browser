import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { BrowserController } from "../src/browser/controller.js";
import { TabBindingStore } from "../src/browser/binding.js";
import { FakeBrowserEngine } from "../src/browser/engines/fake-engine.js";
import { createAppServer } from "../src/server/http.js";
import { createBrowserTools } from "../src/agent/tools.js";
import { runTextToolCompatibilityLoop } from "../src/agent/text-tool-shim.js";
import { AnchortreeSidecarClient } from "../src/browser/engines/anchortree-sidecar-client.js";
import { DebugLog, setDebugLog, traceTool, withDebugRun } from "../src/debug-log.js";

let dir: string;
let path: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "bot-browser-debug-test-"));
	path = join(dir, "debug.jsonl");
	setDebugLog(new DebugLog(path));
});
afterEach(() => { setDebugLog(undefined); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
const state = () => ({ engine: "AnchortreeEngine", targetId: "test-target", generation: 2, bindingRevision: 3 });
function rows() { return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)); }

it("correlates async calls and logs blocked outcomes while omitting values and raw results", async () => {
	await withDebugRun({ runId: "run-one", provider: "saturn", model: "qwen-test" }, () =>
		traceTool("browser_fill", { text: "SECRET_PASSWORD", url: "https://user:pass@example.org/?token=SECRET_TOKEN", generation: 2 }, "sdk", state,
			async () => ({ ok: false, blocked: "sensitive_field_human_only", pageText: "PRIVATE_PAGE" })));
	const events = rows();
	expect(events.map((r) => r.event)).toEqual(["tool_start", "tool_end"]);
	expect(events[0]).toMatchObject({ runId: "run-one", model: "qwen-test", targetId: "test-target", bindingRevision: 3, textChars: 15 });
	expect(events[1]).toMatchObject({ callId: events[0].callId, outcome: "blocked", errorCode: "sensitive_field_human_only" });
	expect(readFileSync(path, "utf8")).not.toMatch(/SECRET|PRIVATE_PAGE|example.org/);
	expect(statSync(path).mode & 0o777).toBe(0o600);
});

it("logs exceptions safely and preserves the thrown error", async () => {
	const error = new Error("secret-token-private-url");
	await expect(traceTool("browser_click", {}, "sdk", state, async () => { throw error; })).rejects.toBe(error);
	expect(rows()[1]).toMatchObject({ outcome: "error", errorCode: "internal_error" });
	expect(readFileSync(path, "utf8")).not.toContain(error.message);
});

it("keeps one rotated file with complete JSON lines and private permissions", () => {
	const log = new DebugLog(path, 200);
	for (let i = 0; i < 10; i++) log.write("test", { generation: i });
	for (const p of [path, `${path}.1`]) {
		expect(statSync(p).size).toBeLessThanOrEqual(200);
		expect(statSync(p).mode & 0o777).toBe(0o600);
		for (const line of readFileSync(p, "utf8").trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
	}
});

it("log write failure leaves tool execution working and warns once", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	setDebugLog(new DebugLog(dir)); // A directory cannot be appended as a file.
	expect(await traceTool("page_snapshot", {}, "sdk", state, async () => 7)).toBe(7);
	expect(warn).toHaveBeenCalledTimes(1);
});

it("instruments the actual SDK tool wrapper", async () => {
	const controller = { getDebugState: state, fill: async () => ({ ok: true }) } as unknown as BrowserController;
	const tool = createBrowserTools(controller).find((t) => t.name === "browser_fill")!;
	await withDebugRun({ runId: "sdk-run" }, () => tool.execute("sdk-call", { ref: "secret-ref", generation: 2, text: "private-value" }));
	expect(rows().map((r) => [r.event, r.source, r.runId])).toEqual([
		["tool_start", "sdk", "sdk-run"], ["tool_end", "sdk", "sdk-run"],
	]);
	expect(readFileSync(path, "utf8")).not.toMatch(/secret-ref|private-value/);
});

it("instruments Qwen text-tool calls with structured result summaries", async () => {
	let text = JSON.stringify({ tool_name: "page_snapshot", arguments: {} });
	const session = { getLastAssistantText: () => text, prompt: async () => { text = "done"; } } as unknown as AgentSession;
	const controller = {
		getDebugState: state, isTabAttached: () => true,
		snapshot: async () => ({ generation: 2, nodes: [{ name: "PRIVATE_PAGE" }], url: "https://private.invalid" }),
	} as unknown as BrowserController;
	await withDebugRun({ runId: "shim-run" }, () => runTextToolCompatibilityLoop(session, controller));
	expect(rows()[1]).toMatchObject({ runId: "shim-run", source: "text_shim", name: "page_snapshot", generation: 2, nodeCount: 1 });
	expect(readFileSync(path, "utf8")).not.toMatch(/PRIVATE_PAGE|private.invalid/);
});

it("keeps sidecar request correlation and raw stderr/error text private", async () => {
	const stub = join(dir, "sidecar.mjs");
	writeFileSync(stub, `#!${process.execPath}\nimport {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);process.stderr.write('SECRET_DIAGNOSTIC');console.log(JSON.stringify({v:1,id:r.id,ok:false,error:{code:'stale_ref',message:'SECRET_ERROR'}}));});`, { mode: 0o700 });
	const client = new AnchortreeSidecarClient({ sidecarPath: stub });
	await withDebugRun({ runId: "sidecar-run" }, async () => { await client.call("observe", { text: "SECRET_PARAM" }); });
	client.cancel();
	const events = rows();
	expect(events.find((r) => r.event === "sidecar_response")).toMatchObject({ runId: "sidecar-run", name: "observe", outcome: "error", errorCode: "stale_ref" });
	expect(readFileSync(path, "utf8")).not.toContain("SECRET");
});

it.each([false, true])("records HTTP run context and budget timeout (timeout=%s)", async (timeout) => {
	const engine = new FakeBrowserEngine({ bodyText: "PRIVATE_PAGE" });
	await engine.bind("test-target");
	const controller = new BrowserController(new TabBindingStore(), 9333, engine);
	controller.forTestingBindTarget("test-target");
	controller.originScope.approve("https://fixture.test");
	vi.spyOn(controller, "syncLiveBinding").mockResolvedValue({ attached: true, targetId: "test-target", url: "https://fixture.test/", title: "fixture" });
	const tool = createBrowserTools(controller).find((t) => t.name === "page_snapshot")!;
	let finish = () => {};
	const session = {
		model: { provider: "test-provider", id: "test-model" }, subscribe: () => () => {},
		prompt: async () => { await tool.execute("http-call", {}); if (timeout) await new Promise<void>((resolve) => { finish = resolve; }); },
		abort: async () => { finish(); }, getLastAssistantText: () => "PRIVATE_RESPONSE",
	};
	const { server } = createAppServer({
		host: "127.0.0.1", port: 0, pairingToken: "SECRET_AUTH",
		chromeState: { pid: 1, cdpPort: 9333, taskTargetId: "test-target", taskUrl: "https://fixture.test/", pairingToken: "SECRET_AUTH", updatedAt: "" },
		controller, agentHost: { session, modelRuntime: {}, listModels: async () => [] } as never,
		runBudgetMs: timeout ? 20 : 1000, onPause: () => {}, onResume: () => {}, onHumanHandoff: () => {},
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address() as { port: number };
		const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, {
			method: "POST", headers: { "Content-Type": "application/json", "X-Bot-Browser-Token": "SECRET_AUTH", Origin: "chrome-extension://abc" },
			body: JSON.stringify({ message: "PRIVATE_USER_PROMPT" }),
		});
		expect(response.status).toBe(200);
		const body = await response.json() as { runId: string };
		const events = rows().filter((r) => r.runId === body.runId);
		expect(events.map((r) => r.event)).toEqual(timeout
			? ["run_start", "tool_start", "tool_end", "run_timeout", "run_end"]
			: ["run_start", "tool_start", "tool_end", "run_end"]);
		expect(events[0]).toMatchObject({ provider: "test-provider", model: "test-model", engine: "FakeBrowserEngine" });
		expect(events.at(-1)).toMatchObject({ outcome: timeout ? "timeout" : "ok" });
		expect(readFileSync(path, "utf8")).not.toMatch(/SECRET_AUTH|PRIVATE_/);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await controller.dispose();
	}
});
