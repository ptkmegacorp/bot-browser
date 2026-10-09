import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Anchortree engine isolation from Playwright MCP", () => {
	it("anchortree adapter sources do not import @playwright/mcp", () => {
		const root = join(import.meta.dirname, "..", "src", "browser", "engines");
		const files = ["anchortree-engine.ts", "anchortree-sidecar-client.ts"];
		for (const file of files) {
			const text = readFileSync(join(root, file), "utf8");
			expect(text).not.toMatch(/@playwright\/mcp/);
			expect(text).not.toMatch(/mcp-client/);
		}
	});
});
