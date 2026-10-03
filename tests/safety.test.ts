import { describe, expect, it } from "vitest";
import {
	isConsequentialControl,
	isPasswordField,
	isRiskyClickLabel,
	isSensitiveField,
	maskFieldValue,
} from "../src/browser/safety.js";

describe("safety", () => {
	it("blocks risky submit labels", () => {
		expect(isRiskyClickLabel("Submit application")).toBe(true);
		expect(isRiskyClickLabel("Next page")).toBe(false);
	});

	it("detects password fields", () => {
		expect(isPasswordField("password", null)).toBe(true);
		expect(isPasswordField("text", "current-password")).toBe(true);
		expect(isPasswordField("text", "email")).toBe(false);
	});

	it("detects sensitive autocomplete tokens", () => {
		expect(isSensitiveField("text", "one-time-code", null)).toBe(true);
		expect(isSensitiveField("text", "cc-number", null)).toBe(true);
		expect(isSensitiveField("text", "email", null)).toBe(false);
	});

	it("masks sensitive values in snapshots", () => {
		expect(maskFieldValue("text", "cc-number", null, "4111")).toBe("[masked]");
	});

	it("blocks form submit buttons without safe type", () => {
		expect(
			isConsequentialControl({
				tag: "button",
				type: null,
				role: null,
				inForm: true,
				label: "Continue",
			}),
		).toBe(true);
		expect(
			isConsequentialControl({
				tag: "button",
				type: "button",
				role: null,
				inForm: true,
				label: "Continue",
			}),
		).toBe(true);
	});
});
