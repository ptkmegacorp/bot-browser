export type VerificationStatus = "ok" | "warn" | "fail";

export interface ActionVerification {
	status: VerificationStatus;
	/** One line, <= 160 chars, safe to show the model and the user. */
	summary: string;
}

export interface PageFacts {
	url: string;
	title: string;
	readyState: string;
	textLength: number;
	/** Bounded head of readable text for error/interstitial matching. */
	textHead: string;
	scrollY: number;
	scrollHeight: number;
	viewportHeight: number;
}

const SUMMARY_MAX = 160;
const SHORT_BODY_CHARS = 50;

const ERROR_BODY_PATTERNS: RegExp[] = [
	/this site can't be reached/i,
	/\bERR_[A-Z_]+\b/,
	/502 Bad Gateway/i,
	/503 Service Unavailable/i,
];

const ERROR_TITLE_EXACT = new Set(["403 Forbidden", "404 Not Found"]);

const INTERSTITIAL_MARKERS = ["checking your browser", "just a moment", "verify you are human"];

const CAPTCHA_MARKERS = ["recaptcha", "hcaptcha", "i'm not a robot"];

function capSummary(summary: string): string {
	if (summary.length <= SUMMARY_MAX) return summary;
	return `${summary.slice(0, SUMMARY_MAX - 1)}…`;
}

function parseHost(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

function parsePathname(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return "";
	}
}

function hostsRelated(requestedHost: string, landedHost: string): boolean {
	const a = requestedHost.toLowerCase();
	const b = landedHost.toLowerCase();
	if (a === b) return true;
	const stripWww = (h: string) => h.replace(/^www\./, "");
	if (stripWww(a) === stripWww(b)) return true;
	if (a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
	const aw = stripWww(a);
	const bw = stripWww(b);
	if (aw.endsWith(`.${bw}`) || bw.endsWith(`.${aw}`)) return true;
	return false;
}

function pathHasAuthSegment(pathname: string): boolean {
	return /\/(login|signin|auth)(\/|$)/i.test(pathname);
}

function haystackForTextMatch(facts: PageFacts): string {
	return `${facts.textHead}\n${facts.title}`;
}

function matchesErrorBody(facts: PageFacts): boolean {
	const hay = haystackForTextMatch(facts);
	return ERROR_BODY_PATTERNS.some((re) => re.test(hay));
}

function matchesErrorTitle(facts: PageFacts): boolean {
	return ERROR_TITLE_EXACT.has(facts.title.trim());
}

function matchesInterstitial(facts: PageFacts): boolean {
	const hay = haystackForTextMatch(facts).toLowerCase();
	return INTERSTITIAL_MARKERS.some((m) => hay.includes(m));
}

function matchesCaptcha(facts: PageFacts): boolean {
	const hay = haystackForTextMatch(facts).toLowerCase();
	return CAPTCHA_MARKERS.some((m) => hay.includes(m));
}

function isChromeNetErrorUrl(url: string): boolean {
	const lower = url.toLowerCase();
	return lower.startsWith("chrome-error:") || lower.startsWith("about:neterror");
}

function formatLandedSummary(facts: PageFacts): string {
	const titleBit = facts.title ? ` ("${facts.title}")` : "";
	return capSummary(`ok — landed ${facts.url}${titleBit}`);
}

export function classifyPageLoad(facts: PageFacts, requestedUrl?: string): ActionVerification {
	if (isChromeNetErrorUrl(facts.url)) {
		return { status: "fail", summary: capSummary(`fail — browser error page (${facts.url})`) };
	}

	if (matchesErrorBody(facts)) {
		return { status: "fail", summary: capSummary("fail — page shows a browser or HTTP error") };
	}

	if (matchesErrorTitle(facts)) {
		return { status: "fail", summary: capSummary(`fail — error page title "${facts.title}"`) };
	}

	if (requestedUrl) {
		const reqHost = parseHost(requestedUrl);
		const landedHost = parseHost(facts.url);
		if (reqHost && landedHost && !hostsRelated(reqHost, landedHost)) {
			return {
				status: "fail",
				summary: capSummary(`fail — redirected off-domain to ${landedHost}`),
			};
		}
	}

	if (facts.readyState !== "complete") {
		return { status: "warn", summary: capSummary(`warn — document not complete (${facts.readyState})`) };
	}

	if (facts.textLength < SHORT_BODY_CHARS) {
		return { status: "warn", summary: capSummary("warn — page body is blank or still loading") };
	}

	if (matchesInterstitial(facts)) {
		return { status: "warn", summary: capSummary("warn — interstitial or bot check detected") };
	}

	if (matchesCaptcha(facts)) {
		return { status: "warn", summary: capSummary("warn — captcha challenge detected") };
	}

	if (requestedUrl) {
		const reqPath = parsePathname(requestedUrl);
		const landedPath = parsePathname(facts.url);
		if (pathHasAuthSegment(landedPath) && !pathHasAuthSegment(reqPath)) {
			return { status: "warn", summary: capSummary("warn — landed on an auth path") };
		}
	}

	return { status: "ok", summary: formatLandedSummary(facts) };
}

function atBottom(facts: PageFacts): boolean {
	return facts.scrollY + facts.viewportHeight >= facts.scrollHeight - 1;
}

function atTop(facts: PageFacts): boolean {
	return facts.scrollY <= 0;
}

export function describeScroll(facts: PageFacts, previousScrollY?: number): ActionVerification {
	if (previousScrollY !== undefined && previousScrollY === facts.scrollY) {
		if (atBottom(facts)) {
			return { status: "warn", summary: capSummary("warn — already at bottom") };
		}
		if (atTop(facts)) {
			return { status: "warn", summary: capSummary("warn — already at top") };
		}
		return { status: "warn", summary: capSummary("warn — scroll position unchanged") };
	}

	const pct =
		facts.scrollHeight > 0 ? Math.round((facts.scrollY / facts.scrollHeight) * 100) : 0;
	return {
		status: "ok",
		summary: capSummary(`ok — ${facts.scrollY}/${facts.scrollHeight}px (${pct}%)`),
	};
}

export function describeClickNavigation(
	before: { url: string; title: string },
	after: { url: string; title: string },
): ActionVerification {
	const urlChanged = before.url !== after.url;
	const titleChanged = before.title !== after.title;
	if (!urlChanged && !titleChanged) {
		return { status: "ok", summary: capSummary("ok — no URL or title change") };
	}
	if (urlChanged) {
		const path = parsePathname(after.url);
		const pathBit = path || after.url;
		return { status: "ok", summary: capSummary(`ok — navigated to ${pathBit}`) };
	}
	const titleBit = after.title ? ` ("${after.title}")` : "";
	return { status: "ok", summary: capSummary(`ok — title changed${titleBit}`) };
}

export function describeFieldValue(label: string, value: string, expected?: string): ActionVerification {
	const quoted = `"${value}"`;
	if (expected !== undefined && value !== expected) {
		return {
			status: "warn",
			summary: capSummary(`warn — field "${label}" is ${quoted}, expected "${expected}"`),
		};
	}
	return {
		status: "ok",
		summary: capSummary(`ok — field "${label}" now ${quoted}`),
	};
}
