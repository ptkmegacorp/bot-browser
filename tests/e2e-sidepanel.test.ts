import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

// Opt-in: uses the already-open unpacked side panel and real configured Qwen endpoint.
// Sends only synthetic fixture content. No session-history injection or test controller binding.
it.skipIf(process.env.USBA_E2E_PANEL !== "1")("real side panel reads and fills only the requested field", async () => {
 const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
 const context = browser.contexts()[0]!;
 const panel = context.pages().find(p => p.url().startsWith('chrome-extension://') && p.url().endsWith('/sidepanel.html'));
 if (!panel) { await browser.close(); throw new Error('Open the unpacked extension side panel first'); }
 let testPage: Awaited<ReturnType<typeof context.newPage>> | undefined;
 let originalTarget: string | null = null;
 const originalModel = await panel.locator('#model').inputValue();
 const marker = `ORBIT-${randomUUID().slice(0,8)}`;
 const email = `panel-${randomUUID().slice(0,8)}@example.invalid`;
 async function chat(message: string) {
  const response = panel!.waitForResponse(r=>r.url().endsWith('/api/chat') && r.request().method()==='POST',{timeout:180_000});
  await panel!.locator('#message').fill(message);
  await panel!.locator('#sendBtn').click();
  const r = await response;
  const body = await r.json();
  expect(r.status(),JSON.stringify(body)).toBe(200);
  await panel!.evaluate(async()=>{ await (globalThis as any).refreshStatus(); });
  return body.text as string;
 }
 try {
  originalTarget = await panel.evaluate(async()=>{
   const base=(document.querySelector('#baseUrl') as HTMLInputElement).value;
   const token=(document.querySelector('#token') as HTMLInputElement).value;
   const s=await (await fetch(base+'/api/status',{headers:{'X-USBA-Token':token}})).json();
   return s.taskTab?.targetId ?? null;
  });
  testPage = await context.newPage();
  await testPage.goto('http://127.0.0.1:9477/fixtures/form.html');
  await testPage.locator('#name').fill(marker);
  const cdp=await context.newCDPSession(testPage);
  const {targetInfo}=await cdp.send('Target.getTargetInfo');await cdp.detach();
  await panel.evaluate(async()=>{ (globalThis as any).openSettings('browser');await (globalThis as any).refreshTabs(); });
  await panel.locator('#tabList').selectOption(targetInfo.targetId);
  await panel.locator('#attachTab').click();
  await panel.evaluate(async()=>{ await (globalThis as any).refreshStatus();(globalThis as any).closeSettings(); });
  await panel.locator('#model').selectOption('saturn::qwen3.8-27b-gsq-rco-iq2_xs-local');
  const text=await chat('Use page_snapshot to inspect the attached synthetic form. Tell me its page title and current name field value. Do not navigate, fill, or submit.');
  expect(text).toContain('Synthetic form');expect(text).toContain(marker);
  await chat(`Fill only the email field with ${email}. Leave the name unchanged. Do not submit or click buttons.`);
  expect(await testPage.locator('#email').inputValue()).toBe(email);
  expect(await testPage.locator('#name').inputValue()).toBe(marker);
  expect(await testPage.locator('#status').isVisible()).toBe(false);
 } finally {
  // Restore user's original selection; never navigate or fill their real page.
  if(originalTarget) {
   await panel.evaluate(async(targetId)=>{ await (globalThis as any).control('attach_tab',{targetId}); },originalTarget);
  } else { await panel.evaluate(async()=>{ await (globalThis as any).control('detach_tab'); }); }
  if(originalModel) await panel.locator('#model').selectOption(originalModel);
  await testPage?.close();
  await browser.close();
 }
},360_000);
