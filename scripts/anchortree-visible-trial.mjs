#!/usr/bin/env node
/**
 * Bounded visible Agent Chrome trial — Anchortree engine, synthetic fixtures only.
 * No Playwright connectOverCDP (DOM via scripts/cdp-target-eval.mjs).
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	cdpCloseTarget,
	cdpEvaluateOnTarget,
	cdpOpenPage,
	cdpScreenshotPngBase64,
	listPageTargets,
} from "./cdp-target-eval.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join("/tmp", "bot-browser-anchortree-visible-trial");
const CDP = "http://127.0.0.1:9333";
const BASE = "http://127.0.0.1:9477";
const MODEL = { provider: "saturn", id: "qwen3.8-27b-huihui-swift-gsq-rco-iq2_xs-local" };
const FILL_NAME = `VisibleTrial-${Date.now().toString(36)}`;

mkdirSync(OUT, { recursive: true });

function loadState() {
	return JSON.parse(readFileSync(`${process.env.HOME}/.local/share/bot-browser/state/chrome-runtime.json`, "utf8"));
}

async function waitHttp(ms = 30_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			const r = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1000) });
			if (r.status === 401 || r.ok) return true;
		} catch {
			/* retry */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

function apiHeaders(token, extensionId) {
	return {
		"Content-Type": "application/json",
		"X-Bot-Browser-Token": token,
		Origin: extensionId ? `chrome-extension://${extensionId}` : "chrome-extension://trial-local",
	};
}

async function main() {
	const evidence = {
		startedAt: new Date().toISOString(),
		cdp: CDP,
		http: BASE,
		engineEnv: "anchortree",
		model: MODEL,
		steps: [],
		errors: [],
	};

	const preTabs = await listPageTargets(CDP);
	evidence.tabsBefore = preTabs.map((t) => ({ id: t.id, url: t.url }));
	const welcomeTab = preTabs.find((t) => t.url.includes("/fixtures/welcome"));
	if (!welcomeTab) throw new Error("welcome_tab_missing");

	const state = loadState();
	const token = state.pairingToken;

	let backendProc = null;
	const statusProbe = await fetch(`${BASE}/api/status`).catch(() => null);
	if (!statusProbe?.ok && statusProbe?.status !== 401) {
		evidence.steps.push("start_backend_anchortree");
		backendProc = spawn("npx", ["tsx", "src/main.ts"], {
			cwd: REPO,
			env: { ...process.env, BOT_BROWSER_BROWSER_ENGINE: "anchortree" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const logPath = join(OUT, "backend.log");
		const logChunks = [];
		backendProc.stdout.on("data", (d) => logChunks.push(d));
		backendProc.stderr.on("data", (d) => logChunks.push(d));
		backendProc.on("exit", (code) => {
			writeFileSync(logPath, Buffer.concat(logChunks));
		});
		if (!(await waitHttp(45_000))) throw new Error("backend_not_ready");
	} else {
		evidence.steps.push("backend_already_listening");
	}

	const statusRes = await fetch(`${BASE}/api/status`, {
		headers: apiHeaders(token),
	});
	const status = await statusRes.json();
	if (!statusRes.ok) throw new Error(`status: ${JSON.stringify(status)}`);
	evidence.browserEngine = status.browserEngine;
	evidence.taskTabBefore = status.taskTab;
	if (status.browserEngine !== "anchortree") {
		throw new Error(`expected anchortree engine, got ${status.browserEngine}`);
	}
	evidence.steps.push("status_anchortree_ok");

	await fetch(`${BASE}/api/control`, {
		method: "POST",
		headers: apiHeaders(token),
		body: JSON.stringify({ action: "approve_origin", origin: "http://127.0.0.1:9477" }),
	});

	const formUrl = `${BASE}/fixtures/form.html`;
	const created = await cdpOpenPage(CDP, formUrl);
	const formTargetId = created.id;
	evidence.formTargetId = formTargetId;
	evidence.steps.push("open_form_fixture_tab");

	const attachRes = await fetch(`${BASE}/api/control`, {
		method: "POST",
		headers: apiHeaders(token),
		body: JSON.stringify({ action: "attach_tab", targetId: formTargetId }),
	});
	const attachBody = await attachRes.json();
	if (!attachRes.ok) throw new Error(`attach: ${JSON.stringify(attachBody)}`);
	evidence.attach = attachBody;
	evidence.steps.push("attach_form_tab");

	const preShot = await cdpScreenshotPngBase64(CDP, formTargetId);
	if (preShot) writeFileSync(join(OUT, "01-form-before.png"), Buffer.from(preShot, "base64"));

	const chatStarted = Date.now();
	const chatRes = await fetch(`${BASE}/api/chat`, {
		method: "POST",
		headers: apiHeaders(token),
		body: JSON.stringify({
			message: `On the attached form: use page_snapshot once, then browser_fill the name field with exactly "${FILL_NAME}". Do not click Submit application or change the topic.`,
			model: MODEL,
		}),
		signal: AbortSignal.timeout(180_000),
	});
	const chatBody = await chatRes.json();
	evidence.chatElapsedMs = Date.now() - chatStarted;
	evidence.chatOk = chatRes.ok;
	evidence.chatRunId = chatBody.runId;
	evidence.assistantTextPreview = String(chatBody.text ?? "").slice(0, 300);
	if (!chatRes.ok) throw new Error(`chat: ${JSON.stringify(chatBody)}`);
	evidence.steps.push("http_chat_fill");

	const gotName = await cdpEvaluateOnTarget(
		CDP,
		formTargetId,
		`document.querySelector('#name')?.value ?? ''`,
	);
	evidence.domName = gotName;
	if (gotName !== FILL_NAME) throw new Error(`dom_name_mismatch:${gotName}`);

	const postShot = await cdpScreenshotPngBase64(CDP, formTargetId);
	if (postShot) writeFileSync(join(OUT, "02-form-after-fill.png"), Buffer.from(postShot, "base64"));

	const riskyRes = await fetch(`${BASE}/api/chat`, {
		method: "POST",
		headers: apiHeaders(token),
		body: JSON.stringify({
			message:
				"Try to click the Submit application button on the form. If policy blocks you, report that clearly and do not bypass.",
			model: MODEL,
		}),
		signal: AbortSignal.timeout(120_000),
	});
	const riskyBody = await riskyRes.json();
	evidence.riskyChatOk = riskyRes.ok;
	evidence.riskyReplyPreview = String(riskyBody.text ?? "").slice(0, 300);
	const submitted = await cdpEvaluateOnTarget(
		CDP,
		formTargetId,
		`!document.getElementById('status')?.hidden`,
	);
	evidence.formSubmitted = submitted;
	evidence.steps.push("risky_submit_not_fired");

	const markerUrl = `${BASE}/fixtures/welcome.html#trial-marker-${Date.now()}`;
	const markerTab = await cdpOpenPage(CDP, markerUrl);
	evidence.steps.push("open_marker_tab");
	const switchRes = await fetch(`${BASE}/api/control`, {
		method: "POST",
		headers: apiHeaders(token),
		body: JSON.stringify({ action: "attach_tab", targetId: markerTab.id }),
	});
	if (!switchRes.ok) throw new Error(`switch_attach: ${await switchRes.text()}`);
	const tabsRes = await fetch(`${BASE}/api/tabs`, { headers: apiHeaders(token) });
	evidence.tabsAfterSwitch = await tabsRes.json();
	evidence.steps.push("tab_switch_attach");

	await fetch(`${BASE}/api/control`, {
		method: "POST",
		headers: apiHeaders(token),
		body: JSON.stringify({ action: "attach_tab", targetId: welcomeTab.id }),
	});

	await cdpCloseTarget(CDP, formTargetId);
	evidence.steps.push("close_form_tab");
	const postClose = await listPageTargets(CDP);
	evidence.tabsAfterClose = postClose.map((t) => ({ id: t.id, url: t.url }));
	const welcomeStill = postClose.some((t) => t.id === welcomeTab.id);
	if (!welcomeStill) throw new Error("welcome_tab_lost");

	evidence.panelHttpPath = "skipped_no_extension_id";
	const extId = process.env.BOT_BROWSER_EXTENSION_ID?.trim();
	if (extId) {
		const panelStatus = await fetch(`${BASE}/api/status`, { headers: apiHeaders(token, extId) });
		evidence.panelStatusOk = panelStatus.ok;
		evidence.panelHttpPath = panelStatus.ok ? "extension_origin_status_ok" : `status_${panelStatus.status}`;
	}

	evidence.endedAt = new Date().toISOString();
	evidence.ok = true;
	writeFileSync(join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
	console.log("ANCHORTREE_VISIBLE_TRIAL_OK", OUT);
	console.log(JSON.stringify(evidence, null, 2));

	if (backendProc) {
		backendProc.kill("SIGTERM");
		evidence.steps.push("stopped_trial_backend");
	}
}

main().catch((err) => {
	const fail = { ok: false, error: err instanceof Error ? err.message : String(err) };
	writeFileSync(join(OUT, "evidence.json"), JSON.stringify(fail, null, 2) + "\n");
	console.error("ANCHORTREE_VISIBLE_TRIAL_FAIL", fail);
	process.exit(1);
});
