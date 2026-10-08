import { cdpHealthy } from "../src/chrome/cdp.ts";
import { cdpUrl, DEFAULT_CDP_PORT } from "../src/config.ts";
import { ensureBundledExtensionLoaded } from "../src/chrome/extension-load.ts";

const port = Number(process.env.BOT_BROWSER_CDP_PORT ?? DEFAULT_CDP_PORT);
const base = cdpUrl(port);
const deadline = Date.now() + 45_000;

while (!(await cdpHealthy(base))) {
	if (Date.now() > deadline) {
		console.error("bot-browser: CDP not ready at", base);
		process.exit(1);
	}
	await new Promise((r) => setTimeout(r, 500));
}

const id = await ensureBundledExtensionLoaded(port);
if (!id) {
	console.error("bot-browser: extension not loaded (missing manifest?)");
	process.exit(1);
}
console.log(`bot-browser: extension ready (${id})`);
