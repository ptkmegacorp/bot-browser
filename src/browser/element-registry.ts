/**
 * Interactive element collection for PlaywrightPageEngine only (unit/e2e tests via
 * BrowserController.forTestingAttachPage). Production uses Playwright MCP snapshots.
 */
import type { ElementHandle, Page } from "playwright";

export interface RegisteredElement {
	generation: number;
	handle: ElementHandle<HTMLElement | SVGElement>;
}

export class ElementRegistry {
	private entries = new Map<string, RegisteredElement>();

	clear(): void {
		for (const entry of this.entries.values()) {
			entry.handle.dispose().catch(() => {});
		}
		this.entries.clear();
	}

	set(ref: string, generation: number, handle: ElementHandle<HTMLElement | SVGElement>): void {
		const prior = this.entries.get(ref);
		prior?.handle.dispose().catch(() => {});
		this.entries.set(ref, { generation, handle });
	}

	get(ref: string, generation: number): RegisteredElement | null {
		const entry = this.entries.get(ref);
		if (!entry || entry.generation !== generation) return null;
		return entry;
	}

	async resolveConnected(ref: string, generation: number): Promise<ElementHandle<HTMLElement | SVGElement>> {
		const entry = this.get(ref, generation);
		if (!entry) throw new Error("stale_snapshot_generation");
		const connected = await entry.handle.evaluate((el) => el.isConnected);
		if (!connected) throw new Error("ref_element_missing");
		return entry.handle;
	}
}

const INTERACTIVE_SELECTOR =
	"button, a[href], input, select, textarea, [role=button], [role=link], [role=textbox], [role=combobox]";

export async function collectInteractiveElements(page: Page, maxNodes: number): Promise<ElementHandle<HTMLElement | SVGElement>[]> {
	const handles = await page.$$(INTERACTIVE_SELECTOR);
	const visible: ElementHandle<HTMLElement | SVGElement>[] = [];
	for (const handle of handles) {
		if (visible.length >= maxNodes) {
			await handle.dispose();
			continue;
		}
		const show = await handle.evaluate((el) => {
			const style = window.getComputedStyle(el);
			return style.visibility !== "hidden" && style.display !== "none";
		});
		if (show) visible.push(handle as ElementHandle<HTMLElement | SVGElement>);
		else await handle.dispose();
	}
	return visible;
}
