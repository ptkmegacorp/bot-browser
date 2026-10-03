import { describe, expect, it } from "vitest";
import { parseTextToolCall } from "../src/agent/text-tool-shim.js";

describe("parseTextToolCall", () => {
	it("parses mcp-style page_snapshot", () => {
		const parsed = parseTextToolCall("<tool_call>\n<function=mcp__browser__page_snapshot>\n</function>\n</tool_call>");
		expect(parsed?.name).toBe("page_snapshot");
	});

	it("parses json tool_name style", () => {
		const parsed = parseTextToolCall('<tool_call>\n{"tool_name": "page_snapshot", "arguments": {}}\n</tool_call>');
		expect(parsed?.name).toBe("page_snapshot");
	});
});
