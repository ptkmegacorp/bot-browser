import { describe, expect, it } from "vitest";
import { isPidAlive } from "../src/chrome/cdp.js";

describe("cdp helpers", () => {
	it("reports current process alive", () => {
		expect(isPidAlive(process.pid)).toBe(true);
	});

	it("reports missing pid dead", () => {
		expect(isPidAlive(99999999)).toBe(false);
	});
});
