import { describe, expect, it } from "vitest";
import { isLocalOrPrivateHost, OriginScope } from "../src/browser/origin-scope.js";

describe("OriginScope", () => {
	it("blocks unsupported schemes", () => {
		const scope = new OriginScope();
		expect(scope.validateNavigation("file:///etc/passwd").ok).toBe(false);
	});

	it("requires explicit approval in approved_only mode", () => {
		const scope = new OriginScope();
		scope.approve("http://127.0.0.1:9477");
		expect(scope.validateNavigation("http://127.0.0.1:9477/x").ok).toBe(true);
		expect(scope.validateNavigation("http://evil.test/x").ok).toBe(false);
		expect(scope.validateNavigation("https://example.com/").ok).toBe(false);
	});

	it("allows public sites in all_public_web mode", () => {
		const scope = new OriginScope();
		scope.setMode("all_public_web");
		expect(scope.validateNavigation("https://example.com/").ok).toBe(true);
		expect(scope.validateNavigation("https://evil.test/x").ok).toBe(true);
	});

	it("still requires approval for local hosts in all_public_web mode", () => {
		const scope = new OriginScope();
		scope.setMode("all_public_web");
		expect(scope.validateNavigation("http://127.0.0.1:9477/x").ok).toBe(false);
		scope.approve("http://127.0.0.1:9477");
		expect(scope.validateNavigation("http://127.0.0.1:9477/x").ok).toBe(true);
	});

	it("detects local/private hostnames", () => {
		expect(isLocalOrPrivateHost("localhost")).toBe(true);
		expect(isLocalOrPrivateHost("127.0.0.1")).toBe(true);
		expect(isLocalOrPrivateHost("192.168.1.1")).toBe(true);
		expect(isLocalOrPrivateHost("example.com")).toBe(false);
	});
});
