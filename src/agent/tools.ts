import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { traceTool } from "../debug-log.js";
import type { BrowserController } from "../browser/controller.js";
import type { ActionVerification } from "../browser/verification.js";

function withVerificationLine(firstLine: string, verification?: ActionVerification): string {
	if (!verification) return firstLine;
	return `${firstLine}\nverification: ${verification.summary}`;
}

const Ref = Type.String({ description: "Element ref from page_snapshot (e.g. e3)" });
const Generation = Type.Number({ description: "Snapshot generation from the page_snapshot that produced this ref" });

export function createBrowserTools(controller: BrowserController): ToolDefinition[] {
	const pageSnapshot = defineTool({
		name: "page_snapshot",
		label: "Page snapshot",
		description:
			"Return interactive elements on the bound task tab. Always call before click/fill/select and pass the returned generation with refs.",
		parameters: Type.Object({}),
		async execute() {
			const snap = await controller.snapshot();
			const lines = snap.nodes.map(
				(n) => `${n.ref} ${n.role} "${n.name}"${n.value ? ` value=${n.value}` : ""}`,
			);
			const transcript = snap.readableText?.trim();
			const text = [
				`url: ${snap.url}`,
				`title: ${snap.title}`,
				`generation: ${snap.generation}`,
				transcript ? `page_text:\n${transcript}` : "",
				`interactive:\n${lines.join("\n")}`,
			]
				.filter(Boolean)
				.join("\n");
			return {
				content: [{ type: "text", text }],
				details: { generation: snap.generation },
			};
		},
	});

	const browserNavigate = defineTool({
		name: "browser_navigate",
		label: "Navigate",
		description: "Navigate the bound task tab to an http(s) URL within approved origin scope.",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http(s) URL" }),
		}),
		async execute(_id, params) {
			const result = await controller.navigate(params.url);
			return {
				content: [
					{ type: "text", text: withVerificationLine(`navigated: ${result.url}`, result.verification) },
				],
				details: result,
			};
		},
	});

	const browserClick = defineTool({
		name: "browser_click",
		label: "Click",
		description:
			"Click by ref and snapshot generation. Form submit and consequential controls are blocked for the human.",
		parameters: Type.Object({ ref: Ref, generation: Generation }),
		async execute(_id, params) {
			const result = await controller.click(params.ref, params.generation);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `blocked: ${result.blocked}` }],
					details: result,
				};
			}
			return {
				content: [{ type: "text", text: withVerificationLine("clicked", result.verification) }],
				details: result,
			};
		},
	});

	const browserFill = defineTool({
		name: "browser_fill",
		label: "Fill field",
		description: "Fill a non-sensitive input by ref and snapshot generation.",
		parameters: Type.Object({
			ref: Ref,
			generation: Generation,
			text: Type.String(),
		}),
		async execute(_id, params) {
			const result = await controller.fill(params.ref, params.generation, params.text);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `blocked: ${result.blocked}` }],
					details: result,
				};
			}
			return {
				content: [{ type: "text", text: withVerificationLine("filled", result.verification) }],
				details: result,
			};
		},
	});

	const browserSelect = defineTool({
		name: "browser_select",
		label: "Select option",
		description: "Select an option on a select element.",
		parameters: Type.Object({
			ref: Ref,
			generation: Generation,
			value: Type.String(),
		}),
		async execute(_id, params) {
			const result = await controller.selectOption(params.ref, params.generation, params.value);
			return {
				content: [{ type: "text", text: withVerificationLine("selected", result.verification) }],
				details: result,
			};
		},
	});

	const browserScroll = defineTool({
		name: "browser_scroll",
		label: "Scroll",
		description: "Scroll the bound task tab up or down.",
		parameters: Type.Object({
			direction: Type.Union([Type.Literal("up"), Type.Literal("down")]),
		}),
		async execute(_id, params) {
			const result = await controller.scroll(params.direction);
			return {
				content: [
					{
						type: "text",
						text: withVerificationLine(`scrolled ${params.direction}`, result.verification),
					},
				],
				details: result,
			};
		},
	});

	const browserScreenshot = defineTool({
		name: "browser_screenshot",
		label: "Screenshot",
		description:
			"Capture a PNG screenshot of the bound task tab. Blocked during pause/login handoff. Use page_snapshot for readable text and refs.",
		parameters: Type.Object({}),
		async execute() {
			const shot = await controller.screenshot();
			return {
				content: [
					{ type: "text", text: "screenshot captured" },
					{ type: "image", data: shot.base64, mimeType: shot.mimeType },
				],
				details: { mimeType: shot.mimeType },
			};
		},
	});

	return [
		pageSnapshot,
		browserNavigate,
		browserClick,
		browserFill,
		browserSelect,
		browserScroll,
		browserScreenshot,
	].map((tool) => {
		const definition = tool as ToolDefinition;
		return {
			...definition,
			execute: (...args: Parameters<ToolDefinition["execute"]>) =>
				traceTool(definition.name, args[1], "sdk", () => controller.getDebugState(), () => definition.execute(...args)),
		};
	});
}
