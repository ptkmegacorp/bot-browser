import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChromeLaunchArgv, pickOrCreateTaskTab } from "../src/chrome/launcher.js";

describe("initial task tab", () => {
	afterEach(() => vi.unstubAllGlobals());
	const welcome = "http://127.0.0.1:9477/fixtures/welcome.html";
	it("uses the first existing web page rather than the welcome or extension page", async () => {
		const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [
			{ id: "panel", type: "page", url: "chrome-extension://id/sidepanel.html" },
			{ id: "welcome", type: "page", url: welcome },
			{ id: "first", type: "page", url: "https://huggingface.co/" },
			{ id: "second", type: "page", url: "https://example.com/" },
		] });
		vi.stubGlobal("fetch", fetch);
		expect(await pickOrCreateTaskTab("http://localhost:9333", welcome)).toEqual({ targetId: "first", url: "https://huggingface.co/" });
		expect(fetch).toHaveBeenCalledOnce();
	});
	it("opens welcome only when there are no eligible pages", async () => {
		const fetch = vi.fn()
			.mockResolvedValueOnce({ ok: true, json: async () => [{ id: "settings", type: "page", url: "chrome://settings" }] })
			.mockResolvedValueOnce({ ok: true, json: async () => ({ id: "new", url: welcome }) });
		vi.stubGlobal("fetch", fetch);
		expect(await pickOrCreateTaskTab("http://localhost:9333", welcome)).toEqual({ targetId: "new", url: welcome });
		expect(fetch.mock.calls[1][1].method).toBe("PUT");
	});
});

describe("chrome launcher argv", () => {
	it("includes sandbox-safe debugging flags", () => {
		const argv = buildChromeLaunchArgv("/usr/bin/google-chrome", "/tmp/profile", 9333, "http://127.0.0.1/welcome");
		expect(argv).toContain("--remote-debugging-port=9333");
		expect(argv.join(" ")).not.toContain("--no-sandbox");
		expect(argv.join(" ")).not.toContain("--headless");
	});

	it("refuses headless flags", () => {
		expect(() =>
			buildChromeLaunchArgv("/usr/bin/google-chrome", "/tmp/p", 9333, "http://x", ["--headless=new"]),
		).toThrow(/forbidden/);
	});
});
