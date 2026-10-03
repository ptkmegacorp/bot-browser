import { describe, expect, it } from "vitest";
import { isEligibleWebTabUrl, resolveTargetForTab } from "../src/browser/tab-resolve.js";

describe("tab-resolve", () => {
	it("accepts http(s) only", () => {
		expect(isEligibleWebTabUrl("https://example.com")).toBe(true);
		expect(isEligibleWebTabUrl("chrome://extensions")).toBe(false);
	});

	it("resolves unique url match", () => {
		const r = resolveTargetForTab("https://a.test/", "A", [
			{ id: "t1", type: "page", url: "https://a.test/", title: "A" },
			{ id: "t2", type: "page", url: "https://b.test/", title: "B" },
		]);
		expect(r).toEqual({ targetId: "t1" });
	});

	it("fails on ambiguous urls", () => {
		const r = resolveTargetForTab("https://a.test/", "X", [
			{ id: "t1", type: "page", url: "https://a.test/", title: "A" },
			{ id: "t2", type: "page", url: "https://a.test/", title: "B" },
		]);
		expect(r).toEqual({ error: "ambiguous_tab_match" });
	});
});
