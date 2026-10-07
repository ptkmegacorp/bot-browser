import type { Server } from "node:http";
import { createAgentHost, type CreateAgentHostOptions } from "../../src/agent/session.js";
import type { BrowserController } from "../../src/browser/controller.js";
import { createAppServer } from "../../src/server/http.js";

export async function startPiE2eServer(params: {
	port: number;
	token: string;
	controller: BrowserController;
	taskUrl: string;
	agentOptions?: CreateAgentHostOptions;
	runBudgetMs?: number;
}): Promise<{ server: Server; agentHost: Awaited<ReturnType<typeof createAgentHost>> }> {
	const agentHost = await createAgentHost(params.controller, params.agentOptions);
	const app = createAppServer({
		host: "127.0.0.1",
		port: params.port,
		pairingToken: params.token,
		chromeState: {
			pid: 1,
			cdpPort: 9333,
			taskTargetId: "t",
			taskUrl: params.taskUrl,
			pairingToken: params.token,
			updatedAt: "",
		},
		controller: params.controller,
		agentHost,
		runBudgetMs: params.runBudgetMs ?? 180_000,
		onPause: () => {},
		onResume: () => {},
		onHumanHandoff: () => {},
	});
	await new Promise<void>((resolve) => app.server.listen(params.port, "127.0.0.1", () => resolve()));
	return { server: app.server, agentHost };
}

export function apiHeaders(token: string) {
	return {
		"Content-Type": "application/json",
		"X-Bot-Browser-Token": token,
		Origin: "chrome-extension://e2e",
	};
}
