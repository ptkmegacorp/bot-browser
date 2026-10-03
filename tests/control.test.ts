import { describe, expect, it } from "vitest";
import { finishChatRun } from "../src/server/control.js";

describe("finishChatRun", () => {
	it("returns idle only from running", () => {
		expect(finishChatRun("running")).toBe("idle");
		expect(finishChatRun("paused")).toBe("paused");
		expect(finishChatRun("human_handoff")).toBe("human_handoff");
	});
});
