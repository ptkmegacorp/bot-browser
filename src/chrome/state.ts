import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "../config.js";

export interface ChromeRuntimeState {
	pid: number;
	cdpPort: number;
	taskTargetId: string;
	taskUrl: string;
	pairingToken: string;
	updatedAt: string;
}

const STATE_FILE = () => join(stateDir(), "chrome-runtime.json");

export async function readChromeState(): Promise<ChromeRuntimeState | null> {
	try {
		const raw = await readFile(STATE_FILE(), "utf8");
		const data = JSON.parse(raw) as ChromeRuntimeState;
		if (!data?.pairingToken || !data?.taskTargetId) return null;
		return data;
	} catch {
		return null;
	}
}

export async function writeChromeState(state: ChromeRuntimeState): Promise<void> {
	await mkdir(stateDir(), { recursive: true, mode: 0o700 });
	const path = STATE_FILE();
	await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8");
	await chmod(path, 0o600);
}

export async function readOrCreatePairingToken(): Promise<string> {
	const existing = await readChromeState();
	if (existing?.pairingToken) return existing.pairingToken;
	const { randomBytes } = await import("node:crypto");
	return randomBytes(24).toString("base64url");
}
