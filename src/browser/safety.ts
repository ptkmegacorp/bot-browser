const RISKY_PATTERNS = [
	/\bsubmit\b/i,
	/\bsend\b/i,
	/\bpurchase\b/i,
	/\bbuy\b/i,
	/\bcheckout\b/i,
	/\bplace order\b/i,
	/\bdelete\b/i,
	/\bremove account\b/i,
	/\baccept\b/i,
	/\bagree\b/i,
	/\bconfirm\b/i,
	/\bsign up\b/i,
	/\bregister\b/i,
	/\blog in\b/i,
	/\bsign in\b/i,
	/\bcontinue\b/i,
];

const SENSITIVE_AUTOCOMPLETE = [
	"one-time-code",
	"cc-number",
	"cc-exp",
	"cc-exp-month",
	"cc-exp-year",
	"cc-csc",
	"cc-type",
	"current-password",
	"new-password",
	"username",
];

export interface ControlDescriptor {
	tag: string;
	type: string | null;
	role: string | null;
	inForm: boolean;
	label: string;
	autocomplete?: string | null;
	name?: string | null;
	value?: string;
}

export function isRiskyClickLabel(label: string): boolean {
	const text = label.trim();
	if (!text) return false;
	return RISKY_PATTERNS.some((re) => re.test(text));
}

export function isSensitiveField(type: string | null, autocomplete: string | null, name: string | null): boolean {
	if (isPasswordField(type, autocomplete)) return true;
	const ac = (autocomplete ?? "").toLowerCase();
	if (SENSITIVE_AUTOCOMPLETE.some((token) => ac.includes(token))) return true;
	const fieldName = (name ?? "").toLowerCase();
	if (fieldName.includes("otp") || fieldName.includes("cvv") || fieldName.includes("card")) return true;
	return false;
}

export function isPasswordField(type: string | null, autocomplete: string | null): boolean {
	if (type === "password") return true;
	if (autocomplete?.toLowerCase().includes("password")) return true;
	return false;
}

/** Fail closed on form submit controls and ambiguous consequential clicks. */
export function isConsequentialControl(desc: ControlDescriptor): boolean {
	const tag = desc.tag.toLowerCase();
	const type = (desc.type ?? "").toLowerCase();

	if (tag === "input") {
		if (type === "submit" || type === "image") return true;
		return false;
	}

	if (tag === "button") {
		if (type === "submit") return true;
		if (type === "button") return isRiskyClickLabel(desc.label);
		if (desc.inForm) return true;
		return isRiskyClickLabel(desc.label);
	}

	if (isRiskyClickLabel(desc.label)) return true;
	return false;
}

export function maskFieldValue(
	type: string | null,
	autocomplete: string | null,
	name: string | null,
	value: string,
): string {
	if (!value) return value;
	if (isSensitiveField(type, autocomplete, name)) return "[masked]";
	if (type === "password") return "[masked]";
	return value;
}
