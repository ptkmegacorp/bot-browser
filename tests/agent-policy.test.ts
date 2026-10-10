import { describe, expect, it, vi } from "vitest";
import { AgentPolicy } from "../src/server/agent-policy.js";

function setup() {
	let mode = "running";
	const controller = {
		syncLiveBinding: vi.fn(async () => ({ attached: true, targetId: "same", url: "https://huggingface.co/" })),
		getMode: () => mode,
		setMode: (value: string) => { mode = value; },
		drainQueuedWork: vi.fn(), invalidateObservations: vi.fn(),
		attachTab: vi.fn(async (targetId: string) => ({ targetId, url: "https://example.com/" })),
	};
	const host = { session: { abort: vi.fn(async () => {}) } };
	const changed = vi.fn();
	const policy = new AgentPolicy();
	const select = (targetId: string, url = "https://huggingface.co/") =>
		policy.applyTabSelection({ targetId, url, revision: 1 }, controller as never, host as never, 9333, changed);
	return { policy, controller, host, changed, select };
}

describe("follow active tab", () => {
	it("does not cancel or rebind on a same-target navigation/load notification", async () => {
		const s = setup();
		expect((await s.select("same")).ok).toBe(true);
		expect(s.controller.getMode()).toBe("running");
		expect(s.controller.attachTab).not.toHaveBeenCalled();
		expect(s.controller.invalidateObservations).not.toHaveBeenCalled();
		expect(s.host.session.abort).not.toHaveBeenCalled();
		expect(s.changed).not.toHaveBeenCalled();
		expect(s.policy.bindingRevision).toBe(1);
	});
	it("ignores a stale URL notification for the same target", async () => {
		const s = setup();
		expect(await s.select("same", "https://huggingface.co/old")).toEqual({ ok: true, targetId: "same", url: "https://huggingface.co/" });
		expect(s.host.session.abort).not.toHaveBeenCalled();
	});
	it("still cancels when the user actually selects a different tab", async () => {
		const s = setup();
		expect((await s.select("other")).ok).toBe(true);
		expect(s.host.session.abort).toHaveBeenCalledOnce();
		expect(s.changed).toHaveBeenCalledOnce();
		expect(s.controller.attachTab).toHaveBeenCalledWith("other");
	});
});
