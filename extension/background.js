const ELIGIBLE = (url) => typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));

let lastSynced = { windowId: null, url: null, at: 0 };

async function enableSidePanelForTab(tabId) {
	try {
		await chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
	} catch {
		/* ignore */
	}
}

async function enableSidePanelGlobally() {
	try {
		await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
		await chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true });
	} catch {
		/* ignore */
	}
}

chrome.runtime.onInstalled.addListener(() => {
	enableSidePanelGlobally();
});

enableSidePanelGlobally();

async function getAgentWindowId() {
	const { agentWindowId } = await chrome.storage.local.get("agentWindowId");
	return agentWindowId ?? null;
}

async function nextBindingRevision() {
	const stored = await chrome.storage.local.get("bindingRevision");
	const rev = (stored.bindingRevision ?? 0) + 1;
	await chrome.storage.local.set({ bindingRevision: rev });
	return rev;
}

async function getBackendConfig() {
	const { baseUrl, token, bindingMode, agentEnabled } = await chrome.storage.local.get([
		"baseUrl",
		"token",
		"bindingMode",
		"agentEnabled",
	]);
	return { baseUrl, token, bindingMode: bindingMode ?? "follow_active", agentEnabled: agentEnabled !== false };
}

async function postControl(body) {
	const { baseUrl, token } = await getBackendConfig();
	if (!baseUrl || !token) return null;
	try {
		const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/control`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-USBA-Token": token },
			body: JSON.stringify(body),
		});
		return res.ok ? await res.json() : null;
	} catch {
		return null;
	}
}

async function syncActiveTab(windowId, reason) {
	const mode = (await chrome.storage.local.get("bindingMode")).bindingMode ?? "follow_active";
	if (mode !== "follow_active") return;
	const agentWindowId = await getAgentWindowId();
	if (agentWindowId != null && windowId !== agentWindowId) return;
	const [tab] = await chrome.tabs.query({ active: true, windowId });
	if (!tab || !ELIGIBLE(tab.url)) return;
	const now = Date.now();
	if (
		lastSynced.windowId === windowId &&
		lastSynced.url === tab.url &&
		now - lastSynced.at < 750 &&
		reason !== "manual"
	) {
		return;
	}
	lastSynced = { windowId, url: tab.url, at: now };
	const revision = await nextBindingRevision();
	await postControl({
		action: "select_tab",
		revision,
		url: tab.url,
		title: tab.title ?? "",
		windowId,
	});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (msg.type === "register_agent_window") {
		chrome.storage.local.set({ agentWindowId: msg.windowId }).then(() => {
			sendResponse({ ok: true });
		});
		return true;
	}
	if (msg.type === "sync_active_tab") {
		syncActiveTab(msg.windowId, "manual").then(() => sendResponse({ ok: true }));
		return true;
	}
	return false;
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
	await syncActiveTab(activeInfo.windowId, "activated");
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
	if (windowId === chrome.windows.WINDOW_ID_NONE) return;
	await syncActiveTab(windowId, "focus");
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
	if (tab.url && ELIGIBLE(tab.url)) {
		await enableSidePanelForTab(tabId);
	}
	if (!changeInfo.url && changeInfo.status !== "complete") return;
	if (!tab.windowId || !ELIGIBLE(tab.url)) return;
	const agentWindowId = await getAgentWindowId();
	if (agentWindowId != null && tab.windowId !== agentWindowId) return;
	const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
	if (!active || active.id !== tabId) return;
	await syncActiveTab(tab.windowId, "updated");
});
