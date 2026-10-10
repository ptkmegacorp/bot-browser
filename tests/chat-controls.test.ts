import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { createAppServer } from "../src/server/http.js";

describe("chat controls", () => {
	let server: Server;
	let controller: BrowserController;
	let url: string;
	let emit: (event: any) => void;
	const newChat = vi.fn(async () => {});
	const prompt = vi.fn(async () => {});
	const headers = { "Content-Type": "application/json", "X-Bot-Browser-Token": "test" };
	const post = (path: string, body = {}) => fetch(url + path, { method: "POST", headers, body: JSON.stringify(body) });

	beforeEach(async () => {
		newChat.mockReset();
		prompt.mockReset();
		controller = new BrowserController(new TabBindingStore(), 9333);
		vi.spyOn(controller, "syncLiveBinding").mockResolvedValue({ attached: true } as never);
		server = createAppServer({
			host: "127.0.0.1", port: 0, pairingToken: "test", controller,
			chromeState: { cdpPort: 9333 } as never,
			agentHost: {
				newChat,
				session: {
					subscribe: (cb: typeof emit) => { emit = cb; return () => {}; },
					prompt, getLastAssistantText: () => "Hello", abort: async () => {},
				},
			} as never,
			onPause: () => {}, onResume: () => {}, onHumanHandoff: () => {},
		}).server;
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});

	afterEach(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await controller.dispose();
	});

	it("requires authentication and resets without a bound tab", async () => {
		expect((await fetch(url + "/api/new-chat", { method: "POST" })).status).toBe(401);
		expect(newChat).not.toHaveBeenCalled();
		expect((await post("/api/new-chat")).status).toBe(200);
		expect(newChat).toHaveBeenCalledOnce();
	});

	it("reports all model-call tokens, including cached input, and final stop reason", async () => {
		prompt.mockImplementation(async () => {
			for (const stopReason of ["toolUse", "length"]) {
				emit({ type: "message_end", message: { role: "assistant", stopReason,
					usage: { input: 10, cacheRead: 20, cacheWrite: 5, output: 7 } } });
			}
		});
		const res = await post("/api/chat", { message: "hi" });
		expect(res.status).toBe(200);
		expect((await res.json()).usage).toEqual({ input: 70, output: 14, stopReason: "length" });
	});

	it("surfaces SDK model errors instead of reporting a successful unfinished response", async () => {
		prompt.mockImplementation(async () => {
			emit({ type: "message_end", message: { role: "assistant", stopReason: "error",
				errorMessage: "upstream failed", usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 2 } } });
		});
		const res = await post("/api/chat", { message: "hi" });
		expect(res.status).toBe(500);
		expect((await res.json()).error).toBe("upstream failed");
	});

	it("rejects chat and reset during a run, then releases the lock", async () => {
		let release!: () => void;
		let started!: () => void;
		const ready = new Promise<void>((resolve) => { started = resolve; });
		prompt.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; started(); }));
		const run = post("/api/chat", { message: "hi" });
		await ready;
		expect((await post("/api/new-chat")).status).toBe(409);
		expect((await post("/api/chat", { message: "hi" })).status).toBe(409);
		expect(newChat).not.toHaveBeenCalled();
		release();
		await run;
		expect((await post("/api/new-chat")).status).toBe(200);
	});
});
