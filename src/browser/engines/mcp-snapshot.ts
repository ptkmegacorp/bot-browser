import { maskFieldValue } from "../safety.js";
import type { EngineObservationRef } from "../engine.js";

export interface ParsedSnapshotHeader {
	url: string;
	title: string;
}

/** Parse URL/title from Playwright MCP accessibility snapshot preamble when present. */
export function parseSnapshotHeader(snapshot: string, fallbackUrl: string, fallbackTitle: string): ParsedSnapshotHeader {
	let url = fallbackUrl;
	let title = fallbackTitle;
	for (const line of snapshot.split("\n")) {
		const urlMatch = line.match(/^\s*-\s*Page URL:\s*(.+)\s*$/i);
		if (urlMatch) url = urlMatch[1]!.trim();
		const titleMatch = line.match(/^\s*-\s*Page Title:\s*(.+)\s*$/i);
		if (titleMatch) title = titleMatch[1]!.trim();
	}
	return { url, title };
}

/** Extract interactive refs from MCP YAML snapshot lines. */
export function parseSnapshotRefs(snapshot: string): EngineObservationRef[] {
	const refs: EngineObservationRef[] = [];
	const seen = new Set<string>();
	for (const line of snapshot.split("\n")) {
		const refMatch = line.match(/\[ref=([^\]]+)\]/);
		if (!refMatch) continue;
		const ref = refMatch[1]!;
		if (seen.has(ref)) continue;
		seen.add(ref);

		const roleMatch = line.match(/^\s*-\s+(\w+)/);
		const role = roleMatch?.[1] ?? "element";
		const nameMatch = line.match(/"([^"]*)"/);
		const name = nameMatch?.[1] ?? "";
		const editable = /\btextbox\b|\bcombobox\b|\bsearchbox\b/i.test(line) || role === "textbox";

		let value: string | undefined;
		const valueMatch = line.match(/\bvalue:\s*"([^"]*)"/i) ?? line.match(/\bvalue:\s*(\S+)/i);
		if (valueMatch) {
			value = maskFieldValue(null, null, null, valueMatch[1]!);
		}

		refs.push({ ref, role, name, value, editable: editable || undefined });
	}
	return refs;
}

export function findSnapshotLineForRef(snapshot: string, ref: string): string | undefined {
	for (const line of snapshot.split("\n")) {
		if (line.includes(`[ref=${ref}]`)) return line;
	}
	return undefined;
}

const SENSITIVE_VALUE_LINE =
	/\b(one-time-code|current-password|new-password|cc-number|cc-csc|password)\b/i;

/** Strip cross-tab metadata and mask sensitive field values before exposing text to Pi. */
export function sanitizeMcpSnapshotForPi(raw: string): string {
	let text = raw;
	const openTabs = text.indexOf("### Open tabs");
	const pageSection = text.indexOf("### Page");
	if (openTabs >= 0 && pageSection > openTabs) {
		text = text.slice(0, openTabs).trimEnd() + "\n\n" + text.slice(pageSection);
	}

	const lines = text.split("\n").map((line) => {
		const isSensitiveLine =
			SENSITIVE_VALUE_LINE.test(line) ||
			/\btextbox\b/i.test(line) &&
				(/\bone-time-code\b/i.test(line) || /\bSecret\b/i.test(line) || /\botp\b/i.test(line));
		if (!isSensitiveLine) return line;
		if (/\bvalue:\s*/i.test(line)) {
			return line.replace(/\bvalue:\s*"[^"]*"/gi, 'value: "[masked]"');
		}
		if (/\[ref=[^\]]+\]:/.test(line)) {
			return line.replace(/(\[ref=[^\]]+\]:\s*)\S+/g, "$1[masked]");
		}
		return line.replace(/:\s*\d{4,}\s*$/, ": [masked]");
	});
	return lines.join("\n");
}

/** Bounded readable transcript from the YAML snapshot body (not raw Open tabs). */
export function extractReadableTranscript(sanitized: string, maxChars = 8000): string {
	const start = sanitized.indexOf("### Snapshot");
	const chunk = start >= 0 ? sanitized.slice(start) : sanitized;
	const yaml = chunk.replace(/^### Snapshot\s*/m, "").replace(/^```yaml\s*/m, "").replace(/```\s*$/m, "");
	const lines: string[] = [];
	for (const line of yaml.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("-") === false) continue;
		const afterRef = trimmed.match(/\[ref=[^\]]+\]:\s*(.+)$/);
		if (afterRef?.[1]) {
			lines.push(afterRef[1].trim());
			continue;
		}
		const quoted = trimmed.match(/"([^"]+)"/);
		if (quoted?.[1]) lines.push(quoted[1]);
	}
	const joined = lines.filter(Boolean).join("\n");
	if (joined.length <= maxChars) return joined;
	return joined.slice(0, maxChars) + "\n…";
}
