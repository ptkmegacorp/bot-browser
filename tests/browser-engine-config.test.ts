import { afterEach, describe, expect, it } from "vitest";
import { resolvedBrowserEngineId } from "../src/config.js";

describe("resolvedBrowserEngineId", () => {
	const prev = process.env.BOT_BROWSER_BROWSER_ENGINE;

	afterEach(() => {
		if (prev === undefined) delete process.env.BOT_BROWSER_BROWSER_ENGINE;
		else process.env.BOT_BROWSER_BROWSER_ENGINE = prev;
	});

	it("defaults to anchortree", () => {
		delete process.env.BOT_BROWSER_BROWSER_ENGINE;
		expect(resolvedBrowserEngineId()).toBe("anchortree");
	});

	it("accepts playwright-mcp override", () => {
		process.env.BOT_BROWSER_BROWSER_ENGINE = "playwright-mcp";
		expect(resolvedBrowserEngineId()).toBe("playwright-mcp");
	});

	it("accepts fake override", () => {
		process.env.BOT_BROWSER_BROWSER_ENGINE = "fake";
		expect(resolvedBrowserEngineId()).toBe("fake");
	});
});
