#!/usr/bin/env node
/** One-shot supervisor verify — no chat, no waits >5s. */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { cdpEvaluateOnTarget, cdpScreenshotPngBase64 } from "./cdp-target-eval.mjs";

const OUT = "/tmp/bot-browser-hf-qwen-anchortree";
const CDP = "http://127.0.0.1:9333";
const BASE = "http://127.0.0.1:9477";
const token = JSON.parse(
	readFileSync(`${process.env.HOME}/.local/share/bot-browser/state/chrome-runtime.json`, "utf8"),
).pairingToken;

mkdirSync(OUT, { recursive: true });
const status = await fetch(`${BASE}/api/status`, {
	headers: { "X-Bot-Browser-Token": token, Origin: "chrome-extension://snap" },
	signal: AbortSignal.timeout(5000),
}).then((r) => r.json());

const id = status.taskTab?.targetId;
const url = await cdpEvaluateOnTarget(CDP, id, "location.href");
const body = await cdpEvaluateOnTarget(CDP, id, "document.body?.innerText?.slice(0,5000) ?? ''");
const shot = await cdpScreenshotPngBase64(CDP, id);
if (shot) writeFileSync(`${OUT}/hf-snapshot.png`, Buffer.from(shot, "base64"));

const evidence = {
	ok: true,
	snapshotAt: new Date().toISOString(),
	executor: "qwen_via_bot_browser_anchortree",
	browserEngine: status.browserEngine,
	mode: status.mode,
	taskTab: status.taskTab,
	url,
	mentionsHolo4: /holo4/i.test(String(body)),
	bodyPreview: String(body).slice(0, 2000),
};
writeFileSync(`${OUT}/evidence-snapshot.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
