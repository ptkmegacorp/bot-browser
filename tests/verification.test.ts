import { describe, expect, it } from "vitest";
import {
	classifyPageLoad,
	describeClickNavigation,
	describeFieldValue,
	describeScroll,
	type PageFacts,
} from "../src/browser/verification.js";

function facts(overrides: Partial<PageFacts> & Pick<PageFacts, "url">): PageFacts {
	return {
		title: "",
		readyState: "complete",
		textLength: 200,
		textHead: "x".repeat(200),
		scrollY: 0,
		scrollHeight: 4800,
		viewportHeight: 800,
		...overrides,
	};
}

describe("classifyPageLoad", () => {
	it("fails on chrome-error and about:neterror URLs", () => {
		expect(classifyPageLoad(facts({ url: "chrome-error://dns/" })).status).toBe("fail");
		expect(classifyPageLoad(facts({ url: "about:neterror?e=dnsNotFound" })).status).toBe("fail");
	});

	it("fails on browser error body text and ERR_* tokens", () => {
		const unreachable = facts({
			url: "https://example.com/",
			textHead: "This site can't be reached",
			textLength: 30,
		});
		expect(classifyPageLoad(unreachable).status).toBe("fail");

		const errCode = facts({
			url: "https://example.com/",
			textHead: "Something went wrong ERR_CONNECTION_RESET",
		});
		expect(classifyPageLoad(errCode).status).toBe("fail");

		const gateway = facts({
			url: "https://example.com/",
			textHead: "502 Bad Gateway from upstream",
		});
		expect(classifyPageLoad(gateway).status).toBe("fail");
	});

	it("fails on HTTP error titles", () => {
		expect(
			classifyPageLoad(
				facts({ url: "https://example.com/missing", title: "404 Not Found" }),
			).status,
		).toBe("fail");
		expect(
			classifyPageLoad(
				facts({ url: "https://example.com/forbidden", title: "403 Forbidden" }),
			).status,
		).toBe("fail");
	});

	it("warns on interstitial markers", () => {
		for (const marker of ["Checking your browser", "Just a moment", "Verify you are human"]) {
			const result = classifyPageLoad(
				facts({ url: "https://cdn.example/", textHead: `${marker} please wait` }),
			);
			expect(result.status).toBe("warn");
		}
	});

	it("warns on captcha markers", () => {
		for (const marker of ["recaptcha", "hcaptcha", "I'm not a robot"]) {
			const result = classifyPageLoad(
				facts({ url: "https://example.com/", textHead: `Please complete ${marker}` }),
			);
			expect(result.status).toBe("warn");
		}
	});

	it("warns on blank or short body", () => {
		const result = classifyPageLoad(
			facts({ url: "https://example.com/", textLength: 10, textHead: "loading…" }),
		);
		expect(result.status).toBe("warn");
	});

	it("warns on unrequested auth-path redirect", () => {
		const result = classifyPageLoad(
			facts({ url: "https://example.com/login?next=/" }),
			"https://example.com/dashboard",
		);
		expect(result.status).toBe("warn");
	});

	it("fails on off-domain redirect", () => {
		const result = classifyPageLoad(
			facts({ url: "https://evil.example/phish" }),
			"https://www.nfl.com/",
		);
		expect(result.status).toBe("fail");
	});

	it("reports ok for SPA title lag with healthy page content", () => {
		const result = classifyPageLoad(
			facts({
				url: "https://www.nfl.com/",
				title: "",
				textLength: 5000,
				textHead: "Scores teams news ".repeat(20),
			}),
			"https://www.nfl.com/",
		);
		expect(result.status).toBe("ok");
		expect(result.summary).toContain("landed https://www.nfl.com/");
	});

	it("keeps summaries within 160 characters", () => {
		const longTitle = "T".repeat(300);
		const result = classifyPageLoad(
			facts({
				url: "https://example.com/",
				title: longTitle,
				textLength: 100,
				textHead: "healthy page body with enough text to pass the short-body check easily",
			}),
		);
		expect(result.summary.length).toBeLessThanOrEqual(160);
	});
});

describe("describeScroll", () => {
	it("reports scroll position when the page moved", () => {
		const result = describeScroll(
			facts({
				url: "https://example.com/",
				scrollY: 1200,
				scrollHeight: 4800,
				viewportHeight: 800,
			}),
		);
		expect(result.status).toBe("ok");
		expect(result.summary).toBe("ok — 1200/4800px (25%)");
	});

	it("warns when already at the bottom with no movement", () => {
		const page = facts({
			url: "https://example.com/",
			scrollY: 4000,
			scrollHeight: 4800,
			viewportHeight: 800,
		});
		const result = describeScroll(page, 4000);
		expect(result.status).toBe("warn");
		expect(result.summary).toBe("warn — already at bottom");
	});

	it("warns on scroll no-op away from edges", () => {
		const page = facts({
			url: "https://example.com/",
			scrollY: 900,
			scrollHeight: 4800,
			viewportHeight: 800,
		});
		const result = describeScroll(page, 900);
		expect(result.status).toBe("warn");
		expect(result.summary).toBe("warn — scroll position unchanged");
	});
});

describe("describeClickNavigation", () => {
	it("reports navigation when the URL changes", () => {
		const result = describeClickNavigation(
			{ url: "https://example.com/", title: "Home" },
			{ url: "https://example.com/scores", title: "Home" },
		);
		expect(result.status).toBe("ok");
		expect(result.summary).toBe("ok — navigated to /scores");
	});

	it("reports no change when URL and title are unchanged", () => {
		const result = describeClickNavigation(
			{ url: "https://example.com/", title: "Home" },
			{ url: "https://example.com/", title: "Home" },
		);
		expect(result.summary).toBe("ok — no URL or title change");
	});
});

describe("describeFieldValue", () => {
	it("reports ok when the value matches", () => {
		const result = describeFieldValue("Full name", "Alice");
		expect(result).toEqual({
			status: "ok",
			summary: 'ok — field "Full name" now "Alice"',
		});
	});

	it("warns when the value does not match expected", () => {
		const result = describeFieldValue("Full name", "Bob", "Alice");
		expect(result.status).toBe("warn");
		expect(result.summary).toContain('expected "Alice"');
	});
});
