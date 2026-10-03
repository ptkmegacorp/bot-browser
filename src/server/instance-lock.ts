import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../config.js";

export function acquireInstanceLock(port: number): { release: () => void } {
	const path = join(stateDir(), "backend.lock");
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
