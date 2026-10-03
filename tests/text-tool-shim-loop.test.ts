import { chromium } from "playwright";
import { expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { runTextToolCompatibilityLoop } from "../src/agent/text-tool-shim.js";
import { BrowserController } from "../src/browser/controller.js";
import { TabBindingStore } from "../src/browser/binding.js";
import { loadSyntheticHtml } from "./helpers/test-page.js";

it("snapshot-only output never invents a fill from user text", async () => {
 const browser = await chromium.launch({ headless: true });
 try {
  const page = await browser.newPage();
  await loadSyntheticHtml(page, '<input name="name"><input name="email">');
  const controller = new BrowserController(new TabBindingStore(), 9333);
  controller.forTestingAttachPage(page);
  let text = '<tool_call><function=page_snapshot></function></tool_call>';
  const session = {
   messages: [{role:'user',content:'Fill email with exactly: user@example.invalid'}],
   getLastAssistantText: () => text,
   prompt: async () => { text = 'I only inspected the form.'; },
  } as unknown as AgentSession;
  await runTextToolCompatibilityLoop(session, controller);
  expect(await page.inputValue('[name=name]')).toBe('');
  expect(await page.inputValue('[name=email]')).toBe('');
  await controller.dispose();
 } finally { await browser.close(); }
});

it("executes the model's explicit fill ref and text", async () => {
 const browser = await chromium.launch({headless:true});
 try {
  const page = await browser.newPage();
  await loadSyntheticHtml(page, '<input name="name"><input name="email">');
  const controller = new BrowserController(new TabBindingStore(),9333);
  controller.forTestingAttachPage(page);
  let text = '<tool_call><function=page_snapshot></function></tool_call>';
  let turns = 0;
  const session = {
   getLastAssistantText: () => text,
   prompt: async (result: string) => {
    if (turns++ === 0) {
     const generation = Number(result.match(/"generation":(\d+)/)?.[1]);
     text = JSON.stringify({tool_name:'browser_fill',arguments:{ref:'e2',generation,text:'user@example.invalid'}});
    } else { text = 'Done'; }
   },
  } as unknown as AgentSession;
  await runTextToolCompatibilityLoop(session,controller);
  expect(await page.inputValue('[name=name]')).toBe('');
  expect(await page.inputValue('[name=email]')).toBe('user@example.invalid');
  await controller.dispose();
 } finally { await browser.close(); }
});
