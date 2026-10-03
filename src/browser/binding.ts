import type { ChromeRuntimeState } from "../chrome/state.js";

export interface TabBinding {
	targetId: string;
	expectedUrlPrefix?: string;
	generation: number;
}

export class TabBindingStore {
	private binding: TabBinding | null = null;

	syncFromChromeState(state: ChromeRuntimeState, generation: number): void {
		this.binding = {
			targetId: state.taskTargetId,
			generation,
		};
	}

	get(): TabBinding | null {
		return this.binding;
	}

	setTarget(targetId: string, generation: number): void {
		this.binding = { targetId, generation };
	}

	clear(): void {
		this.binding = null;
	}

	assertBound(targetId: string): void {
		if (!this.binding || this.binding.targetId !== targetId) {
			throw new Error("stale_tab_binding");
		}
	}
}
