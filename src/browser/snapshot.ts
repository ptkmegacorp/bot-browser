import type { ElementHandle, Page } from "playwright";
import { maskFieldValue } from "./safety.js";

export interface SnapshotNode {
	ref: string;
	role: string;
	name: string;
	value?: string;
	editable?: boolean;
}

export interface PageSnapshot {
	url: string;
	title: string;
	generation: number;
	nodes: SnapshotNode[];
}

export const MAX_SNAPSHOT_NODES = 200;

let documentGeneration = 0;

export function bumpDocumentGeneration(): number {
	documentGeneration += 1;
	return documentGeneration;
}

export function currentDocumentGeneration(): number {
	return documentGeneration;
}

export function resetDocumentGenerationForTests(): void {
	documentGeneration = 0;
}

export async function buildSnapshotFromHandles(
	page: Page,
	generation: number,
	handles: ElementHandle<HTMLElement | SVGElement>[],
): Promise<PageSnapshot> {
	const nodes: SnapshotNode[] = [];
	for (let i = 0; i < handles.length; i++) {
		const handle = handles[i]!;
		const ref = `e${i + 1}`;
		const meta = await handle.evaluate((el) => {
			const role =
				el.getAttribute("role") ||
				el.tagName.toLowerCase() ||
				(el instanceof HTMLInputElement ? el.type : "element");
			const name =
				el.getAttribute("aria-label") ||
				(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
					? el.placeholder || el.name
					: "") ||
				el.textContent?.trim().slice(0, 120) ||
				"";
			let value: string | undefined;
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
				value = el.value;
			}
			const editable =
				el instanceof HTMLInputElement ||
				el instanceof HTMLTextAreaElement ||
				(el instanceof HTMLElement ? el.isContentEditable : false);
			return { role, name, value, editable, type: el.getAttribute("type"), autocomplete: el.getAttribute("autocomplete"), fieldName: el.getAttribute("name") };
		});
		nodes.push({
			ref,
			role: meta.role,
			name: meta.name,
			value:
				meta.value !== undefined
					? maskFieldValue(meta.type, meta.autocomplete, meta.fieldName, meta.value)
					: undefined,
			editable: meta.editable || undefined,
		});
	}

	return {
		url: page.url(),
		title: await page.title(),
		generation,
		nodes,
	};
}
