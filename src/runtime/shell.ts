import type { Subprocess } from "bun"
import { escalatingKill, withSpawnedChild } from "./guarded-spawn"
import { applyLocalEnv } from "./local-env"
import { withProxyEnv } from "./network-proxy"
import { defaultPpidWalkKiller } from "./process-tree"
import { DEFAULT_ENV_ALLOWLIST, scrubEnv } from "./sandbox"
import { asScrubbedEnv, bunScrubbedSpawner } from "./scrubbed-spawn"
import { buildBaseShellArgv, resolveWinShellMode } from "./shell-argv"
import { getShellSandbox } from "./shell-sandbox-holder"
import type { RunShellEvent, ShellOptions, ShellResult } from "./types"

const DEFAULT_TIMEOUT_MS = 120_000

/** D1 — the whole-tree killer for foreground shells. Module-level singleton:
 *  the adapter is pure (it only reads the process table + signals on each
 *  `signalTree` call, no state), so one instance serves every `runShell`. On
 *  abort/timeout this reaps the `bash → child → grandchild` tree instead of
 *  leaking the grandchildren (legacy single-PID `proc.kill()`). */
const FOREGROUND_TREE_KILLER = defaultPpidWalkKiller()

/**
 * Typed sandbox-application status for a single `runShell` invocation (T08 —
 * May-31 bugbash, audit L8 M2 — degraded-sandbox honesty).
 *
 * The OS-sandbox wrap (`ShellSandboxSlot.wrap` / `perCallWrap`) returns whether
 * the sandbox was ACTUALLY applied or DEGRADED to passthrough — but `runShell`
 * previously discarded that, so an effectively-unsandboxed (degraded) run was
 * indistinguishable to its caller from a fully-sandboxed one. Callers can now
 * observe the honest verdict via {@link ShellOptions.onSandboxStatus}.
 *
 *   - `{ applied: true }`          — at least one wrap layer applied a sandbox
 *                                    AND no layer degraded.
 *   - `{ applied: false, reason }` — no sandbox was active for this spawn
 *                                    (`reason: "no-sandbox-installed"`), OR a
 *                                    requested wrap degraded to passthrough
 *                                    (`reason` = the wrap's opaque
 *                                    `degradeReason`). The reason is a STABLE
 *                                    OPAQUE tag — never a Seatbelt profile body
 *                                    / libsandbox internals (anti-leak).
 *
 * Default-OFF: absent `onSandboxStatus` ⇒ the status is not even computed and
 * the spawn path is byte-identical to the pre-T08 code.
 */
export type ShellSandboxStatus =
  | { readonly applied: true }
  | { readonly applied: false; readonly reason: string }

/** Local structural extension of {@link ShellOptions} carrying the T08
 *  degraded-sandbox observer. Declared here (not in `@/runtime` `types.ts`) so
 *  the wire stays in the single owning file; `runShell` reads it off the
 *  options bag structurally. */
type ShellOptionsWithSandboxStatus = ShellOptions & {
  /** OPTIONAL honesty hook — invoked exactly once, BEFORE spawn, with the
   *  typed {@link ShellSandboxStatus} for this call. Absent ⇒ no status
   *  computed (byte-identical legacy). MUST NOT throw; a throwing observer is
   *  the caller's bug and is not guarded here. */
  onSandboxStatus?: (status: ShellSandboxStatus) => void
}

/** Fold a single wrap layer's `(sandboxApplied, degradeReason?)` outcome into
 *  the running status. First degradation reason wins; a later applied layer
 *  cannot un-degrade an earlier honest degradation. Pure. */
const foldSandboxStatus = (
  prior: ShellSandboxStatus,
  layer: { readonly sandboxApplied: boolean; readonly degradeReason?: string | undefined },
): ShellSandboxStatus => {
  // Once degraded, stay degraded (don't let a no-op later layer claim applied).
  if (!prior.applied) return prior
  if (layer.degradeReason !== undefined) {
    return { applied: false, reason: layer.degradeReason }
  }
  if (layer.sandboxApplied) return { applied: true }
  return prior
}

/** Run a command through the system shell. Captures stdout/stderr, never
 *  throws on non-zero exit (the caller decides what a failure means).
 *
 *  ENV SCRUBBING (ADR-0006, now actually enforced for tool execution): unless
 *  `inheritEnv: true` is passed, the child runs with a SCRUBBED env built by
 *  the shared {@link scrubEnv} (ONE source of truth — the allowlist lives in
 *  src/runtime/sandbox.ts, this module does not duplicate it). That means
 *  only PATH/HOME/LANG/LC_ALL/TZ/TERM (when present in the parent) reach the
 *  child; `*_API_KEY`/`*_TOKEN`/`*_SECRET` and every other parent var are
 *  dropped. All LLM-driven shell tools (bash/grep/localize/test-runner) call
 *  this without `inheritEnv`, so provider keys can no longer leak into a
 *  child process. Default behavior stays functional: PATH/HOME are forwarded
 *  when set, so normal commands (`echo`, `pwd`, `rg`, `bun test`) still run.
 *
 *  PR-5 / ADR-0081 — TYPED OUTPUT EVENTS. When `options.onShellEvent` is
 *  provided, the function emits a closed-union event stream IN ADDITION TO
 *  the accumulator that still produces the final `ShellResult`:
 *    1. exactly one `start` event with pid/command/cwd/startedAt,
 *    2. zero or more `stdout` / `stderr` chunks interleaved arbitrarily
 *       (each carries the per-stream byte `offset` of the chunk's first byte),
 *    3. exactly one terminal event — either `exit` (code/signal/exitedAt) or
 *       `aborted` (reason: user_abort | timeout, abortedAt) — emitted AFTER
 *       both pipes have drained.
 *  Concatenating all `stdout` chunks reproduces the bytes of `result.stdout`
 *  (and the same for stderr) — the streamed path runs through the SAME
 *  accumulator as the legacy buffered path, so a session that supplies an
 *  observer sees identical final output. When the observer is ABSENT, no
 *  events are emitted and the run is byte-identical to the pre-PR-5 path. */
export const runShell = async (
  command: string,
  options: ShellOptions = {},
): Promise<ShellResult> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timedOutFlag = false
  const cwd = options.cwd ?? process.cwd()
  const observer = options.onShellEvent

  // Scrubbed by default; opt OUT only with an explicit `inheritEnv: true`.
  // When inheriting we pass `process.env` explicitly (Bun.spawn snapshots the
  // original env if `env` is omitted and would miss vars set after startup).
  const baseEnv =
    options.inheritEnv === true ? (process.env as Record<string, string | undefined>) : scrubEnv()
  // ADR-0455 — DECLARED local-environment overlay. Compose the selected env's
  // vars / PATH-prepends ON TOP of the scrubbed base, GOVERNED BY the same
  // allowlist that scrubbed it (a declared var whose name is not allowlisted is
  // dropped; `pathPrepend` is prepended to the surviving PATH). Absent / empty
  // selection ⇒ `applyLocalEnv` returns the SAME `baseEnv` reference
  // (byte-identical legacy). Applied BEFORE the proxy injection so an operator
  // proxy still wins for the proxy keys. NOTE: when `inheritEnv:true` the base
  // is the FULL parent env; the allowlist still governs which DECLARED names
  // overlay (the inherit decision is orthogonal to the declared overlay).
  const localEnvBase = applyLocalEnv(baseEnv, options.localEnv, DEFAULT_ENV_ALLOWLIST)
  // ADR-0428 — socket-level egress proxy. When the caller threads a bound proxy
  // address via `options.proxyEnv`, inject `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`
  // so the child's OWN sockets are funneled through the loopback egress proxy,
  // closing the subprocess egress bypass. Absent (or `address` undefined) ⇒
  // `withProxyEnv` returns the SAME `baseEnv` reference — byte-identical legacy.
  // S1 — brand the composed env at the scrubber chokepoint; the spawn below
  // routes through the typed `spawnScrubbed` boundary so an env leak is a tsc
  // error (the `inheritEnv:true` opt-out is still rooted here, explicit).
  const env = asScrubbedEnv(withProxyEnv(localEnvBase, options.proxyEnv ?? {}))

  // S1 — OS sandbox wire-up. Default-OFF: when the CLI surface did not
  // install a slot (via `installShellSandbox`), `getShellSandbox()` returns
  // `undefined` and `argv` is the legacy `["bash","-lc",cmd]` byte-for-byte.
  // When installed, the slot wraps the argv with the active OS backend
  // (`sandbox-exec`, `bwrap`, `landlock-cli`) or an honest degraded
  // passthrough. Policy internals only flow INTO the spawn argv; they are
  // never echoed back to the tool result.
  //
  // ADR-0295 — per-call wrap. When the caller supplies `options.perCallWrap`,
  // it runs FIRST: the per-call wrapper composes the outermost sandbox
  // (typically the bash tool's `mode="read"` Seatbelt read-only profile).
  // The session-wide slot still runs on top of the per-call result so a
  // session policy that further constrains the call still applies. Order:
  //   per-call wrap → slot wrap → snapshot restore.
  // P16 (jun-08 §P16) — platform-aware base shell argv. On every non-win32
  // host the decision is BYTE-IDENTICAL to the legacy `["bash","-lc",command]`
  // hardcode (no env read, no allocation change). On win32 the legacy code
  // would spawn a nonexistent `bash` and fail with an opaque ENOENT; instead we
  // surface an EXPLICIT typed `ShellResult` (exitCode 127 + actionable stderr)
  // unless the operator opted into the cmd.exe fallback via QUANTA_WIN_SHELL=cmd.
  // The env is read ONLY when `process.platform === "win32"` so the common path
  // stays a pure pass-through.
  const argvDecision = buildBaseShellArgv(
    command,
    process.platform,
    process.platform === "win32" ? resolveWinShellMode() : "error",
  )
  if (argvDecision.kind === "error") {
    // No-throw: a clear, deterministic failure result instead of a silent spawn
    // error. Mirrors the os-sandbox no-throw contract (exitCode 127 = "cannot
    // execute"). When an event observer is present we do NOT emit a synthetic
    // `start`/`exit` pair (no process was spawned) — the caller reads the
    // result shape, which is the same contract a non-zero exit carries.
    return { stdout: "", stderr: argvDecision.reason, exitCode: 127, timedOut: false }
  }
  const baseArgv: ReadonlyArray<string> = argvDecision.argv
  const perCallWrap = options.perCallWrap
  // T08 (audit L8 M2) — track whether ANY wrap layer actually sandboxed the
  // spawn vs degraded to passthrough, so an `onSandboxStatus` observer learns
  // the honest verdict. Seed `applied:false/no-sandbox-installed`: with no
  // per-call wrap and no installed slot the spawn is unsandboxed, and that is
  // the truth the caller must be told (not a silent "looks fine").
  const onSandboxStatus = (options as ShellOptionsWithSandboxStatus).onSandboxStatus
  // Seed neutral-applied; flip to degraded if a layer degrades. If NO wrap
  // layer runs at all the spawn is unsandboxed — reported as such below.
  let sandboxStatus: ShellSandboxStatus = { applied: true }
  let anyWrapLayerRan = false

  let perCallArgv: string[]
  if (perCallWrap !== undefined) {
    const wrapped = await perCallWrap(baseArgv, cwd)
    perCallArgv = wrapped.argv
    anyWrapLayerRan = true
    if (onSandboxStatus !== undefined) sandboxStatus = foldSandboxStatus(sandboxStatus, wrapped)
  } else {
    perCallArgv = [...baseArgv]
  }

  const slot = getShellSandbox()
  let sandboxedArgv: string[]
  if (slot !== undefined) {
    const wrapped = await slot.wrap(perCallArgv, cwd)
    sandboxedArgv = wrapped.argv
    anyWrapLayerRan = true
    if (onSandboxStatus !== undefined) sandboxStatus = foldSandboxStatus(sandboxStatus, wrapped)
  } else {
    sandboxedArgv = perCallArgv
  }

  // Emit the honest sandbox verdict exactly once, before spawn. No wrap layer
  // ran ⇒ the spawn is unsandboxed (`no-sandbox-installed`). Anti-leak: every
  // reason is an opaque tag (the wrap's `degradeReason` or the no-sandbox
  // sentinel), never a profile body.
  if (onSandboxStatus !== undefined) {
    onSandboxStatus(
      anyWrapLayerRan ? sandboxStatus : { applied: false, reason: "no-sandbox-installed" },
    )
  }
  // ADR-0204 wire — when a snapshot seam is supplied, restore wraps the argv
  // so the spawned shell sources the captured per-turn env. Absent ⇒
  // `sandboxedArgv` flows through unchanged (byte-identical legacy).
  const snap = options.shellSnapshot
  const argv = snap !== undefined ? snap.restore(snap.handle, sandboxedArgv).argv : sandboxedArgv
  const proc = bunScrubbedSpawner(argv, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  }) as Subprocess<"ignore", "pipe", "pipe">

  // Emit `start` BEFORE we begin draining either pipe so observers see the
  // ordering invariant (start ≺ any stdout/stderr ≺ exit/aborted). The
  // `proc.pid` field is populated synchronously by Bun.spawn.
  if (observer) {
    const startEvent: RunShellEvent = {
      kind: "start",
      pid: proc.pid,
      command,
      cwd,
      startedAt: Date.now(),
    }
    observer(startEvent)
  }

  let abortReason: "user_abort" | "timeout" | null = null
  // SIGTERM→SIGKILL escalation: a child that traps/ignores SIGTERM is force-
  // killed after KILL_GRACE_MS. `disarm` clears the grace timer; we call it in
  // the guard's `cleanup` so it cannot leak past the child's lifetime.
  const { kill, disarm } = escalatingKill(proc, FOREGROUND_TREE_KILLER)
  const onAbort = () => {
    if (abortReason === null) abortReason = "user_abort"
    kill()
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOutFlag = true
    if (abortReason === null) abortReason = "timeout"
    kill()
  }, timeoutMs)

  // Per-stream byte accumulators. We collect chunks as Uint8Array and decode
  // ONCE at the end into UTF-8 strings — that is the SAME decoder
  // (TextDecoder defaulting to utf-8 via `new Response(...).text()`) the
  // legacy path uses. When an observer is present we additionally emit each
  // chunk with its pre-chunk byte offset; when ABSENT we still drain via
  // ReadableStream so the byte-level work is identical, then take the
  // single-call accumulator path — but the legacy code used
  // `new Response(stream).text()` which is the well-trodden hot path, so to
  // preserve byte-identical behavior in the no-observer case we DELEGATE to
  // exactly that path and never touch the reader. The two paths share the
  // same `Bun.spawn` invocation and the same kill/timeout/abort plumbing.
  let stdout: string
  let stderr: string

  if (observer) {
    const stdoutChunks: Uint8Array[] = []
    const stderrChunks: Uint8Array[] = []
    let stdoutOffset = 0
    let stderrOffset = 0

    const drain = async (
      stream: ReadableStream<Uint8Array>,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<void> => {
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) return
          if (value && value.byteLength > 0) onChunk(value)
        }
      } finally {
        reader.releaseLock()
      }
    }

    const stdoutDone = drain(proc.stdout as ReadableStream<Uint8Array>, (chunk) => {
      const event: RunShellEvent = { kind: "stdout", chunk, offset: stdoutOffset }
      stdoutOffset += chunk.byteLength
      stdoutChunks.push(chunk)
      observer(event)
    })
    const stderrDone = drain(proc.stderr as ReadableStream<Uint8Array>, (chunk) => {
      const event: RunShellEvent = { kind: "stderr", chunk, offset: stderrOffset }
      stderrOffset += chunk.byteLength
      stderrChunks.push(chunk)
      observer(event)
    })

    // GUARDED: kill-on-throw + timer/abort-listener teardown live in
    // `withSpawnedChild` (src/runtime/guarded-spawn.ts), not inline here. The
    // body emits the terminal `exit`/`aborted` event on its NORMAL-return path
    // only — a throw skips it, which is the contract (exactly one terminal on
    // normal/abort completion, none on an internal observer-thrown failure;
    // the guard kills the still-running child instead).
    return withSpawnedChild(
      {
        kill,
        timer,
        cleanup: () => {
          disarm()
          options.signal?.removeEventListener("abort", onAbort)
        },
      },
      async () => {
        await Promise.all([stdoutDone, stderrDone])
        const exitCode = await proc.exited
        const decoder = new TextDecoder("utf-8")
        stdout = decoder.decode(concat(stdoutChunks))
        stderr = decoder.decode(concat(stderrChunks))
        // Terminal event: aborted takes precedence (timeout/user_abort) over a
        // plain exit. `proc.exited` resolves with the OS exit code; on a kill
        // it is typically non-zero. Bun does not surface `NodeJS.Signals` on
        // its ShellPromise here, so we report `signal: null` and rely on the
        // `aborted` event to carry the reason.
        if (abortReason !== null) {
          const aborted: RunShellEvent = {
            kind: "aborted",
            reason: abortReason,
            abortedAt: Date.now(),
          }
          observer(aborted)
        } else {
          const exit: RunShellEvent = {
            kind: "exit",
            code: exitCode,
            signal: null,
            exitedAt: Date.now(),
          }
          observer(exit)
        }
        return { stdout, stderr, exitCode, timedOut: timedOutFlag }
      },
    )
  }

  // Legacy buffered path — byte-identical to the pre-PR-5 code. No observer
  // ⇒ no streaming work, no event allocations. Same guard as the observer
  // path (kill-on-throw + timer/listener teardown via `withSpawnedChild`).
  return withSpawnedChild(
    {
      kill,
      timer,
      cleanup: () => {
        disarm()
        options.signal?.removeEventListener("abort", onAbort)
      },
    },
    async () => {
      const [stdoutText, stderrText] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited
      return { stdout: stdoutText, stderr: stderrText, exitCode, timedOut: timedOutFlag }
    },
  )
}

/** Concatenate captured byte chunks into a single buffer for final decoding.
 *  Pulled out so the streamed-observer path reuses one allocation strategy. */
const concat = (chunks: Uint8Array[]): Uint8Array => {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}
