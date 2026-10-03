import type { BrowserController } from "../browser/controller.js";
import { isEligibleWebTabUrl, resolveTargetForTab } from "../browser/tab-resolve.js";
import { listCdpPages } from "../chrome/cdp.js";
import { cdpUrl } from "../config.js";
import type { AgentHost } from "../agent/session.js";

export type BindingMode = "follow_active" | "pin_tab";

export interface TabSelectionInput {
	revision: number;
	targetId?: string;
	url?: string;
	title?: string;
	windowId?: number;
	manualPin?: boolean;
}

export class AgentPolicy {
	agentEnabled = true;
	bindingMode: BindingMode = "follow_active";
	bindingRevision = 0;
	agentWindowId: number | null = null;

	registerAgentWindow(windowId: number): void {
		this.agentWindowId = windowId;
	}

	setBindingMode(mode: BindingMode): void {
		this.bindingMode = mode;
	}

	async setAgentEnabled(
		enabled: boolean,
		controller: BrowserController,
		agentHost: AgentHost,
	): Promise<void> {
		this.agentEnabled = enabled;
		controller.setAgentEnabled(enabled);
		if (!enabled) {
			controller.drainQueuedWork();
			controller.invalidateObservations();
			await agentHost.session.abort().catch(() => {});
			if (controller.getMode() === "running") {
				controller.setMode("idle");
			}
		}
	}

	async applyTabSelection(
		input: TabSelectionInput,
		controller: BrowserController,
		agentHost: AgentHost,
		cdpPort: number,
		onTabChangedDuringRun: () => void,
	): Promise<{ ok: true; targetId: string; url: string } | { ok: false; error: string }> {
		if (input.revision < this.bindingRevision) {
			return { ok: false, error: "stale_revision" };
		}
		if (this.bindingMode === "pin_tab" && !input.manualPin) {
			return { ok: false, error: "pin_mode_active" };
		}
		if (input.windowId != null && this.agentWindowId != null && input.windowId !== this.agentWindowId) {
			return { ok: false, error: "foreign_window" };
		}

		let targetId = input.targetId?.trim();
		const url = input.url?.trim() ?? "";
		const title = input.title?.trim() ?? "";

		if (!targetId) {
			if (!isEligibleWebTabUrl(url)) return { ok: false, error: "ineligible_tab" };
			const pages = await listCdpPages(cdpUrl(cdpPort));
			const resolved = resolveTargetForTab(url, title, pages);
			if ("error" in resolved) return { ok: false, error: resolved.error };
			targetId = resolved.targetId;
		}

		const live = await controller.syncLiveBinding();
		if (
			live.attached &&
			live.targetId === targetId &&
			live.url &&
			(!url || live.url === url) &&
			controller.getMode() !== "running"
		) {
			this.bindingRevision = input.revision;
			return { ok: true, targetId: live.targetId, url: live.url };
		}

		const wasRunning = controller.getMode() === "running";
		if (wasRunning) {
			controller.drainQueuedWork();
			controller.invalidateObservations();
			await agentHost.session.abort().catch(() => {});
			controller.setMode("idle");
			onTabChangedDuringRun();
		}

		try {
			const attached = await controller.attachTab(targetId);
			this.bindingRevision = input.revision;
			return { ok: true, targetId: attached.targetId, url: attached.url };
		} catch (err) {
			const message = err instanceof Error ? err.message : "attach_failed";
			return { ok: false, error: message };
		}
	}
}
