import { describe, expect, it } from "vitest";
import {
	isRawToolCallLeak,
	sanitizeAssistantTextForUser,
	toolActivityLabel,
} from "../src/server/presentation.js";

describe("presentation", () => {
	it("detects raw tool-call leaks", () => {
		expect(isRawToolCallLeak("<tool_call><function=page_snapshot></function></tool_call>")).toBe(true);
		expect(isRawToolCallLeak("Hello there")).toBe(false);
	});

	it("sanitizes tool-call text for users", () => {
		const out = sanitizeAssistantTextForUser('<tool_call>\n{"tool_name":"browser_snapshot"}');
		expect(out).toContain("could not complete");
		expect(out).not.toContain("<tool_call");
	});

	it("maps tool labels for the panel", () => {
		expect(toolActivityLabel("page_snapshot")).toBe("Reading page…");
		expect(toolActivityLabel("browser_fill")).toBe("Filling fields…");
	});
});
