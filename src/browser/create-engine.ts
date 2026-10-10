import { join } from "node:path";
import { cdpUrl, resolvedBrowserEngineId, stateDir } from "../config.js";
import type { BrowserEngine } from "./engine.js";
import { AnchortreeEngine } from "./engines/anchortree-engine.js";
import { FakeBrowserEngine } from "./engines/fake-engine.js";
import { PlaywrightMcpEngine } from "./engines/playwright-mcp.js";

export function createBrowserEngine(cdpPort: number): BrowserEngine {
	switch (resolvedBrowserEngineId()) {
		case "fake":
			return new FakeBrowserEngine();
		case "playwright-mcp":
			return new PlaywrightMcpEngine({
				cdpUrl: cdpUrl(cdpPort),
				outputDir: join(stateDir(), "mcp-output"),
			});
		case "anchortree":
			return new AnchortreeEngine({
				cdpUrl: cdpUrl(cdpPort),
			});
	}
}
