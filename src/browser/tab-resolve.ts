import type { CdpPageTarget } from "../chrome/cdp.js";

export function isEligibleWebTabUrl(url: string | undefined): boolean {
	if (!url) return false;
	return url.startsWith("http://") || url.startsWith("https://");
}

/** Resolve CDP target id from extension tab metadata; fail closed on ambiguity. */
export function resolveTargetForTab(
	url: string,
	title: string,
	pages: CdpPageTarget[],
): { targetId: string } | { error: string } {
	const matches = pages.filter((p) => p.type === "page" && p.url === url);
	if (matches.length === 0) return { error: "tab_not_in_cdp" };
	if (matches.length === 1) return { targetId: matches[0]!.id };
	const titled = matches.filter((p) => (p.title ?? "") === title);
	if (titled.length === 1) return { targetId: titled[0]!.id };
	return { error: "ambiguous_tab_match" };
}
