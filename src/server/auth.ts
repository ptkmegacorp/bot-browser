import type { IncomingMessage } from "node:http";

export function parseAuth(
	req: IncomingMessage,
	expectedToken: string,
	expectedExtensionId?: string,
): { ok: true } | { ok: false; reason: string } {
	const origin = req.headers.origin ?? "";
	if (origin) {
		if (!origin.startsWith("chrome-extension://")) {
			return { ok: false, reason: "invalid_origin" };
		}
		if (expectedExtensionId) {
			const want = `chrome-extension://${expectedExtensionId}`;
			if (origin !== want) {
				return { ok: false, reason: "invalid_extension_id" };
			}
		}
	}
	const token = req.headers["x-bot-browser-token"];
	if (!token || token !== expectedToken) {
		return { ok: false, reason: "invalid_token" };
	}
	return { ok: true };
}

export function assertJsonSize(body: string, maxBytes: number): void {
	if (Buffer.byteLength(body, "utf8") > maxBytes) throw new Error("payload_too_large");
}
