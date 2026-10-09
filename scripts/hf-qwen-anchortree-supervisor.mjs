#!/usr/bin/env node
/**
 * Supervisor: Qwen + Anchortree on Agent Chrome performs HF search.
 * Cursor does not navigate or substitute external results.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	cdpEvaluateOnTarget,
	cdpScreenshotPngBase64,
	listPageTargets,
} from "./cdp-target-eval.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join("/tmp", "bot-browser-hf-qwen-anchortree");
const CDP = "http://127.0.0.1:9333";
const BASE = "http://127.0.0.1:9477";
const MODEL = { provider: "saturn", id: "qwen3.8-27b-huihui-swift-gsq-rco-iq2_xs-local" };
const TASK =
	"Navigate to https://huggingface.co, use its model search to search for holo4, and report the matching model names and links.";

mkdirSync(OUT, { recursive: true });

function loadState() {
	return JSON.parse(readFileSync(`${process.env.HOME}/.local/share/bot-browser/state/chrome-runtime.json`, "utf8"));
}

function apiHeaders(token) {
	return {
		"Content-Type": "application/json",
		"X-Bot-Browser-Token": token,
		Origin: "chrome-extension://supervisor-local",
	};
}

async function waitHttp(ms = 45_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1500) });
			return true;
		} catch {
			await new Promise((r) => setTimeout(r, 300));
		}
	}
	return false;
}

/** SSE tool trace; call `stop()` as soon as `/api/chat` returns (do not block on maxMs). */
function startSseToolCollector(token, maxMs = 300_000) {
	const tools = [];
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), maxMs);
	const pump = (async () => {
		try {
			const res = await fetch(`${BASE}/api/events`, {
				headers: apiHeaders(token),
				signal: ac.signal,
			});
			const reader = res.body.getReader();
			const dec = new TextDecoder();
			let buf = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				const parts = buf.split("\n\n");
				buf = parts.pop() ?? "";
				for (const chunk of parts) {
					const line = chunk.split("\n").find((l) => l.startsWith("data: "));
					if (!line) continue;
					try {
						const ev = JSON.parse(line.slice(6));
						if (ev.type === "tool_start" && ev.name) tools.push({ phase: "start", name: ev.name, at: Date.now() });
						if (ev.type === "tool_end" && ev.name) tools.push({ phase: "end", name: ev.name, at: Date.now() });
					} catch {
						/* ignore */
					}
				}
			}
		} catch (e) {
			if (e.name !== "AbortError") tools.push({ phase: "error", message: String(e) });
		} finally {
			clearTimeout(timer);
		}
	})();
	return {
		get tools() {
			return tools;
		},
		stop() {
			ac.abort();
		},
		awaitClosed: pump,
	};
}

async function main() {
	const evidence = {
		executor: "qwen_via_bot_browser_anchortree",
		supervisor: "cursor",
		task: TASK,
		model: MODEL,
		startedAt: new Date().toISOString(),
		toolTrace: [],
		steps: [],
	};

	const state = loadState();
	const token = state.pairingToken;
	let backendProc = null;

	try {
		let backendUp = false;
		try {
			const probe = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(2000) });
			backendUp = probe.status === 401 || probe.ok;
		} catch {
			backendUp = false;
		}
		if (!backendUp) {
			evidence.steps.push("start_backend_anchortree");
			backendProc = spawn("npx", ["tsx", "src/main.ts"], {
				cwd: REPO,
				env: { ...process.env, BOT_BROWSER_BROWSER_ENGINE: "anchortree" },
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
			});
			writeFileSync(join(OUT, "backend.pid"), String(backendProc.pid));
			if (!(await waitHttp())) throw new Error("backend_not_ready");
		} else {
			evidence.steps.push("backend_already_up");
		}

		const statusRes = await fetch(`${BASE}/api/status`, { headers: apiHeaders(token) });
		const status = await statusRes.json();
		evidence.browserEngine = status.browserEngine;
		if (status.browserEngine !== "anchortree") {
			throw new Error(`wrong_engine:${status.browserEngine} — stop backend and rerun with BOT_BROWSER_BROWSER_ENGINE=anchortree`);
		}
		evidence.steps.push("engine_anchortree_confirmed");

		await fetch(`${BASE}/api/control`, {
			method: "POST",
			headers: apiHeaders(token),
			body: JSON.stringify({ action: "approve_origin", origin: "https://huggingface.co" }),
		});
		evidence.steps.push("approve_origin_huggingface");

		const tabsBefore = await listPageTargets(CDP);
		const welcome =
			tabsBefore.find((t) => t.url.includes("/fixtures/welcome")) ?? tabsBefore[0];
		if (!welcome) throw new Error("no_page_tab");

		const attachRes = await fetch(`${BASE}/api/control`, {
			method: "POST",
			headers: apiHeaders(token),
			body: JSON.stringify({ action: "attach_tab", targetId: welcome.id }),
		});
		const attachBody = await attachRes.json();
		if (!attachRes.ok) throw new Error(JSON.stringify(attachBody));
		evidence.attachedTargetId = attachBody.taskTab?.targetId ?? welcome.id;
		evidence.steps.push("attach_task_tab");

		const sse = startSseToolCollector(token, 300_000);
		const chatStarted = Date.now();
		const chatRes = await fetch(`${BASE}/api/chat`, {
			method: "POST",
			headers: apiHeaders(token),
			body: JSON.stringify({ message: TASK, model: MODEL }),
			signal: AbortSignal.timeout(300_000),
		});
		const chatBody = await chatRes.json();
		evidence.chatElapsedMs = Date.now() - chatStarted;
		evidence.chatOk = chatRes.ok;
		evidence.chatRunId = chatBody.runId;
		evidence.assistantReport = String(chatBody.text ?? "");
		if (!chatRes.ok) throw new Error(`chat_failed:${JSON.stringify(chatBody)}`);

		sse.stop();
		await Promise.race([sse.awaitClosed, new Promise((r) => setTimeout(r, 5000))]);
		evidence.toolTrace = sse.tools;
		evidence.steps.push("qwen_chat_complete");

		const tabsAfter = await fetch(`${BASE}/api/tabs`, { headers: apiHeaders(token) }).then((r) => r.json());
		const boundId = tabsAfter.attachedTargetId ?? evidence.attachedTargetId;
		evidence.boundTargetId = boundId;

		const pageUrl = await cdpEvaluateOnTarget(CDP, boundId, "location.href");
		const pageSnippet = await cdpEvaluateOnTarget(
			CDP,
			boundId,
			`(document.body && document.body.innerText) ? document.body.innerText.slice(0, 4000) : ''`,
		);
		evidence.independentDom = {
			url: pageUrl,
			mentionsHolo4: /holo4/i.test(String(pageSnippet)),
			mentionsHuggingface: /huggingface/i.test(String(pageUrl)),
			bodySnippet: String(pageSnippet).slice(0, 1200),
		};

		const shot = await cdpScreenshotPngBase64(CDP, boundId);
		if (shot) writeFileSync(join(OUT, "hf-after-qwen.png"), Buffer.from(shot, "base64"));

		evidence.supervisorVerdict = {
			qwenUsedBrowser:
				evidence.toolTrace.some((t) => t.name && /page_snapshot|browser_|navigate/i.test(t.name)) ||
				evidence.independentDom.mentionsHuggingface,
			domShowsSearchContext:
				evidence.independentDom.mentionsHuggingface && evidence.independentDom.mentionsHolo4,
		};

		evidence.endedAt = new Date().toISOString();
		evidence.ok = true;
		writeFileSync(join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
		console.log("HF_QWEN_ANCHORTREE_OK", OUT);
		console.log(JSON.stringify(evidence, null, 2));
	} finally {
		if (backendProc && process.env.HF_TRIAL_KEEP_BACKEND !== "1") {
			backendProc.kill("SIGTERM");
			evidence.steps?.push("backend_stopped");
		}
	}
}

main().catch((err) => {
	writeFileSync(
		OUT + "/evidence.json",
		JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }, null, 2),
	);
	console.error("HF_QWEN_ANCHORTREE_FAIL", err);
	process.exit(1);
});
