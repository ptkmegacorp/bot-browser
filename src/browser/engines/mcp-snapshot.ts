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
