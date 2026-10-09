import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineErrorCode } from "../engine.js";

export const ANCHORTREE_SIDECAR_PROTOCOL_VERSION = 1;

export interface SidecarError {
	code: EngineErrorCode;
	message?: string;
}

type SidecarResult<T> = { ok: true; data: T } | { ok: false; error: SidecarError };

interface Pending {
	resolve: (value: SidecarResult<unknown>) => void;
	timer: ReturnType<typeof setTimeout>;
}

function defaultSidecarPath(): string {
	const fromEnv = process.env.BOT_BROWSER_ANCHORTREE_SIDECAR?.trim();
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
	const release = join(
		repoRoot,
		"rust",
		"target",
		"release",
		"bot-browser-anchortree-sidecar",
	);
	if (existsSync(release)) return release;
	const debug = join(repoRoot, "rust", "target", "debug", "bot-browser-anchortree-sidecar");
	return debug;
}

export class AnchortreeSidecarClient {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private readonly pending = new Map<string, Pending>();
	private nextId = 0;
	private operationEpoch = 0;
	private readonly sidecarPath: string;
	private readonly requestTimeoutMs: number;

	constructor(options?: { sidecarPath?: string; requestTimeoutMs?: number }) {
		this.sidecarPath = options?.sidecarPath ?? defaultSidecarPath();
		this.requestTimeoutMs = options?.requestTimeoutMs ?? 60_000;
	}

	private ensureProcess(): ChildProcessWithoutNullStreams {
		if (this.proc && !this.proc.killed) return this.proc;
		if (!existsSync(this.sidecarPath)) {
			throw new Error(`anchortree_sidecar_missing:${this.sidecarPath}`);
		}
		const proc = spawn(this.sidecarPath, [], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});
		const rl = createInterface({ input: proc.stdout });
		rl.on("line", (line) => this.onLine(line));
		proc.stderr.on("data", () => {
			/* diagnostics only — never forwarded to model */
		});
		proc.on("exit", () => {
			this.proc = null;
			for (const [id, p] of this.pending) {
				clearTimeout(p.timer);
				p.resolve({ ok: false, error: { code: "target_unavailable", message: "sidecar exited" } });
				this.pending.delete(id);
			}
		});
		this.proc = proc;
		return proc;
	}

	private onLine(line: string): void {
		let parsed: {
			v?: number;
			id?: string;
			ok?: boolean;
			result?: unknown;
			error?: { code?: string; message?: string };
		};
		try {
			parsed = JSON.parse(line) as typeof parsed;
		} catch {
			return;
		}
		const id = parsed.id;
		if (!id) return;
		const pending = this.pending.get(id);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending.delete(id);
		if (parsed.ok) {
			pending.resolve({ ok: true, data: parsed.result });
		} else {
			const code = (parsed.error?.code ?? "timeout") as EngineErrorCode;
			pending.resolve({ ok: false, error: { code, message: parsed.error?.message } });
		}
	}

	private request<T>(method: string, params?: Record<string, unknown>): Promise<SidecarResult<T>> {
		const epoch = this.operationEpoch;
		const proc = this.ensureProcess();
		const id = `r${++this.nextId}`;
		const payload = {
			v: ANCHORTREE_SIDECAR_PROTOCOL_VERSION,
			id,
			method,
			params,
		};
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ ok: false, error: { code: "timeout", message: `${method} timed out` } });
			}, this.requestTimeoutMs);
			this.pending.set(id, {
				resolve: (outcome) => {
					if (epoch !== this.operationEpoch) {
						resolve({ ok: false, error: { code: "operation_cancelled" } });
						return;
					}
					resolve(outcome as SidecarResult<T>);
				},
				timer,
			});
			proc.stdin.write(`${JSON.stringify(payload)}\n`);
		});
	}

	cancel(): void {
		this.operationEpoch += 1;
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.resolve({ ok: false, error: { code: "operation_cancelled" } });
			this.pending.delete(id);
		}
		const proc = this.proc;
		if (proc && !proc.killed) {
			const id = `r${++this.nextId}`;
			try {
				proc.stdin.write(
					`${JSON.stringify({ v: ANCHORTREE_SIDECAR_PROTOCOL_VERSION, id, method: "cancel" })}\n`,
				);
			} catch {
				/* stdin may already be closed */
			}
			proc.kill("SIGTERM");
			this.proc = null;
		}
	}

	async shutdown(): Promise<void> {
		this.operationEpoch += 1;
		if (!this.proc) return;
		try {
			await this.request("shutdown", {});
		} catch {
			/* ignore */
		}
		this.proc.kill();
		this.proc = null;
	}

	call<T>(method: string, params?: Record<string, unknown>): Promise<SidecarResult<T>> {
		return this.request<T>(method, params);
	}
}
