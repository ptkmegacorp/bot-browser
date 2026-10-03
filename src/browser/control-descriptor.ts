/** Browser-side descriptor for click safety (runs in page context). */
export function readControlDescriptor(el: Element): {
	tag: string;
	type: string | null;
	role: string | null;
	inForm: boolean;
	label: string;
} {
	const tag = el.tagName.toLowerCase();
	const type = el.getAttribute("type");
	const role = el.getAttribute("role");
	const inForm = hasEffectiveForm(el);
	const label =
		el.getAttribute("aria-label") ||
		(el.textContent ?? "").trim() ||
		el.getAttribute("value") ||
		"";
	return { tag, type, role, inForm, label };
}

export function hasEffectiveForm(el: Element): boolean {
	const htmlEl = el as HTMLElement;
	if ("form" in htmlEl && (htmlEl as HTMLButtonElement | HTMLInputElement).form) return true;
	const formId = el.getAttribute("form");
	if (formId && document.getElementById(formId)) return true;
	return el.closest("form") !== null;
}
