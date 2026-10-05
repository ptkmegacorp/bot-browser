import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../config.js";

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function clearStaleLock(path: string): void {
	try {
		const raw = readFileSync(path, "utf8");
		const data = JSON.parse(raw) as { pid?: number };
		if (typeof data.pid === "number" && !isPidAlive(data.pid)) {
			unlinkSync(path);
		}
	} catch {
		unlinkSync(path);
	}
}

export function acquireInstanceLock(port: number): { release: () => void } {
	mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
	const path = join(stateDir(), "backend.lock");
	if (existsSync(path)) {
		clearStaleLock(path);
	}
	try {
		const fd = openSync(path, "wx");
		writeSync(fd, JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }));
		closeSync(fd);
	} catch {
		throw new Error("backend_already_running");
	}
	return {
		release: () => {
			try {
				unlinkSync(path);
			} catch {
				/* ignore */
			}
		},
	};
}
