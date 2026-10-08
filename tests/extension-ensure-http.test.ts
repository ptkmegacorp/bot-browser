import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { TabBindingStore } from "../src/browser/binding.js";
import { BrowserController } from "../src/browser/controller.js";
import { createAppServer } from "../src/server/http.js";

const port = 19671;
const token = "ext-ensure-token";

describe("/api/extension/ensure", () => {
	let server: Server;

	afterEach(async () => {
		await new Promise<void>((resolve) => server?.close(() => resolve()));
	});

	it("rejects missing pairing token", async () => {
		const controller = new BrowserController(new TabBindingStore(), 9333);
		const agentHost = {
			session: {
				model: { provider: "saturn", id: "test" },
				subscribe: () => () => {},
				prompt: async () => {},
				abort: async () => {},
				getLastAssistantText: () => "",
			},
			modelRuntime: { getModel: () => undefined },
			setModel: async () => {},
			listModels: async () => [],
			dispose: async () => {},
		};
		const app = createAppServer({
			host: "127.0.0.1",
			port,
			pairingToken: token,
			chromeState: {
				pid: 1,
				cdpPort: 9333,
				taskTargetId: "",
				taskUrl: "",
				pairingToken: token,
				updatedAt: "",
			},
			controller,
			agentHost: agentHost as never,
			onPause: () => {},
			onResume: () => {},
			onHumanHandoff: () => {},
		});
		server = app.server;
		await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));

		const res = await fetch(`http://127.0.0.1:${port}/api/extension/ensure`, { method: "POST" });
		expect(res.status).toBe(401);
		await controller.dispose();
	});
});
