/**
 * Keystone runtime port — capture the failing test's RUNTIME state (stack +
 * locals at the failure line) by re-running the suite/test under a debug adapter
 * with a breakpoint at the failure site. Reuses the in-slice DAP machinery
 * (@/tool/debug `inspectViaDap` + the spawn/TCP ports) — no cross-slice bridge
 * needed (DAP lives under @/tool, unlike LSP).
 *
 * Languages (toolchain.kind dispatch):
 *  - PYTHON (debugpy, stdio): replay `[python,-m,MOD,...]` as a `{module,args}`
 *    launch with a breakpoint at the failure line.
 *  - RUST (lldb-dap, stdio): `cargo test --no-run` builds the test binary; run
 *    it under lldb-dap with a (realpath'd) failure-line breakpoint.
 *  - GO (dlv-dap, TCP): `dlv dap` listens on a socket (first real consumer of
 *    the TCP transport); `{mode:"test"}` launch with a failure-line breakpoint.
 * Other toolchains ⇒ null (degrade). NEVER throws.
 */
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import { CdpClient } from "../debug/cdp-client"
import { inspectViaCdp } from "../debug/cdp-inspect"
import { DapClient, type DapTransport } from "../debug/dap-client"
import { type DapVariable, type FrameScopes, type Inspection, inspectViaDap, type InspectSpec } from "../debug/inspect-driver"
import { defaultDebugAdapterPort, spawnNodeCdpInspector, spawnTcpDebugAdapter } from "../debug/port"
import type { Toolchain } from "../testrun"
import type { FailureEvidence, RuntimeEvidence, RuntimeFrame, RuntimeVar } from "./types"

/** Cap on stack frames surfaced — native/managed runtimes (Rust std, Go
 *  runtime) bury the user frames under dozens of internal ones; the top frames
 *  are what matter. */
const MAX_STACK_FRAMES = 12

/** Scope names treated as "locals" for evidence: a frame's own variables and its
 *  call arguments. Globals/Statics/Registers are excluded as noise. */
const LOCAL_SCOPES = new Set(["locals", "arguments"])

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

/** DAP variable → evidence variable (structurally identical; recurse children). */
const toVar = (v: DapVariable): RuntimeVar => ({
  name: v.name,
  value: v.value,
  ...(v.type !== undefined ? { type: v.type } : {}),
  ...(v.children !== undefined && v.children.length > 0 ? { children: v.children.map(toVar) } : {}),
})

/** A frame's locals = its Locals + Arguments scopes (in order), flattened. */
const frameLocals = (f: FrameScopes): readonly RuntimeVar[] =>
  f.scopes.filter((s) => LOCAL_SCOPES.has(s.scope.toLowerCase())).flatMap((s) => s.vars.map(toVar))

/** Map a stopped {@link Inspection} to {@link RuntimeEvidence} (stack capped).
 *  Headline `locals` = the stop frame's locals; `frames` adds caller frames. */
const toRuntime = (r: Inspection): RuntimeEvidence | null => {
  if (r.outcome !== "stopped") return null
  const frames: RuntimeFrame[] = r.frames.map((f) => ({
    frame: f.frame,
    ...(f.source !== undefined ? { file: f.source } : {}),
    line: f.line,
    locals: frameLocals(f),
  }))
  return {
    stack: r.stack.slice(0, MAX_STACK_FRAMES).map((f) => ({ name: f.name, ...(f.source !== undefined ? { file: f.source } : {}), line: f.line })),
    locals: frames[0]?.locals ?? [],
    ...(frames.length > 0 ? { frames } : {}),
  }
}

/** Run one DAP inspect over the given transport factory and map it. NEVER throws. */
const runInspect = async (
  openTransport: () => Promise<DapTransport>,
  spec: InspectSpec,
  signal?: AbortSignal,
): Promise<RuntimeEvidence | null> => {
  let client: DapClient | undefined
  try {
    client = new DapClient(await openTransport())
    const r = await inspectViaDap(client, spec, { stopTimeoutMs: 20_000, ...(signal !== undefined ? { signal } : {}) })
    return toRuntime(r)
  } catch {
    return null
  } finally {
    client?.dispose()
  }
}

const absOf = (file: string, cwd: string): string => (isAbsolute(file) ? file : join(cwd, file))

// ── PYTHON (debugpy, stdio) ──────────────────────────────────────────────────
const hasDebugpy = (): boolean => ok("python3", "-c", "import debugpy")

const debugpyLaunch = (command: readonly string[], cwd: string): Record<string, unknown> | null => {
  const mIdx = command.indexOf("-m")
  if (mIdx === -1 || command[mIdx + 1] === undefined) return null
  return { request: "launch", type: "python", module: command[mIdx + 1], args: command.slice(mIdx + 2), cwd, console: "internalConsole", python: ["python3"] }
}

const pythonRuntime = (f: FailureEvidence, tc: Toolchain, cwd: string, signal?: AbortSignal): Promise<RuntimeEvidence | null> => {
  if (!hasDebugpy()) return Promise.resolve(null)
  const launch = debugpyLaunch(tc.command, cwd)
  if (launch === null) return Promise.resolve(null)
  return runInspect(
    () => defaultDebugAdapterPort.spawn({ command: ["python3", "-m", "debugpy.adapter"], cwd }),
    { adapterID: "python", launch, breakpoints: [{ file: absOf(f.file!, cwd), line: f.line! }] },
    signal,
  )
}

// ── RUST (lldb-dap, stdio) ───────────────────────────────────────────────────
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
        if (o.reason === "compiler-artifact" && o.profile?.test === true && typeof o.executable === "string") exe = o.executable
      } catch {
        /* non-JSON noise */
      }
    }
    return exe
  } catch {
    return null
  }
}

const rustRuntime = async (f: FailureEvidence, cwd: string, signal?: AbortSignal): Promise<RuntimeEvidence | null> => {
  const lldb = resolveLldbDap()
  if (lldb === null) return null
  const exe = await cargoTestBinary(cwd, signal)
  if (exe === null) return null
  const realFile = realpathOr(absOf(f.file!, cwd)) // cargo DWARF comp_dir is canonical
  return runInspect(
    () => defaultDebugAdapterPort.spawn({ command: [...lldb], cwd }),
    { adapterID: "lldb", launch: { program: exe }, breakpoints: [{ file: realFile, line: f.line! }] },
    signal,
  )
}

// ── GO (dlv-dap, TCP — first real TCP-transport consumer) ────────────────────
const resolveDlv = (): string | null => {
  if (ok("dlv", "version")) return "dlv"
  // homedir() (not process.env.HOME) — keeps the env-read ban intact and is
  // correct on platforms that set USERPROFILE instead of HOME.
  const home = homedir()
  if (home.length > 0 && ok(`${home}/go/bin/dlv`, "version")) return `${home}/go/bin/dlv`
  return null
}

const goRuntime = (f: FailureEvidence, cwd: string, signal?: AbortSignal): Promise<RuntimeEvidence | null> => {
  const dlv = resolveDlv()
  if (dlv === null) return Promise.resolve(null)
  return runInspect(
    () =>
      spawnTcpDebugAdapter({
        command: (port) => [dlv, "dap", "--listen", `127.0.0.1:${port}`],
        cwd,
        connectTimeoutMs: 8_000,
      }),
    // dlv `mode:"test"` runs `go test` in `program` (the package dir); the
    // breakpoint at the failure line stops inside the failing test.
    { adapterID: "go", launch: { request: "launch", mode: "test", program: cwd }, breakpoints: [{ file: realpathOr(absOf(f.file!, cwd)), line: f.line! }] },
    signal,
  )
}

// ── NODE / JS (CDP over WebSocket — node --inspect-brk, single-process) ───────
const resolveNode = (): string | null => (ok("node", "--version") ? "node" : null)

const nodeRuntime = async (f: FailureEvidence, cwd: string, signal?: AbortSignal): Promise<RuntimeEvidence | null> => {
  const node = resolveNode()
  if (node === null) return null
  // Run the failing FILE directly (node:test files self-run inline → ONE
  // process, so CDP attaches to the test process — `--test` would fork a child
  // per file and we'd attach to the runner instead). node 23.6+ strips types, so
  // simple .ts runs too; runner-specific (jest/vitest) entrypoints are future work.
  const realFile = realpathOr(absOf(f.file!, cwd))
  let client: CdpClient | undefined
  try {
    const transport = await spawnNodeCdpInspector({
      command: (port) => [node, `--inspect-brk=${port}`, realFile],
      cwd,
      connectTimeoutMs: 8_000,
    })
    client = new CdpClient(transport)
    const r = await inspectViaCdp(client, { url: pathToFileURL(realFile).href, line: f.line! }, { stopTimeoutMs: 20_000, ...(signal !== undefined ? { signal } : {}) })
    return toRuntime(r)
  } catch {
    return null
  } finally {
    client?.dispose()
  }
}

/** The default runtime source for the Evidence Packet Builder. Dispatches by
 *  toolchain; degrades to null for unsupported/unavailable cases. */
export const defaultRuntimePort = async (
  failure: FailureEvidence,
  toolchain: Toolchain,
  cwd: string,
  signal?: AbortSignal,
): Promise<RuntimeEvidence | null> => {
  if (failure.file === undefined || failure.line === undefined) return null
  if (toolchain.kind === "python") return pythonRuntime(failure, toolchain, cwd, signal)
  if (toolchain.kind === "rust") return rustRuntime(failure, cwd, signal)
  if (toolchain.kind === "go") return goRuntime(failure, cwd, signal)
  if (toolchain.kind === "node") return nodeRuntime(failure, cwd, signal)
  return null
}
