export type OriginPolicyMode = "approved_only" | "all_public_web";

export class OriginScope {
	private mode: OriginPolicyMode = "approved_only";
	private allowed = new Set<string>();
	private policyRevision = 0;

	getMode(): OriginPolicyMode {
		return this.mode;
	}

	getPolicyRevision(): number {
		return this.policyRevision;
	}

	setMode(mode: OriginPolicyMode): void {
		this.mode = mode;
		this.policyRevision += 1;
	}

	approve(origin: string): void {
		this.allowed.add(normalizeOrigin(origin));
	}

	has(origin: string): boolean {
		return this.allowed.has(normalizeOrigin(origin));
	}

	list(): string[] {
		return [...this.allowed];
	}

	isOriginPermitted(origin: string): boolean {
		const normalized = normalizeOrigin(origin);
		if (this.mode === "all_public_web") {
			try {
				const host = new URL(normalized).hostname;
				if (isLocalOrPrivateHost(host)) return this.allowed.has(normalized);
				return true;
			} catch {
				return false;
			}
		}
		return this.allowed.has(normalized);
	}

	validateNavigation(url: string): { ok: true; origin: string } | { ok: false; reason: string } {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return { ok: false, reason: "invalid_url" };
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return { ok: false, reason: "unsupported_scheme" };
		}
		const origin = normalizeOrigin(parsed.origin);
		if (!this.isOriginPermitted(origin)) {
			const host = parsed.hostname;
			if (this.mode === "all_public_web" && isLocalOrPrivateHost(host)) {
				return { ok: false, reason: "local_origin_not_approved" };
			}
			return { ok: false, reason: "origin_not_approved" };
		}
		return { ok: true, origin };
	}

	checkRedirect(before: string, after: string): { ok: true } | { ok: false; reason: string } {
		const afterCheck = this.validateNavigation(after);
		if (!afterCheck.ok) return afterCheck;
		try {
			const beforeOrigin = normalizeOrigin(new URL(before).origin);
			const afterOrigin = afterCheck.origin;
			if (beforeOrigin === afterOrigin) return { ok: true };
			if (!this.isOriginPermitted(afterOrigin)) {
				return { ok: false, reason: "unexpected_origin_change" };
			}
		} catch {
			return { ok: false, reason: "invalid_url" };
		}
		return { ok: true };
	}

	revalidateCurrentUrl(url: string): { ok: true } | { ok: false; reason: string } {
		const check = this.validateNavigation(url);
		if (!check.ok) return check;
		return { ok: true };
	}
}

export function isLocalOrPrivateHost(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	if (h === "::1") return true;
	if (/^127\./.test(h)) return true;
	if (/^10\./.test(h)) return true;
	if (/^192\.168\./.test(h)) return true;
	if (/^169\.254\./.test(h)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
	return false;
}

export function normalizeOrigin(origin: string): string {
	return origin.toLowerCase();
}

export function originFromUrl(url: string): string | null {
	try {
		return normalizeOrigin(new URL(url).origin);
	} catch {
		return null;
	}
}
