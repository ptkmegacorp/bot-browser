import { expect, it } from "vitest";
import { createAgentHost } from "../src/agent/session.js";
import { BrowserController } from "../src/browser/controller.js";
import { TabBindingStore } from "../src/browser/binding.js";

it("activates exactly browser tools, never coding tools", async () => {
 const host = await createAgentHost(new BrowserController(new TabBindingStore(), 9333));
 try {
  expect(host.session.getActiveToolNames().sort()).toEqual([
   "page_snapshot", "browser_navigate", "browser_click", "browser_fill", "browser_select", "browser_scroll",
  ].sort());
 } finally { await host.dispose(); }
});
