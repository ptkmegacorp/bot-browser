import { chmod, existsSync, mkdir, readFile, readdirSync, readFileSync, writeFile } from "node:fs";
import { mkdir as mkdirAsync, readFile as readFileAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
	APP_NAME,
	cdpUrl,
	chromeExecutable,
	chromeExtensionLaunchArgs,
	chromeProfileDir,
	DEFAULT_CDP_PORT,
	DEFAULT_HTTP_HOST,
	WM_CLASS,
} from "../config.js";
import { cdpHealthy, isPidAlive, listCdpPages } from "./cdp.js";
import { ensureBundledExtensionLoaded } from "./extension-load.js";
import { readChromeState, readOrCreatePairingToken, writeChromeState, type ChromeRuntimeState } from "./state.js";

const FORBIDDEN_FLAGS = ["--headless", "--headless=new", "--headless=old", "--no-sandbox"];

export interface LaunchResult {
	ok: boolean;
	alreadyRunning?: boolean;
	cdpReady: boolean;
	state?: ChromeRuntimeState;
	error?: string;
}

function welcomeUrl(httpPort: number): string {
	return `http://${DEFAULT_HTTP_HOST}:${httpPort}/fixtures/welcome.html`;
}

async function seedFirstRunProfileName(profileDir: string): Promise<void> {
	const localStatePath = join(profileDir, "Local State");
	if (existsSync(localStatePath)) return;
	await mkdirAsync(join(profileDir, "Default"), { recursive: true, mode: 0o700 });
	await writeFileAsync(
		localStatePath,
		JSON.stringify({ profile: { info_cache: { Default: { name: "Agent" } } } }),
		"utf8",
	);
}

async function ensureProfileName(profileDir: string): Promise<void> {
	await seedFirstRunProfileName(profileDir);
	const localStatePath = join(profileDir, "Local State");
	try {
		const raw = await readFileAsync(localStatePath, "utf8");
		const data = JSON.parse(raw) as { profile?: { info_cache?: Record<string, { name?: string }> } };
		const cache = data.profile?.info_cache;
		if (cache?.Default?.name === "Agent") return;
		if (cache?.Default) cache.Default.name = "Agent";
		else {
			data.profile = { info_cache: { Default: { name: "Agent" } } };
		}
		await writeFileAsync(localStatePath, JSON.stringify(data), "utf8");
	} catch {
		// first run — Chrome will create Local State
	}
}

export function buildChromeLaunchArgv(
	executable: string,
	userData: string,
	port: number,
	url: string,
	extra: string[] = [],
): string[] {
	const argv = launchArgv(executable, userData, port, url, extra);
	return argv;
}

function launchArgv(
	executable: string,
	userData: string,
	port: number,
	url: string,
	extra: string[] = [],
): string[] {
	const argv = [
		executable,
		`--user-data-dir=${userData}`,
		`--class=${WM_CLASS}`,
		"--no-first-run",
		"--no-default-browser-check",
		`--remote-debugging-port=${port}`,
		...chromeExtensionLaunchArgs(),
		url,
		...extra,
	];
	const joined = argv.join(" ");
	for (const flag of FORBIDDEN_FLAGS) {
		if (joined.includes(flag)) throw new Error(`forbidden_chrome_flag:${flag}`);
	}
	return argv;
}

function pidsForProfile(userData: string): number[] {
	const proc = "/proc";
	const found: number[] = [];
	try {
		for (const name of readdirSync(proc)) {
			if (!/^\d+$/.test(name)) continue;
			try {
				const cmd = readFileSync(join(proc, name, "cmdline"))
					.toString("utf8")
					.replace(/\0/g, " ");
				if (cmd.includes(userData) && /chrome/i.test(cmd)) found.push(Number(name));
			} catch {
				/* ignore */
			}
		}
	} catch {
		/* ignore */
	}
	return found.sort((a, b) => a - b);
}

async function waitForCdp(port: number, deadlineMs: number): Promise<boolean> {
	const end = Date.now() + deadlineMs;
	while (Date.now() < end) {
		if (await cdpHealthy(cdpUrl(port))) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

async function pickOrCreateTaskTab(
	cdpBase: string,
	existingTargetId: string | undefined,
	welcome: string,
): Promise<{ targetId: string; url: string }> {
	const pages = await listCdpPages(cdpBase);
	if (existingTargetId) {
		const hit = pages.find((p) => p.id === existingTargetId);
		if (hit) return { targetId: hit.id, url: hit.url };
	}
	const welcomeTab = pages.find((p) => p.url.includes("/fixtures/welcome.html"));
	if (welcomeTab) return { targetId: welcomeTab.id, url: welcomeTab.url };
	// open via CDP new target
	const res = await fetch(`${cdpBase.replace(/\/$/, "")}/json/new?${encodeURIComponent(welcome)}`, {
		method: "PUT",
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error("cdp_new_tab_failed");
	const created = (await res.json()) as { id: string; url: string };
	return { targetId: created.id, url: created.url };
}

async function chromeRunningForProfile(profile: string, port: number): Promise<boolean> {
	if (pidsForProfile(profile).length > 0) return true;
	return await cdpHealthy(cdpUrl(port));
}

/** CDP on our port must belong to a process using this profile directory. */
export function cdpOwnedByProfile(profile: string, port: number): boolean {
	if (pidsForProfile(profile).length > 0) return true;
	return false;
}

async function assertCdpOwnership(profile: string, port: number): Promise<void> {
	if (!(await cdpHealthy(cdpUrl(port)))) return;
	if (!cdpOwnedByProfile(profile, port)) {
		throw new Error("cdp_profile_mismatch");
	}
}

export async function ensureAgentChrome(httpPort: number): Promise<LaunchResult> {
	const profile = chromeProfileDir();
	await mkdirAsync(profile, { recursive: true, mode: 0o700 });
	chmod(profile, 0o700, () => {});

	const port = DEFAULT_CDP_PORT;
	const base = cdpUrl(port);
	if (!(await chromeRunningForProfile(profile, port))) {
		await ensureProfileName(profile);
	}
	const pairingToken = await readOrCreatePairingToken();
	const prior = await readChromeState();
	const welcome = welcomeUrl(httpPort);

	if (prior && isPidAlive(prior.pid) && prior.cdpPort === port && (await cdpHealthy(base))) {
		try {
			await assertCdpOwnership(profile, port);
			try {
				await ensureBundledExtensionLoaded(port);
			} catch {
				/* ignore */
			}
			const tab = await pickOrCreateTaskTab(base, prior.taskTargetId, welcome);
			const state: ChromeRuntimeState = {
				...prior,
				taskTargetId: tab.targetId,
				taskUrl: tab.url,
				pairingToken,
				updatedAt: new Date().toISOString(),
			};
			await writeChromeState(state);
			return { ok: true, alreadyRunning: true, cdpReady: true, state };
		} catch {
			/* fall through to relaunch */
		}
	}

	const runningPids = pidsForProfile(profile);
	if (runningPids.length > 0 && (await cdpHealthy(base))) {
		const pid = runningPids[0]!;
		try {
			await assertCdpOwnership(profile, port);
			try {
				await ensureBundledExtensionLoaded(port);
			} catch {
				/* ignore */
			}
			const tab = await pickOrCreateTaskTab(base, prior?.taskTargetId, welcome);
			const state: ChromeRuntimeState = {
				pid,
				cdpPort: port,
				taskTargetId: tab.targetId,
				taskUrl: tab.url,
				pairingToken,
				updatedAt: new Date().toISOString(),
			};
			await writeChromeState(state);
			return { ok: true, alreadyRunning: true, cdpReady: true, state };
		} catch {
			/* continue */
		}
	}

	const exe = chromeExecutable();
	const argv = launchArgv(exe, profile, port, welcome);
	const child = spawn(argv[0]!, argv.slice(1), {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, CHROME_DESKTOP: `${APP_NAME}.desktop` },
	});
	child.unref();

	const cdpReady = await waitForCdp(port, 20_000);
	if (!cdpReady) {
		return { ok: false, cdpReady: false, error: "cdp_not_ready" };
	}

	const extId = await ensureBundledExtensionLoaded(port).catch((err) => {
		console.error("extension_load_failed:", err instanceof Error ? err.message : err);
		return undefined;
	});
	if (extId) console.log(`Extension loaded: ${extId}`);

	const tab = await pickOrCreateTaskTab(base, prior?.taskTargetId, welcome);
	const state: ChromeRuntimeState = {
		pid: child.pid ?? -1,
		cdpPort: port,
		taskTargetId: tab.targetId,
		taskUrl: tab.url,
		pairingToken,
		updatedAt: new Date().toISOString(),
	};
	await writeChromeState(state);
	return { ok: true, alreadyRunning: false, cdpReady: true, state };
}
