import { spawn, type ChildProcess } from "node:child_process";
import { startBridge } from "../../src/bridge/server.js";
import type { TunnelProvider } from "../../src/tunnel/provider.js";

const [root, publicUrl, candidate] = process.argv.slice(2);
let child: ChildProcess | undefined;
const tunnel: TunnelProvider = {
  name: "cloudflare-named",
  async start() {
    child = spawn(process.execPath, ["-e", `setInterval(() => { try { process.kill(${process.pid}, 0); } catch { process.exit(0); } }, 100)`],
      { stdio: "ignore", windowsHide: true });
    process.send?.({ tunnelPid: child.pid });
    return publicUrl;
  },
  async stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
  },
  async restart(port) { await this.stop(); return this.start(port); },
  status: () => ({ provider: "cloudflare-named", running: !!child && child.exitCode === null && child.signalCode === null,
    url: child ? publicUrl : null }),
  getPublicUrl: () => child ? publicUrl : null,
  doctor: async () => ({ provider: "cloudflare-named", binaryFound: true, binaryPath: "synthetic", running: !!child, url: publicUrl, problems: [] }),
};
const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel, restartCandidate: candidate === "true" });
process.on("SIGTERM", () => { void bridge.close().then(() => process.exit(0)); });
process.on("message", (message: { shutdown?: boolean }) => {
  if (message.shutdown) void bridge.close().then(() => process.exit(0));
});
process.send?.({ ready: true });
