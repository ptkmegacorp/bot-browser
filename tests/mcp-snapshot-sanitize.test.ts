import { describe, expect, it } from "vitest";
import {
	extractReadableTranscript,
	sanitizeMcpSnapshotForPi,
} from "../src/browser/engines/mcp-snapshot.js";

describe("sanitizeMcpSnapshotForPi", () => {
	it("removes Open tabs metadata and masks OTP-like values", () => {
		const raw = `### Open tabs
- 0: [Secret](http://127.0.0.1/form)
### Page
- Page URL: http://127.0.0.1/form
### Snapshot
\`\`\`yaml
- textbox "Secret" [ref=e1]: 654321
\`\`\``;
		const out = sanitizeMcpSnapshotForPi(raw);
		expect(out).not.toContain("### Open tabs");
		expect(out).not.toContain("654321");
	});

	it("extracts transcript text from snapshot yaml", () => {
		const sanitized = `### Page
### Snapshot
\`\`\`yaml
- paragraph [ref=e2]: IMPORTANT_TRANSCRIPT_TEXT
- button "Notes" [ref=e3]
\`\`\``;
		expect(extractReadableTranscript(sanitized)).toContain("IMPORTANT_TRANSCRIPT_TEXT");
	});
});
