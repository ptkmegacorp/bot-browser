import {
	assertLoopbackHost,
	cdpUrl,
	DEFAULT_HTTP_HOST,
	DEFAULT_HTTP_PORT,
	extensionIdFromEnv,
} from "./config.js";
import { navigateCdpTarget } from "./browser/engines/cdp-target-page.js";
import { originFromUrl } from "./browser/origin-scope.js";
import { ensureAgentChrome } from "./chrome/launcher.js";
import { TabBindingStore } from "./browser/binding.js";
import { BrowserController } from "./browser/controller.js";
import { createBrowserEngine } from "./browser/create-engine.js";
import { createAgentHost } from "./agent/session.js";
import { createAppServer } from "./server/http.js";
import { acquireInstanceLock } from "./server/instance-lock.js";

const port = Number(process.env.BOT_BROWSER_PORT ?? DEFAULT_HTTP_PORT);
const host = process.env.BOT_BROWSER_HOST ?? DEFAULT_HTTP_HOST;
assertLoopbackHost(host);

async function boot(): Promise<void> {
	const lock = acquireInstanceLock(port);
	const launch = await ensureAgentChrome(port);
	if (!launch.ok || !launch.state) {
		console.error("Failed to start Agent Chrome:", launch.error);
		process.exit(1);
	}

	const bindings = new TabBindingStore();
	const engine = createBrowserEngine(launch.state.cdpPort);
	const controller = new BrowserController(bindings, launch.state.cdpPort, engine);
	bindings.syncFromChromeState(launch.state, 0);

	const agentHost = await createAgentHost(controller);

	const { server } = createAppServer({
		host,
		port,
		pairingToken: launch.state.pairingToken,
		chromeState: launch.state,
		controller,
		agentHost,
		onPause: () => console.log("[bot-browser] paused"),
		onResume: () => console.log("[bot-browser] resumed"),
		onHumanHandoff: (active) => console.log(`[bot-browser] human handoff ${active ? "on" : "off"}`),
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolve());
	});

	const taskCdp = cdpUrl(launch.state.cdpPort);
	await navigateCdpTarget(taskCdp, launch.state.taskTargetId, launch.state.taskUrl);
	await controller.connect(launch.state.taskTargetId);
	const taskOrigin = originFromUrl(launch.state.taskUrl);
	if (taskOrigin) controller.originScope.approve(taskOrigin);

	console.log(`bot-browser listening on http://${host}:${port}`);
	console.log(`Pairing token (set in extension): ${launch.state.pairingToken}`);
	const extId = extensionIdFromEnv();
	if (extId) console.log(`Paired extension id: ${extId}`);
	console.log(`Task tab: ${launch.state.taskUrl}`);

	const shutdown = async () => {
		lock.release();
		await controller.dispose();
		await agentHost.dispose();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

boot().catch((err) => {
	console.error(err);
	process.exit(1);
});
