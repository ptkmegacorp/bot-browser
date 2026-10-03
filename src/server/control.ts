import type { AgentControlMode } from "../browser/controller.js";

/** After a chat run ends, only return to idle if we still own the running state. */
export function finishChatRun(currentMode: AgentControlMode): AgentControlMode {
	return currentMode === "running" ? "idle" : currentMode;
}
