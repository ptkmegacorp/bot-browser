import { join } from "node:path";
import { cdpUrl, stateDir } from "../config.js";
import type { BrowserEngine } from "./engine.js";
import { FakeBrowserEngine } from "./engines/fake-engine.js";
import { PlaywrightMcpEngine } from "./engines/playwright-mcp.js";

export function createBrowserEngine(cdpPort: number): BrowserEngine {
	if (process.env.USBA_BROWSER_ENGINE === "fake") {
		return new FakeBrowserEngine();
	}
	return new PlaywrightMcpEngine({
		cdpUrl: cdpUrl(cdpPort),
		outputDir: join(stateDir(), "mcp-output"),
	});
}
