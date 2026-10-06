import readline from "node:readline";
import { createInProcessJanitorDriver } from "./driver.js";
import type { JanitorDriver } from "./driver.js";

interface CompanionRequest {
  id: number;
  operation: string;
  entry?: Parameters<JanitorDriver["prepareExactTarget"]>[0];
  prepared?: Parameters<JanitorDriver["confirmPreparedRemoval"]>[0];
  plan?: Parameters<JanitorDriver["confirmPreparedRemoval"]>[1];
  timeoutMs?: number;
}

function reply(id: number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
}

function failure(id: number, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ id, ok: false, error: reason })}\n`);
}

/** Serve the child-process protocol; stdout is reserved for one JSON response per request. */
export async function runJanitorCompanion(): Promise<void> {
  const driver = await createInProcessJanitorDriver();
  const input = readline.createInterface({ input: process.stdin });
  try {
    for await (const line of input) {
      let request: CompanionRequest;
      try {
        request = JSON.parse(line) as CompanionRequest;
        if (!Number.isSafeInteger(request.id) || typeof request.operation !== "string") throw new Error("invalid request envelope");
      } catch (error) {
        failure(0, `COMPANION_PROTOCOL_ERROR: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      try {
        switch (request.operation) {
          case "probe": reply(request.id, await driver.probeCapability()); break;
          case "await-authentication": reply(request.id, await (driver.awaitHumanAuthentication?.(request.timeoutMs) ?? driver.probeCapability())); break;
          case "account": reply(request.id, await driver.observeAuthenticatedAccount()); break;
          case "list": reply(request.id, await driver.listResources()); break;
          case "prepare": reply(request.id, await driver.prepareExactTarget(request.entry!)); break;
          case "confirm": reply(request.id, await driver.confirmPreparedRemoval(request.prepared!, request.plan!)); break;
          case "close": reply(request.id, { closed: true }); return;
          default: throw new Error(`unknown operation '${request.operation}'`);
        }
      } catch (error) {
        failure(request.id, error);
      }
    }
  } finally {
    input.close();
    await driver.close();
  }
}

if (process.argv.includes("--janitor-companion")) {
  runJanitorCompanion().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
