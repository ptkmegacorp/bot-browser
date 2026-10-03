export const NO_TAB_ATTACHED_CODE = "no_tab_attached";
export const AGENT_DISABLED_CODE = "agent_disabled";
export const AGENT_DISABLED_MESSAGE = "Agent is disabled. Turn the agent on to send requests.";

export const NO_TAB_USER_MESSAGE =
	"Attach a tab so the agent can view or interact with the page.";

export const ORIGIN_NOT_APPROVED_CODE = "origin_not_approved";
export const ORIGIN_NOT_APPROVED_MESSAGE =
	"Site access needed — approve this site in Settings or enable Allow all sites.";

const TOOL_CALL_MARKERS = /<tool_call|<function=|browser_snapshot|"tool_name"/i;

export function isRawToolCallLeak(text: string): boolean {
	const t = text.trim();
	if (!t) return false;
	return TOOL_CALL_MARKERS.test(t);
}

export function sanitizeAssistantTextForUser(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return trimmed;
	if (isRawToolCallLeak(trimmed)) {
		return "The agent could not complete a browser action. Check that a tab is attached and try again.";
	}
	return trimmed;
}

export function toolActivityLabel(toolName: string): string {
	switch (toolName) {
		case "page_snapshot":
			return "Reading page…";
		case "browser_navigate":
			return "Navigating…";
		case "browser_fill":
			return "Filling fields…";
		case "browser_click":
			return "Clicking…";
		case "browser_select":
			return "Selecting…";
		case "browser_scroll":
			return "Scrolling…";
		default:
			return "Working…";
	}
}
