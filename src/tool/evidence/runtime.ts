/**
 * Keystone runtime port — capture the failing test's RUNTIME state (stack +
 * locals at the failure line) by re-running the suite/test under a debug adapter
 * with a breakpoint at the failure site. Reuses the in-slice DAP machinery
 * (@/tool/debug `inspectViaDap` + the spawn port) — no cross-slice bridge needed
 * (DAP lives under @/tool, unlike LSP).
 *
 * Languages:
 *  - PYTHON (debugpy): replay the `[python, -m, MOD, ...rest]` test command as a
 *    `{module, args}` launch with a breakpoint at the failure line.
 *  - RUST (lldb-dap): `cargo test --no-run` builds the test binary; run it under
 *    lldb-dap with a breakpoint at the (realpath'd) failure line. cargo's DWARF
 *    comp_dir is canonical, so the source path must be realpath'd to bind.
 * Other toolchains ⇒ null (degrade). NEVER throws.
 */
import { isAbsolute, join } from "node:path"
import { realpathSync } from "node:fs"
import { DapClient } from "../debug/dap-client"
import { type Inspection, inspectViaDap, type InspectSpec } from "../debug/inspect-driver"
import { defaultDebugAdapterPort, type DebugAdapterPort } from "../debug/port"
import type { Toolchain } from "../testrun"
import type { FailureEvidence, RuntimeEvidence } from "./types"

const ok = (bin: string, ...args: string[]): boolean => {
  try {
    return Bun.spawnSync([bin, ...args], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}

const realpathOr = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** Map a stopped {@link Inspection} to {@link RuntimeEvidence}. */
const toRuntime = (r: Inspection): RuntimeEvidence | null => {
  if (r.outcome !== "stopped") return null
  const locals = r.variables.find((s) => s.scope === "Locals")
  return {
    stack: r.stack.map((f) => ({ name: f.name, ...(f.source !== undefined ? { file: f.source } : {}), line: f.line })),
    locals: (locals?.vars ?? []).map((v) => ({ name: v.name, value: v.value })),
  }
}

/** Run one DAP inspect and map the result. NEVER throws. */
const inspect = async (
  adapterCommand: readonly string[],
  cwd: string,
  spec: InspectSpec,
  signal?: AbortSignal,
  port: DebugAdapterPort = defaultDebugAdapterPort,
): Promise<RuntimeEvidence | null> => {
  let client: DapClient | undefined
  try {
    const transport = await port.spawn({ command: [...adapterCommand], cwd })
    client = new DapClient(transport)
    const r = await inspectViaDap(client, spec, { stopTimeoutMs: 20_000, ...(signal !== undefined ? { signal } : {}) })
    return toRuntime(r)
  } catch {
    return null
  } finally {
    client?.dispose()
  }
}

// ── PYTHON (debugpy) ──────────────────────────────────────────────────────
const hasDebugpy = (): boolean => ok("python3", "-c", "import debugpy")

/** Build a debugpy launch from a `[python, -m, MODULE, ...rest]` command. */
const debugpyLaunch = (command: readonly string[], cwd: string): Record<string, unknown> | null => {
  const mIdx = command.indexOf("-m")
  if (mIdx === -1 || command[mIdx + 1] === undefined) return null
  return {
    request: "launch",
    type: "python",
    module: command[mIdx + 1],
    args: command.slice(mIdx + 2),
    cwd,
    console: "internalConsole",
    python: ["python3"],
  }
}

const pythonRuntime = async (
  failure: FailureEvidence,
  tc: Toolchain,
  cwd: string,
  signal?: AbortSignal,
  port?: DebugAdapterPort,
): Promise<RuntimeEvidence | null> => {
  if (!hasDebugpy()) return null
  const launch = debugpyLaunch(tc.command, cwd)
  if (launch === null) return null
  const absFile = isAbsolute(failure.file!) ? failure.file! : join(cwd, failure.file!)
  return inspect(["python3", "-m", "debugpy.adapter"], cwd, { adapterID: "python", launch, breakpoints: [{ file: absFile, line: failure.line! }] }, signal, port)
}

// ── RUST (lldb-dap) ───────────────────────────────────────────────────────
/** Resolve the lldb-dap launcher: PATH first, then macOS `xcrun -f lldb-dap`. */
const resolveLldbDap = (): readonly string[] | null => {
  if (ok("lldb-dap", "--help")) return ["lldb-dap"]
  try {
    const r = Bun.spawnSync(["xcrun", "-f", "lldb-dap"], { stdout: "pipe", stderr: "ignore" })
    const p = r.stdout.toString().trim()
    if (r.exitCode === 0 && p.length > 0) return [p]
  } catch {
    /* not macOS */
  }
  return null
}

/** `cargo test --no-run --message-format=json` → the test executable path. */
const cargoTestBinary = async (cwd: string, signal?: AbortSignal): Promise<string | null> => {
  try {
    const proc = Bun.spawn(["cargo", "test", "--no-run", "--message-format=json"], { cwd, stdout: "pipe", stderr: "ignore", ...(signal !== undefined ? { signal } : {}) })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    let exe: string | null = null
    for (const line of out.split("\n")) {
      const t = line.trim()
      if (t.length === 0) continue
      try {
        const o = JSON.parse(t) as { reason?: string; profile?: { test?: boolean }; executable?: string | null }
        if (o.reason === "compiler-artifact" && o.profile?.test === true && typeof o.executable === "string") {
          exe = o.executable // last test artifact wins (the crate's test binary)
        }
      } catch {
        /* non-JSON noise */
      }
    }
    return exe
  } catch {
    return null
  }
}

const rustRuntime = async (
  failure: FailureEvidence,
  cwd: string,
  signal?: AbortSignal,
  port?: DebugAdapterPort,
): Promise<RuntimeEvidence | null> => {
  const lldb = resolveLldbDap()
  if (lldb === null) return null
  const exe = await cargoTestBinary(cwd, signal)
  if (exe === null) return null
  // cargo's DWARF records the CANONICAL source path; realpath the breakpoint
  // file so it binds (macOS /tmp → /private/tmp).
  const absFile = isAbsolute(failure.file!) ? failure.file! : join(cwd, failure.file!)
  const realFile = realpathOr(absFile)
  return inspect(lldb, cwd, { adapterID: "lldb", launch: { program: exe }, breakpoints: [{ file: realFile, line: failure.line! }] }, signal, port)
}

/** The default runtime source for the Evidence Packet Builder. Dispatches by
 *  toolchain; degrades to null for unsupported/unavailable cases. */
export const defaultRuntimePort = async (
  failure: FailureEvidence,
  toolchain: Toolchain,
  cwd: string,
  signal?: AbortSignal,
  port?: DebugAdapterPort,
): Promise<RuntimeEvidence | null> => {
  if (failure.file === undefined || failure.line === undefined) return null
  if (toolchain.kind === "python") return pythonRuntime(failure, toolchain, cwd, signal, port)
  if (toolchain.kind === "rust") return rustRuntime(failure, cwd, signal, port)
  return null
}
