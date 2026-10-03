import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isAppSelectionVerified,
  isAppSelectionVerifiedForIntent,
  readAppSelection,
  recordAppSelection,
} from "../src/conversation/app-selection.js";
import { cleanup, isolateStateDir } from "./helpers.js";

describe("current-message app selection", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = isolateStateDir();
  });

  afterEach(() => cleanup(stateDir));

  it("reuses the existing delivery idempotency identity for successful selection", () => {
    const intent = { taskId: "task-a", iteration: 1, messageId: "message-a" };
    const saved = recordAppSelection({
      workspaceId: "workspace-a",
      targetWorkstream: "a0-chatgpt-surface-compatibility",
      connectorName: "Codex with ChatGPT",
      intent,
      requestedApp: "A0 app",
      selectionMethod: "composer",
      currentMessageAvailable: true,
      invocation: "succeeded",
      workspaceVerified: true,
    });
    expect(readAppSelection("workspace-a", intent)?.messageKey).toBe(saved.messageKey);
    expect(isAppSelectionVerified(saved)).toBe(true);
  });

  it("does not infer current availability from a failed or different message", () => {
    const intent = { taskId: "task-a", iteration: 1, messageId: "message-a" };
    recordAppSelection({
      workspaceId: "workspace-a",
      targetWorkstream: "a0-chatgpt-surface-compatibility",
      connectorName: "Codex with ChatGPT",
      intent,
      requestedApp: "A0 app",
      selectionMethod: "mention",
      currentMessageAvailable: false,
      invocation: "failed",
      workspaceVerified: true,
      failure: "app_unavailable",
    });
    expect(isAppSelectionVerified(readAppSelection("workspace-a", intent))).toBe(false);
    expect(readAppSelection("workspace-a", { ...intent, iteration: 2 })).toBeNull();
  });

  it("requires the same message-key record to move from pending to succeeded", () => {
    const intent = { taskId: "task-pending", iteration: 3, messageId: "message-pending" };
    const common = {
      workspaceId: "workspace-a",
      targetWorkstream: "a0-chatgpt-surface-compatibility",
      connectorName: "Codex with ChatGPT",
      intent,
      requestedApp: "A0 app",
      selectionMethod: "product_equivalent" as const,
    };
    const pending = recordAppSelection({
      ...common,
      currentMessageAvailable: true,
      invocation: "pending",
      workspaceVerified: false,
    });
    expect(isAppSelectionVerifiedForIntent("workspace-a", intent)).toBe(false);
    const succeeded = recordAppSelection({
      ...common,
      currentMessageAvailable: true,
      invocation: "succeeded",
      workspaceVerified: true,
    });
    expect(succeeded.messageKey).toBe(pending.messageKey);
    expect(isAppSelectionVerifiedForIntent("workspace-a", intent)).toBe(true);
  });

  it("rejects a different app from replacing the same delivery identity", () => {
    const intent = { taskId: "task-identity", iteration: 4, messageId: "message-identity" };
    recordAppSelection({
      workspaceId: "workspace-a",
      targetWorkstream: "a0-chatgpt-surface-compatibility",
      connectorName: "Codex with ChatGPT",
      intent,
      requestedApp: "A0 app",
      selectionMethod: "mention",
      currentMessageAvailable: false,
      invocation: "failed",
      workspaceVerified: false,
      failure: "app_unavailable",
    });
    expect(() =>
      recordAppSelection({
        workspaceId: "workspace-a",
        targetWorkstream: "a0-chatgpt-surface-compatibility",
        connectorName: "Codex with ChatGPT",
        intent,
        requestedApp: "different app",
        selectionMethod: "mention",
        currentMessageAvailable: true,
        invocation: "succeeded",
        workspaceVerified: true,
      })
    ).toThrow(/identity mismatch/);
  });
});
