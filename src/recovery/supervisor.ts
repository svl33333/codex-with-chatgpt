import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stateSubdir } from "../config/paths.js";
import { readConnectionBinding } from "../connection/identity.js";
import { readRecoveryBinding, validateRecoveryBinding } from "./bindings.js";

export type SupervisorStatus = "installed" | "absent" | "ambiguous_ownership" | "unsupported";

export interface SupervisorResult {
  ok: boolean;
  status: SupervisorStatus;
  taskName: string;
  reason?: string;
}

export interface SupervisorCommandOptions {
  bindingId: string;
  cliPath: string;
  nodePath?: string;
  startupPolicy?: "user_logon" | "manual";
}

export function supervisorTaskName(bindingId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(bindingId)) throw new Error("invalid supervisor binding identifier");
  return `CodexWithChatGPT-P0-2-${bindingId}`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function supervisorLogFile(bindingId: string): string {
  supervisorTaskName(bindingId);
  return path.join(stateSubdir("recovery"), "logs", `${bindingId}.log`);
}

/** Stable non-secret ownership marker for the task definition. */
export function supervisorOwnershipMarker(options: SupervisorCommandOptions): string {
  const action = supervisorTaskAction(options);
  return `p0-2-owner:${createHash("sha256").update(`${options.bindingId}\0${action}`).digest("hex").slice(0, 24)}`;
}

/** Return a task action with only a binding ID and a redacted user-local log. */
export function supervisorTaskAction(options: SupervisorCommandOptions): string {
  const node = options.nodePath ?? process.execPath;
  const cli = path.resolve(options.cliPath);
  const log = supervisorLogFile(options.bindingId);
  const task = `$recoveryLogPath = ${quotePowerShell(log)}; New-Item -ItemType Directory -Force -Path (Split-Path -Parent $recoveryLogPath) | Out-Null; $recoveryOutput = & ${quotePowerShell(node)} ${quotePowerShell(cli)} recover --binding-id ${quotePowerShell(options.bindingId)} --json 2>&1; $recoveryExitCode = $LASTEXITCODE; $recoveryOutput | Out-File -FilePath $recoveryLogPath -Encoding utf8; exit $recoveryExitCode`;
  // Task Scheduler passes the Arguments string directly to powershell.exe;
  // wrapping the whole script in single quotes would make it a PowerShell
  // string expression instead of executable code. EncodedCommand provides a
  // deterministic UTF-16LE payload without nested command-line quoting.
  const encoded = Buffer.from(task, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}`;
}

/** XML keeps ownership, delayed logon, retry, hidden execution, and principal structured. */
export function supervisorTaskXml(options: SupervisorCommandOptions): string {
  const action = supervisorTaskAction(options);
  const marker = supervisorOwnershipMarker(options);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task" version="1.4">
  <RegistrationInfo>
    <Description>${xmlEscape(marker)}</Description>
    <Author>Codex with ChatGPT P0-2</Author>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Delay>PT30S</Delay>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>${xmlEscape(action.slice("powershell.exe ".length))}</Arguments>
      <WorkingDirectory>${xmlEscape(path.dirname(options.cliPath))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

export function supervisorDefinitionFile(bindingId: string): string {
  supervisorTaskName(bindingId);
  return path.join(stateSubdir("recovery"), "supervisor", `${bindingId}.xml`);
}

function writeDefinition(options: SupervisorCommandOptions): string {
  const file = supervisorDefinitionFile(options.bindingId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Task Scheduler expects the XML declaration's UTF-16 encoding to be
  // reflected by a BOM; without it Windows may parse the definition as ANSI.
  fs.writeFileSync(file, `\uFEFF${supervisorTaskXml(options)}`, { encoding: "utf16le", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on Windows
  }
  return file;
}

export function supervisorCreateArgs(options: SupervisorCommandOptions, definitionFile?: string): string[] {
  return [
    "/Create",
    "/TN",
    supervisorTaskName(options.bindingId),
    "/XML",
    definitionFile ?? supervisorDefinitionFile(options.bindingId),
  ];
}

export interface SchedulerRunner {
  (args: string[]): { status: number | null; stdout: string; stderr: string };
}

function defaultRunner(args: string[]): { status: number | null; stdout: string; stderr: string } {
  if (args[0] === "/__QUERY_OWNED__") {
    const taskName = args[1];
    // Enumerate successfully, then distinguish an empty result (confirmed
    // absence) from any scheduler/query failure (fail closed as ambiguous).
    const script = "$ErrorActionPreference='Stop'; try { $tasks = @(Get-ScheduledTask -ErrorAction Stop); $task = $tasks | Where-Object { $_.TaskName -eq $args[0] }; if ($null -eq $task) { exit 2 }; $task | Select-Object -First 1 TaskName,Description,Actions,Triggers,Principal,Settings | ConvertTo-Json -Depth 8; exit 0 } catch { Write-Error $_; exit 3 }";
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, taskName], {
      encoding: "utf8",
      windowsHide: true,
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
  const result = spawnSync("schtasks.exe", args, { encoding: "utf8", windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function structuredProperty(value: unknown, names: string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const name of names) {
    if (name in record) return record[name];
  }
  return undefined;
}

function ownsTask(output: string, options: SupervisorCommandOptions): boolean {
  let task: unknown;
  try {
    task = JSON.parse(output.trim());
  } catch {
    return false;
  }
  const marker = supervisorOwnershipMarker(options);
  if (structuredProperty(task, ["Description", "description"]) !== marker) return false;
  const rawActions = structuredProperty(task, ["Actions", "actions"]);
  const action = Array.isArray(rawActions) ? rawActions[0] : rawActions;
  const execute = structuredProperty(action, ["Execute", "execute", "Command", "command"]);
  const argumentsValue = structuredProperty(action, ["Arguments", "arguments"]);
  const workingDirectory = structuredProperty(action, ["WorkingDirectory", "workingDirectory"]);
  const expectedAction = supervisorTaskAction(options);
  const expectedArguments = expectedAction.slice("powershell.exe ".length);
  const executable = typeof execute === "string" ? path.basename(execute).toLowerCase() : "";
  return (
    executable === "powershell.exe" &&
    argumentsValue === expectedArguments &&
    workingDirectory === path.dirname(path.resolve(options.cliPath))
  );
}

export function installSupervisor(
  options: SupervisorCommandOptions,
  runner: SchedulerRunner = defaultRunner,
): SupervisorResult {
  const taskName = supervisorTaskName(options.bindingId);
  const record = readRecoveryBinding(options.bindingId);
  if (!record) {
    return {
      ok: false,
      status: "ambiguous_ownership",
      taskName,
      reason: "supervisor installation requires an existing validated recovery binding",
    };
  }
  try {
    const validated = validateRecoveryBinding(record, record.canonicalAllowedRoot, readConnectionBinding(options.bindingId));
    if (validated.startupPolicy !== "user_logon") {
      return {
        ok: false,
        status: "ambiguous_ownership",
        taskName,
        reason: "recovery binding startup policy does not authorize user-logon supervision",
      };
    }
  } catch (error) {
    return {
      ok: false,
      status: "ambiguous_ownership",
      taskName,
      reason: error instanceof Error ? error.message : "recovery binding could not be validated",
    };
  }
  if (process.platform !== "win32") return { ok: false, status: "unsupported", taskName, reason: "Task Scheduler is Windows-only" };
  const existing = statusSupervisor(options, runner);
  if (existing.status === "installed") return existing;
  if (existing.status !== "absent") return existing;
  const definition = writeDefinition(options);
  const result = runner(supervisorCreateArgs(options, definition));
  try {
    fs.rmSync(definition, { force: true });
  } catch {
    // definition contains no secret and remains recoverable under user state
  }
  if (result.status === 0) return { ok: true, status: "installed", taskName };
  const afterRace = statusSupervisor(options, runner);
  if (afterRace.status === "installed") return afterRace;
  return { ok: false, status: "ambiguous_ownership", taskName, reason: "Task Scheduler rejected the owned task operation" };
}

export function statusSupervisor(
  optionsOrBindingId: SupervisorCommandOptions | string,
  runner: SchedulerRunner = defaultRunner,
): SupervisorResult {
  const options: SupervisorCommandOptions = typeof optionsOrBindingId === "string"
    ? { bindingId: optionsOrBindingId, cliPath: process.execPath }
    : optionsOrBindingId;
  const taskName = supervisorTaskName(options.bindingId);
  if (process.platform !== "win32") return { ok: false, status: "unsupported", taskName, reason: "Task Scheduler is Windows-only" };
  const result = runner(["/__QUERY_OWNED__", taskName]);
  if (result.status === 2) return { ok: true, status: "absent", taskName };
  if (result.status === 0 && ownsTask(`${result.stdout}\n${result.stderr}`, options)) {
    return { ok: true, status: "installed", taskName };
  }
  return { ok: false, status: "ambiguous_ownership", taskName, reason: "task ownership could not be verified" };
}

export function uninstallSupervisor(
  optionsOrBindingId: SupervisorCommandOptions | string,
  runner: SchedulerRunner = defaultRunner,
): SupervisorResult {
  const options: SupervisorCommandOptions = typeof optionsOrBindingId === "string"
    ? { bindingId: optionsOrBindingId, cliPath: process.execPath }
    : optionsOrBindingId;
  const taskName = supervisorTaskName(options.bindingId);
  if (process.platform !== "win32") return { ok: false, status: "unsupported", taskName, reason: "Task Scheduler is Windows-only" };
  const status = statusSupervisor(options, runner);
  if (status.status === "absent") return status;
  if (status.status !== "installed") return status;
  const result = runner(["/Delete", "/TN", taskName, "/F"]);
  return result.status === 0
    ? { ok: true, status: "absent", taskName }
    : { ok: false, status: "ambiguous_ownership", taskName, reason: "owned task could not be removed" };
}
