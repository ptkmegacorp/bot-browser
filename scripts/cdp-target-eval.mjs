/**
 * Minimal CDP evaluate on one page target — no Playwright, no Anchortree sidecar.
 * Used for visible-trial DOM assertions alongside a single backend CDP owner.
 */
const { WebSocket } = globalThis;

function nextId() {
	let n = 0;
	return () => ++n;
}

async function cdpSend(ws, idGen, method, params = {}, sessionId) {
	const id = idGen();
	const msg = { id, method, params };
	if (sessionId) msg.sessionId = sessionId;
	ws.send(JSON.stringify(msg));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`cdp_timeout:${method}`)), 30_000);
		const onMessage = (ev) => {
			let parsed;
			try {
				const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
				parsed = JSON.parse(raw);
			} catch {
				return;
			}
			if (parsed.id !== id) return;
			clearTimeout(timer);
			ws.removeEventListener("message", onMessage);
			if (parsed.error) reject(new Error(`${method}: ${parsed.error.message}`));
			else resolve(parsed.result);
		};
		ws.addEventListener("message", onMessage);
	});
}

/** @returns {Promise<string | null>} */
export async function cdpEvaluateOnTarget(cdpBase, targetId, expression) {
	const versionRes = await fetch(`${cdpBase.replace(/\/$/, "")}/json/version`);
	const { webSocketDebuggerUrl } = await versionRes.json();
	const ws = new WebSocket(webSocketDebuggerUrl);
	await new Promise((res, rej) => {
		ws.addEventListener("open", res, { once: true });
		ws.addEventListener("error", () => rej(new Error("cdp_ws_open_failed")), { once: true });
	});
	const idGen = nextId();
	await cdpSend(ws, idGen, "Target.setDiscoverTargets", { discover: true });
	const targets = await cdpSend(ws, idGen, "Target.getTargets");
	const page = targets.targetInfos.find((t) => t.targetId === targetId && t.type === "page");
	if (!page) {
		ws.close(1000);
		throw new Error(`target_not_found:${targetId}`);
	}
	const attached = await cdpSend(ws, idGen, "Target.attachToTarget", {
		targetId,
		flatten: true,
	});
	const sessionId = attached.sessionId;
	await cdpSend(ws, idGen, "Runtime.enable", {}, sessionId);
	const result = await cdpSend(
		ws,
		idGen,
		"Runtime.evaluate",
		{ expression, returnByValue: true },
		sessionId,
	);
	ws.close(1000);
	return result?.result?.value ?? null;
}

export async function cdpScreenshotPngBase64(cdpBase, targetId) {
	const versionRes = await fetch(`${cdpBase.replace(/\/$/, "")}/json/version`);
	const { webSocketDebuggerUrl } = await versionRes.json();
	const ws = new WebSocket(webSocketDebuggerUrl);
	await new Promise((res, rej) => {
		ws.addEventListener("open", res, { once: true });
		ws.addEventListener("error", () => rej(new Error("cdp_ws_open_failed")), { once: true });
	});
	const idGen = nextId();
	await cdpSend(ws, idGen, "Target.setDiscoverTargets", { discover: true });
	const attached = await cdpSend(ws, idGen, "Target.attachToTarget", {
		targetId,
		flatten: true,
	});
	const sessionId = attached.sessionId;
	await cdpSend(ws, idGen, "Page.enable", {}, sessionId);
	const shot = await cdpSend(
		ws,
		idGen,
		"Page.captureScreenshot",
		{ format: "png", fromSurface: true },
		sessionId,
	);
	ws.close(1000);
	return shot?.data ?? null;
}

export async function cdpOpenPage(cdpBase, url) {
	const res = await fetch(`${cdpBase.replace(/\/$/, "")}/json/new?${encodeURIComponent(url)}`, {
		method: "PUT",
	});
	if (!res.ok) throw new Error(`cdp_new_failed:${res.status}`);
	return await res.json();
}

export async function cdpCloseTarget(cdpBase, targetId) {
	const res = await fetch(`${cdpBase.replace(/\/$/, "")}/json/close/${encodeURIComponent(targetId)}`);
	return res.ok;
}

export async function listPageTargets(cdpBase) {
	const res = await fetch(`${cdpBase.replace(/\/$/, "")}/json/list`);
	const list = await res.json();
	return list.filter((t) => t.type === "page");
}
