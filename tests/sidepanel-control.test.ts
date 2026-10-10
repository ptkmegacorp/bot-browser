import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
const controlSource = source.slice(source.indexOf("async function control("), source.indexOf("function openSettings("));

function setup(fetch: ReturnType<typeof vi.fn>) {
	const ctx = {
		fetch, state: { connection: "connected" },
		baseUrl: () => "http://127.0.0.1:9477", headers: () => ({}),
		nextBindingRevision: vi.fn(async () => 1),
		refreshStatus: vi.fn(async () => {}), showInlineBanner: vi.fn(),
		setConnStatus: vi.fn(), updateContextBar: vi.fn(), updateComposerForMode: vi.fn(),
		openSettings: vi.fn(),
	};
	const control = runInNewContext(controlSource + "\ncontrol", ctx);
	return { ctx, control };
}

describe("sidepanel control requests", () => {
	it("handles backend downtime without rejecting the startup promise", async () => {
		const { ctx, control } = setup(vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
		await expect(control("set_origin_policy", { originPolicyMode: "all_public_web" })).resolves.toBe(false);
		expect(ctx.state.connection).toBe("offline");
		expect(ctx.setConnStatus).toHaveBeenCalledWith("Offline", "err");
		expect(ctx.showInlineBanner).toHaveBeenCalled();
		expect(ctx.updateComposerForMode).toHaveBeenCalled();
	});

	it("shows HTTP errors rather than treating a rejected control as success", async () => {
		const { ctx, control } = setup(vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "agent_paused" }) }));
		expect(await control("resume")).toBe(false);
		expect(ctx.showInlineBanner).toHaveBeenCalledWith("agent_paused");
		expect(ctx.refreshStatus).not.toHaveBeenCalled();
	});

	it("refreshes status after a successful control request", async () => {
		const { ctx, control } = setup(vi.fn().mockResolvedValue({ ok: true }));
		expect(await control("resume")).toBe(true);
		expect(ctx.refreshStatus).toHaveBeenCalledOnce();
	});
});
