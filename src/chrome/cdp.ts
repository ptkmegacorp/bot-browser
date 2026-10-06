export async function cdpHealthy(cdpBase: string): Promise<boolean> {
	try {
		const res = await fetch(`${cdpBase.replace(/\/$/, "")}/json/version`, {
			signal: AbortSignal.timeout(2000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export interface CdpPageTarget {
	id: string;
	type: string;
	url: string;
	title: string;
}

/** Bring an exact Chrome page target to the foreground (CDP HTTP activate). */
export async function activateCdpTarget(cdpBase: string, targetId: string): Promise<boolean> {
	try {
		const base = cdpBase.replace(/\/$/, "");
		const res = await fetch(`${base}/json/activate/${encodeURIComponent(targetId)}`, {
			signal: AbortSignal.timeout(5000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function listCdpPages(cdpBase: string): Promise<CdpPageTarget[]> {
	const res = await fetch(`${cdpBase.replace(/\/$/, "")}/json/list`, {
		signal: AbortSignal.timeout(5000),
	});
	if (!res.ok) throw new Error("cdp_list_failed");
	const list = (await res.json()) as CdpPageTarget[];
	return list.filter((t) => t.type === "page");
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
