import { describe, expect, it } from "vitest";
import { buildChromeLaunchArgv } from "../src/chrome/launcher.js";

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
