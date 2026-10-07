import { describe, expect, it } from "vitest";
import { parseAuth } from "../src/server/auth.js";

describe("parseAuth", () => {
	it("rejects missing token", () => {
		const req = { headers: { origin: "chrome-extension://abc" } } as import("node:http").IncomingMessage;
		expect(parseAuth(req, "secret").ok).toBe(false);
	});

	it("accepts valid extension origin and token", () => {
		const req = {
			headers: { origin: "chrome-extension://abc", "x-bot-browser-token": "secret" },
		} as import("node:http").IncomingMessage;
		expect(parseAuth(req, "secret")).toEqual({ ok: true });
	});

	it("enforces paired extension id when configured", () => {
		const req = {
			headers: { origin: "chrome-extension://abc", "x-bot-browser-token": "secret" },
		} as import("node:http").IncomingMessage;
		expect(parseAuth(req, "secret", "other")).toEqual({ ok: false, reason: "invalid_extension_id" });
		expect(parseAuth(req, "secret", "abc")).toEqual({ ok: true });
	});

	it("rejects bad origin", () => {
		const req = {
			headers: { origin: "https://evil.test", "x-bot-browser-token": "secret" },
		} as import("node:http").IncomingMessage;
		expect(parseAuth(req, "secret")).toEqual({ ok: false, reason: "invalid_origin" });
	});
});
