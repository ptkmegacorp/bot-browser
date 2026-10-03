const $ = (id) => document.getElementById(id);

const state = {
	mode: "idle",
	connection: "unknown",
	tabAttached: false,
	chatInFlight: false,
	streamingAssistantEl: null,
	streamingMsgWrap: null,
	streamingText: "",
	currentRunId: null,
	eventAbort: null,
	statusTimer: null,
	userNearBottom: true,
	selectedModel: "",
	pendingMessage: null,
	lastDiag: "",
	agentEnabled: true,
	bindingMode: "follow_active",
	apiVersion: null,
	bindingRevision: 0,
	originPolicyMode: "approved_only",
};

const SCROLL_THRESHOLD = 48;

function escapeHtml(text) {
	return String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Minimal safe markdown: paragraphs, **bold**, `code`, newlines. */
function isToolLeakFragment(text) {
	return /<tool_call|<function=|browser_snapshot|"tool_name"/i.test(text);
}

function renderMarkdownSafe(text) {
	const escaped = escapeHtml(text);
	const withCode = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
	const withBold = withCode.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	const paragraphs = withBold.split(/\n{2,}/).map((p) => p.replace(/\n/g, "<br>"));
	return paragraphs.map((p) => `<p>${p}</p>`).join("");
}

function headers() {
	return {
		"Content-Type": "application/json",
		"X-USBA-Token": $("token").value.trim(),
	};
}

function baseUrl() {
	return $("baseUrl").value.trim().replace(/\/$/, "");
}

function transcriptEl() {
	return $("transcript");
}

function isNearBottom(el) {
	return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
}

function scrollTranscriptToBottom(force = false) {
	const el = transcriptEl();
	if (force || state.userNearBottom) {
		el.scrollTop = el.scrollHeight;
		$("scrollToBottom").hidden = true;
	} else {
		$("scrollToBottom").hidden = false;
	}
}

function appendMessage(role, htmlContent, extraClass = "") {
	const wrap = document.createElement("article");
	wrap.className = `msg ${role} ${extraClass}`.trim();
	const label = document.createElement("div");
	label.className = "msg-label";
	label.textContent = role === "user" ? "You" : role === "assistant" ? "Agent" : "Notice";
	const bubble = document.createElement("div");
	bubble.className = "msg-bubble msg-content";
	if (role === "assistant" || role === "system") {
		bubble.innerHTML = htmlContent;
	} else {
		bubble.textContent = htmlContent;
	}
	wrap.append(label, bubble);
	const pill = $("scrollToBottom");
	transcriptEl().insertBefore(wrap, pill);
	scrollTranscriptToBottom();
	return { wrap, bubble };
}

function addUserMessage(text) {
	appendMessage("user", text);
}

function setWorkingStatus(text) {
	const host = state.streamingMsgWrap;
	if (!host) return;
	let row = host.querySelector(".working-row");
	if (!row) {
		row = document.createElement("div");
		row.className = "working-row";
		row.setAttribute("role", "status");
		const dot = document.createElement("span");
		dot.className = "dot pulse";
		dot.setAttribute("aria-hidden", "true");
		const label = document.createElement("span");
		label.className = "working-text";
		row.append(dot, label);
		host.append(row);
	}
	const label = row.querySelector(".working-text");
	if (label) label.textContent = text;
	row.hidden = false;
}

function clearWorkingStatus() {
	const row = state.streamingMsgWrap?.querySelector(".working-row");
	if (row) row.remove();
}

function beginAssistantStream() {
	state.streamingText = "";
	const { wrap, bubble } = appendMessage("assistant", "");
	state.streamingAssistantEl = bubble;
	state.streamingMsgWrap = wrap;
	setWorkingStatus("Starting…");
	return bubble;
}

function updateAssistantStream(delta) {
	if (!delta || isToolLeakFragment(delta)) return;
	if (!state.streamingAssistantEl) beginAssistantStream();
	state.streamingText += delta;
	state.streamingAssistantEl.innerHTML = renderMarkdownSafe(state.streamingText);
	if (state.streamingText.trim()) clearWorkingStatus();
	scrollTranscriptToBottom();
}

function finalizeAssistantStream(finalText) {
	if (!state.streamingAssistantEl) {
		if (finalText?.trim()) {
			appendMessage("assistant", renderMarkdownSafe(finalText));
		}
		return;
	}
	if (finalText?.trim()) {
		state.streamingText = finalText;
		state.streamingAssistantEl.innerHTML = renderMarkdownSafe(finalText);
	}
	clearWorkingStatus();
	state.streamingAssistantEl = null;
	state.streamingMsgWrap = null;
	state.streamingText = "";
	state.currentRunId = null;
	scrollTranscriptToBottom();
}

function addActivityUnderAssistant(label, detail) {
	const host = state.streamingAssistantEl?.closest(".msg") ?? transcriptEl().querySelector(".msg.assistant:last-of-type");
	if (!host) return;
	const details = document.createElement("details");
	details.className = "activity";
	const summary = document.createElement("summary");
	summary.textContent = label;
	details.append(summary);
	if (detail) {
		const pre = document.createElement("div");
		pre.textContent = detail;
		details.append(pre);
	}
	host.append(details);
	scrollTranscriptToBottom();
}

function showInlineBanner(message, actionLabel, actionFn) {
	const banner = $("inlineBanner");
	banner.hidden = false;
	banner.textContent = "";
	banner.append(document.createTextNode(message));
	if (actionLabel && actionFn) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "secondary-btn";
		btn.textContent = actionLabel;
		btn.addEventListener("click", actionFn);
		banner.append(btn);
	}
}

function hideInlineBanner() {
	$("inlineBanner").hidden = true;
}

function setConnStatus(text, level = "") {
	const el = $("connStatus");
	el.textContent = text;
	el.className = `conn-status ${level}`.trim();
}

function updateContextBar() {
	const bar = $("contextBar");
	const showResume = state.mode === "paused";
	const showHandoff = state.mode === "idle" && state.connection === "connected";
	const showDone = state.mode === "human_handoff";
	bar.hidden = !(showResume || showHandoff || showDone);
	$("resumeBtn").hidden = !showResume;
	$("handoffBtn").hidden = !showHandoff;
	$("handoffDoneBtn").hidden = !showDone;
}

function updateComposerForMode() {
	const running = state.mode === "running" || state.chatInFlight;
	$("stopBtn").hidden = !running;
	$("sendBtn").hidden = running;
	const blocked = !state.agentEnabled || !state.tabAttached || state.connection !== "connected";
	$("sendBtn").disabled = running || blocked;
	$("message").disabled = running;
}

async function loadSettings() {
	const stored = await chrome.storage.local.get([
		"baseUrl",
		"token",
		"selectedModel",
		"agentEnabled",
		"bindingMode",
		"allowAllSites",
	]);
	if (stored.baseUrl) $("baseUrl").value = stored.baseUrl;
	if (stored.token) $("token").value = stored.token;
	if (stored.selectedModel) state.selectedModel = stored.selectedModel;
	if (stored.bindingMode) {
		state.bindingMode = stored.bindingMode;
		$("bindingMode").value = stored.bindingMode;
	}
	if (stored.agentEnabled === false) {
		state.agentEnabled = false;
		updateAgentSwitchUi();
	}
	if (stored.allowAllSites === true) {
		$("allowAllSites").checked = true;
		state.originPolicyMode = "all_public_web";
	}
}

async function saveSettings() {
	const payload = {
		baseUrl: baseUrl(),
		token: $("token").value.trim(),
		selectedModel: $("model").value || state.selectedModel,
	};
	await chrome.storage.local.set({
		...payload,
		agentEnabled: state.agentEnabled,
		bindingMode: state.bindingMode,
		allowAllSites: state.originPolicyMode === "all_public_web",
	});
}

async function nextBindingRevision() {
	const stored = await chrome.storage.local.get("bindingRevision");
	const rev = (stored.bindingRevision ?? 0) + 1;
	await chrome.storage.local.set({ bindingRevision: rev });
	state.bindingRevision = rev;
	return rev;
}

function updateAgentSwitchUi() {
	const btn = $("agentEnabledSwitch");
	const on = state.agentEnabled;
	btn.setAttribute("aria-checked", on ? "true" : "false");
	btn.querySelector(".agent-switch-label").textContent = on ? "Agent on" : "Agent off";
}

async function registerAgentWindow() {
	const win = await chrome.windows.getCurrent();
	await chrome.storage.local.set({ agentWindowId: win.id });
	chrome.runtime.sendMessage({ type: "register_agent_window", windowId: win.id });
}

async function setAgentEnabled(enabled) {
	state.agentEnabled = enabled;
	updateAgentSwitchUi();
	await saveSettings();
	await control("set_agent_enabled", { enabled });
	await refreshStatus();
}

function disconnectEvents() {
	state.eventAbort?.abort();
	state.eventAbort = null;
}

async function connectEvents() {
	disconnectEvents();
	const url = baseUrl();
	const token = $("token").value.trim();
	if (!url || !token) {
		state.connection = "unpaired";
		setConnStatus("Not paired", "warn");
		showInlineBanner("Pairing required — open Settings to connect.", "Open settings", () => openSettings("connection"));
		return;
	}
	const controller = new AbortController();
	state.eventAbort = controller;
	try {
		const res = await fetch(`${url}/api/events`, { headers: headers(), signal: controller.signal });
		if (!res.ok || !res.body) {
			throw new Error("events_failed");
		}
		state.connection = "connected";
		setConnStatus(state.mode === "running" ? "Working" : "Connected", "ok");
		hideInlineBanner();
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split("\n\n");
			buffer = parts.pop() ?? "";
			for (const part of parts) {
				const line = part.split("\n").find((l) => l.startsWith("data: "));
				if (!line) continue;
				try {
					handleEvent(JSON.parse(line.slice(6)));
				} catch {
					/* ignore malformed */
				}
			}
		}
	} catch (err) {
		if (controller.signal.aborted) return;
		state.connection = "offline";
		setConnStatus("Offline", "err");
		showInlineBanner("Backend unreachable — check connection in Settings.", "Open settings", () => openSettings("connection"));
		setTimeout(() => connectEvents(), 4000);
	}
}

function handleEvent(data) {
	if (data.runId && state.currentRunId && data.runId !== state.currentRunId) return;
	switch (data.type) {
		case "run_start":
			state.currentRunId = data.runId ?? state.currentRunId;
			state.mode = "running";
			state.chatInFlight = true;
			if (!state.streamingAssistantEl) beginAssistantStream();
			setWorkingStatus("Agent is working…");
			setConnStatus("Working", "ok");
			updateComposerForMode();
			updateContextBar();
			break;
		case "text_delta":
			updateAssistantStream(data.delta ?? "");
			break;
		case "run_end":
			finalizeAssistantStream(data.text ?? state.streamingText);
			state.chatInFlight = false;
			state.mode = "idle";
			setConnStatus("Connected", "ok");
			updateComposerForMode();
			updateContextBar();
			refreshStatus();
			break;
		case "tool_start":
			setWorkingStatus(data.label ?? "Working…");
			addActivityUnderAssistant(data.label ?? `Activity: ${data.name}`, "");
			break;
		case "tool_end":
			setWorkingStatus("Agent is working…");
			break;
		case "provider_warning":
			appendMessage("system", renderMarkdownSafe(data.message ?? "Provider changed."), "warn");
			break;
		case "site_permission_required":
			clearWorkingStatus();
			state.chatInFlight = false;
			state.mode = "paused";
			showInlineBanner(
				data.message ?? "Site access needed — open Settings → Site permissions.",
				"Open permissions",
				() => openSettings("permissions"),
			);
			updateComposerForMode();
			refreshStatus();
			break;
		case "tab_changed":
			clearWorkingStatus();
			state.chatInFlight = false;
			state.mode = "idle";
			showInlineBanner(data.message ?? "Tab changed — send a new request to continue.");
			updateComposerForMode();
			refreshStatus();
			break;
		case "error":
			clearWorkingStatus();
			appendMessage("error", escapeHtml(data.message ?? "Error"), "error");
			state.chatInFlight = false;
			state.mode = "idle";
			state.currentRunId = null;
			updateComposerForMode();
			break;
		default:
			break;
	}
}

async function refreshStatus() {
	const url = baseUrl();
	if (!url || !$("token").value.trim()) {
		state.connection = "unpaired";
		setConnStatus("Not paired", "warn");
		updateContextBar();
		updateComposerForMode();
		return;
	}
	try {
		const res = await fetch(`${url}/api/status`, { headers: headers() });
		if (!res.ok) {
			if (res.status === 401) {
				state.connection = "unpaired";
				setConnStatus("Auth failed", "err");
				showInlineBanner("Invalid pairing token — update in Settings.", "Open settings", () => openSettings("connection"));
			} else {
				state.connection = "offline";
				setConnStatus("Offline", "err");
			}
			updateContextBar();
			updateComposerForMode();
			return;
		}
		const data = await res.json();
		if (data.apiVersion == null || data.apiVersion < 3 || data.originPolicyMode == null) {
			showInlineBanner(
				"Backend is out of date — rebuild and restart the backend (extension reload alone is not enough).",
				"Open settings",
				() => openSettings("connection"),
			);
		}
		if (data.agentEnabled === false) state.agentEnabled = false;
		else if (data.agentEnabled === true) state.agentEnabled = true;
		if (data.bindingMode) {
			state.bindingMode = data.bindingMode;
			$("bindingMode").value = data.bindingMode;
		}
		if (typeof data.bindingRevision === "number") state.bindingRevision = data.bindingRevision;
		if (data.originPolicyMode) {
			state.originPolicyMode = data.originPolicyMode;
			$("allowAllSites").checked = data.originPolicyMode === "all_public_web";
		}
		state.apiVersion = data.apiVersion ?? null;
		updateAgentSwitchUi();
		updatePermissionUi();
		if (!state.chatInFlight) {
			state.mode = data.mode ?? "idle";
		}
		state.connection = "connected";
		setConnStatus(
			state.mode === "running" ? "Working" : state.mode === "paused" ? "Paused" : state.mode === "human_handoff" ? "Login" : "Connected",
			state.mode === "paused" || state.mode === "human_handoff" ? "warn" : "ok",
		);
		state.tabAttached = data.tabAttached === true;
		populateModels(data.models ?? []);
		updateTabSummary(data.taskTab, state.tabAttached);
		renderOrigins(data.approvedOrigins ?? [], data.originPolicyMode ?? state.originPolicyMode);
		state.lastDiag = `mode ${state.mode} · tab ${state.tabAttached ? "attached" : "none"}`;
		$("connDiag").textContent = `Connected to ${url} · ${state.lastDiag}`;
		hideInlineBanner();
	} catch {
		state.connection = "offline";
		setConnStatus("Offline", "err");
		$("connDiag").textContent = "Could not reach backend.";
	}
	updateContextBar();
	updateComposerForMode();
}

function populateModels(models) {
	const select = $("model");
	if (!Array.isArray(models) || models.length === 0) return;
	const prev = state.selectedModel || select.value;
	select.innerHTML = "";
	for (const m of models) {
		const opt = document.createElement("option");
		opt.value = `${m.provider}::${m.id}`;
		opt.textContent = m.label ?? `${m.provider}/${m.id}`;
		select.appendChild(opt);
	}
	if (prev && [...select.options].some((o) => o.value === prev)) {
		select.value = prev;
	} else if (select.options.length) {
		select.value = select.options[0].value;
	}
	state.selectedModel = select.value;
}

function updateTabSummary(taskTab, attached) {
	const summary = $("tabSummary");
	const quick = $("attachTabQuick");
	if (!attached || !taskTab?.url) {
		$("tabTitle").textContent = "No tab attached";
		$("tabHost").textContent = "";
		summary.title = "";
		quick.hidden = state.connection !== "connected";
		if (!attached && state.connection === "connected") {
			const msg =
				state.bindingMode === "follow_active"
					? "Select an http(s) tab in this Agent window to bind it."
					: "Attach a tab so the agent can view or interact with the page.";
			const action = state.bindingMode === "follow_active" ? null : "Attach a tab";
			showInlineBanner(msg, action, action ? () => openSettings("browser") : undefined);
		}
		quick.hidden = state.bindingMode !== "pin_tab" || state.connection !== "connected";
		return;
	}
	try {
		const u = new URL(taskTab.url);
		$("tabHost").textContent = u.host;
		$("tabTitle").textContent = (taskTab.title || u.pathname || u.host).slice(0, 48);
		summary.title = taskTab.url;
		quick.hidden = true;
		updatePermissionCue();
		if (state.tabAttached) hideInlineBanner();
	} catch {
		$("tabTitle").textContent = "No tab attached";
		quick.hidden = false;
	}
}

function updatePermissionCue() {
	const cue = $("permCue");
	cue.hidden = state.originPolicyMode !== "all_public_web";
}

function updatePermissionUi() {
	const all = state.originPolicyMode === "all_public_web";
	$("allowAllSitesStatus").textContent = all
		? "All sites allowed — public http(s) sites in the selected tab. Local/private hosts still need explicit approval below."
		: "Only explicitly approved sites are allowed.";
	updatePermissionCue();
}

function renderOrigins(origins, policyMode) {
	const mode = policyMode ?? state.originPolicyMode;
	const list = $("originList");
	list.innerHTML = "";
	if (mode === "all_public_web") {
		const li = document.createElement("li");
		li.textContent = "All public sites allowed";
		list.append(li);
	}
	if (!origins.length && mode !== "all_public_web") {
		const li = document.createElement("li");
		li.textContent = "No approved sites yet.";
		list.append(li);
		return;
	}
	for (const o of origins) {
		const li = document.createElement("li");
		li.textContent = mode === "all_public_web" ? `Local/fixture: ${o}` : o;
		list.append(li);
	}
}

async function refreshTabs() {
	const res = await fetch(`${baseUrl()}/api/tabs`, { headers: headers() });
	if (!res.ok) return;
	const data = await res.json();
	const select = $("tabList");
	select.innerHTML = "";
	for (const tab of data.tabs ?? []) {
		const opt = document.createElement("option");
		opt.value = tab.targetId;
		opt.textContent = `${tab.title || tab.url}`.slice(0, 100);
		if (tab.targetId === data.attachedTargetId) opt.selected = true;
		select.appendChild(opt);
	}
}

async function control(action, extra = {}) {
	if (action === "attach_tab" && extra.revision == null) {
		extra.revision = await nextBindingRevision();
	}
	await fetch(`${baseUrl()}/api/control`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({ action, ...extra }),
	});
	await refreshStatus();
}

function openSettings(section) {
	$("settingsPanel").hidden = false;
	$("settingsBackdrop").hidden = false;
	$("settingsBtn").setAttribute("aria-expanded", "true");
	if (section) {
		const el = document.querySelector(`.settings-section[data-section="${section}"]`);
		el?.scrollIntoView({ block: "start" });
	}
	$("settingsClose").focus();
}

function closeSettings() {
	$("settingsPanel").hidden = true;
	$("settingsBackdrop").hidden = true;
	$("settingsBtn").setAttribute("aria-expanded", "false");
	$("settingsBtn").focus();
}

$("settingsBtn").addEventListener("click", () => openSettings());
$("settingsClose").addEventListener("click", () => closeSettings());
$("settingsBackdrop").addEventListener("click", () => closeSettings());

document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !$("settingsPanel").hidden) {
		e.preventDefault();
		closeSettings();
	}
});

transcriptEl().addEventListener("scroll", () => {
	state.userNearBottom = isNearBottom(transcriptEl());
	if (state.userNearBottom) $("scrollToBottom").hidden = true;
});

$("scrollToBottom").addEventListener("click", () => {
	state.userNearBottom = true;
	scrollTranscriptToBottom(true);
});

$("model").addEventListener("change", async () => {
	state.selectedModel = $("model").value;
	await saveSettings();
});

$("saveConnect").addEventListener("click", async () => {
	await saveSettings();
	closeSettings();
	await refreshStatus();
	await connectEvents();
});

$("attachTabQuick").addEventListener("click", async () => {
	openSettings("browser");
	await refreshTabs();
});

$("agentEnabledSwitch").addEventListener("click", async () => {
	await setAgentEnabled(!state.agentEnabled);
});

$("allowAllSites").addEventListener("change", async (e) => {
	const wantAll = e.target.checked;
	if (wantAll) {
		const ok = confirm(
			"The agent may read and interact with any website in the selected tab, including signed-in pages. Only enable this if you trust the task.",
		);
		if (!ok) {
			e.target.checked = false;
			return;
		}
	}
	const mode = wantAll ? "all_public_web" : "approved_only";
	state.originPolicyMode = mode;
	await saveSettings();
	await control("set_origin_policy", { originPolicyMode: mode });
	updatePermissionUi();
	await refreshStatus();
});

$("bindingMode").addEventListener("change", async () => {
	state.bindingMode = $("bindingMode").value;
	await saveSettings();
	await control("set_binding_mode", { mode: state.bindingMode });
	if (state.bindingMode === "follow_active") {
		const win = await chrome.windows.getCurrent();
		chrome.runtime.sendMessage({ type: "sync_active_tab", windowId: win.id });
	}
	await refreshStatus();
});

$("composer").addEventListener("submit", async (e) => {
	e.preventDefault();
	if (state.chatInFlight || state.connection !== "connected") return;
	if (!state.agentEnabled) {
		showInlineBanner("Agent is disabled. Turn the agent on to send requests.");
		return;
	}
	if (!state.tabAttached) {
		const message = $("message").value.trim();
		if (message) state.pendingMessage = message;
		if (state.bindingMode === "follow_active") {
			const win = await chrome.windows.getCurrent();
			chrome.runtime.sendMessage({ type: "sync_active_tab", windowId: win.id });
			showInlineBanner("Select an http(s) tab in this Agent window, then send again.");
		} else {
			showInlineBanner(
				"Attach a tab so the agent can view or interact with the page.",
				"Attach a tab",
				() => openSettings("browser"),
			);
		}
		return;
	}
	const message = $("message").value.trim();
	if (!message) return;
	const draft = message;
	state.pendingMessage = null;
	$("message").value = "";
	state.chatInFlight = true;
	state.currentRunId = null;
	updateComposerForMode();
	addUserMessage(draft);
	beginAssistantStream();
	setWorkingStatus("Starting…");
	const body = { message: draft };
	const modelVal = $("model").value;
	if (modelVal) {
		const [provider, id] = modelVal.split("::");
		body.model = { provider, id };
	}
	try {
		const res = await fetch(`${baseUrl()}/api/chat`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify(body),
		});
		const data = await res.json();
		if (!res.ok) {
			$("message").value = draft;
			clearWorkingStatus();
			const err = data.error ?? "request_failed";
			if (err === "agent_paused") {
				showInlineBanner("Agent is paused — resume or finish login first.", "Resume", () => control("resume"));
			} else if (err === "agent_disabled") {
				state.agentEnabled = false;
				updateAgentSwitchUi();
				showInlineBanner(data.message ?? "Agent is disabled.");
			} else if (err === "origin_not_approved") {
				showInlineBanner(
					data.message ?? "Site access needed — open Settings → Site permissions.",
					"Open permissions",
					() => openSettings("permissions"),
				);
			} else if (err === "no_tab_attached") {
				state.pendingMessage = draft;
				state.tabAttached = false;
				updateTabSummary(null, false);
				showInlineBanner(data.message ?? "Attach a tab so the agent can view or interact with the page.", "Attach a tab", () =>
					openSettings("browser"),
				);
			} else {
				appendMessage("error", escapeHtml(String(data.message ?? err)), "error");
				if (data.message) state.lastDiag = data.message;
			}
		} else {
			if (data.runId) state.currentRunId = data.runId;
			if (data.text && state.streamingAssistantEl) {
				finalizeAssistantStream(data.text);
			}
		}
	} catch {
		$("message").value = draft;
		clearWorkingStatus();
		showInlineBanner("Network error — open Settings to reconnect.", "Open settings", () => openSettings("connection"));
	} finally {
		state.chatInFlight = false;
		await refreshStatus();
		updateComposerForMode();
	}
});

$("message").addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		$("composer").requestSubmit();
	}
});

$("stopBtn").addEventListener("click", async () => {
	clearWorkingStatus();
	state.chatInFlight = false;
	state.mode = "idle";
	await control("pause");
	updateComposerForMode();
});
$("resumeBtn").addEventListener("click", () => control("resume"));
$("handoffBtn").addEventListener("click", () => control("human_handoff"));
$("handoffDoneBtn").addEventListener("click", () => control("human_handoff_done", { confirmedSafe: true }));

$("approveOriginBtn").addEventListener("click", async () => {
	const origin = $("approveOrigin").value.trim();
	if (!origin) return;
	await control("approve_origin", { origin });
	$("approveOrigin").value = "";
	await refreshStatus();
});

$("refreshTabs").addEventListener("click", () => refreshTabs());
$("detachTab").addEventListener("click", () => control("detach_tab"));
$("attachTab").addEventListener("click", async () => {
	const targetId = $("tabList").value;
	if (!targetId) return;
	await control("attach_tab", { targetId });
	await refreshTabs();
	await refreshStatus();
	if (state.pendingMessage && state.tabAttached) {
		$("message").value = state.pendingMessage;
		state.pendingMessage = null;
	}
});

// Exposed for panel E2E helpers.
globalThis.refreshStatus = refreshStatus;
globalThis.control = control;
globalThis.openSettings = openSettings;
globalThis.closeSettings = closeSettings;

loadSettings().then(async () => {
	updateAgentSwitchUi();
	updatePermissionUi();
	await registerAgentWindow();
	if (state.originPolicyMode === "all_public_web") {
		await control("set_origin_policy", { originPolicyMode: "all_public_web" });
	}
	await refreshStatus();
	await connectEvents();
	state.statusTimer = setInterval(refreshStatus, 3000);
});
