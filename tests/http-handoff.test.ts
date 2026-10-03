import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { createAppServer } from "../src/server/http.js";

function mockAgentHost(promptMs = 80) {
	return {
		session: {
			subscribe: () => () => {},
			prompt: () => new Promise<void>((resolve) => setTimeout(resolve, promptMs)),
			abort: async () => {},
			getLastAssistantText: () => "ok",
		},
		modelRuntime: { getModel: () => undefined },
		setModel: async () => {},
		listModels: async () => [],
		dispose: async () => {},
	};
}

describe("http handoff race", () => {
	let server: Server;
	const port = 19666;
	const token = "test-token";
	let controller: BrowserController;

	afterEach(() => {
		server?.close();
	});

	it("preserves human_handoff when chat finishes after handoff", async () => {
		controller = new BrowserController(new TabBindingStore(), 9333);
		const app = createAppServer({
			host: "127.0.0.1",
			port,
			pairingToken: token,
			chromeState: {
				pid: 1,
				cdpPort: 9333,
				taskTargetId: "t",
				taskUrl: "http://127.0.0.1/welcome",
				pairingToken: token,
				updatedAt: "",
			},
			controller,
			agentHost: mockAgentHost() as never,
			onPause: () => {},
			onResume: () => {},
			onHumanHandoff: () => {},
		});
		server = app.server;
		await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));

		const headers = {
			"Content-Type": "application/json",
			"X-USBA-Token": token,
			Origin: "chrome-extension://abc",
		};

		const chatPromise = fetch(`http://127.0.0.1:${port}/api/chat`, {
			method: "POST",
			headers,
			body: JSON.stringify({ message: "hello" }),
		});

		await new Promise((r) => setTimeout(r, 10));
		await fetch(`http://127.0.0.1:${port}/api/control`, {
			method: "POST",
			headers,
			body: JSON.stringify({ action: "human_handoff" }),
		});
		expect(controller.getMode()).toBe("human_handoff");

		await chatPromise;
		expect(controller.getMode()).toBe("human_handoff");
	});
});
