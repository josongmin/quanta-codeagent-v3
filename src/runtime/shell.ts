import type { Subprocess } from "bun"
import { type BoundedBuffer, createBoundedBuffer } from "./bounded-buffer"
import { escalatingKill, withSpawnedChild } from "./guarded-spawn"
import { applyLocalEnv } from "./local-env"
import { withProxyEnv } from "./network-proxy"
import { defaultPpidWalkKiller } from "./process-tree"
import { DEFAULT_ENV_ALLOWLIST, SandboxUnavailableError, scrubEnv } from "./sandbox"
import { asScrubbedEnv, bunScrubbedSpawner, type ScrubbedEnv } from "./scrubbed-spawn"
import { buildBaseShellArgv, discoverShells, resolveWinShellMode } from "./shell-argv"
import { getShellSandbox } from "./shell-sandbox-holder"
import type { RunShellEvent, ShellOptions, ShellResult } from "./types"

const DEFAULT_TIMEOUT_MS = 120_000

/** ADR-0296 auto-background — per-detached-shell VERBATIM output budget for the
 *  bounded tail buffer the registry adopts. Mirrors `MAX_BG_BUFFER_BYTES` in
 *  `bash-bg-registry.ts` (itself the foreground `DEFAULT_TOOL_OUTPUT_MAX`,
 *  200 K). Re-declared (named const, no import) to avoid coupling this leaf
 *  module to the registry slice — the value MUST stay in sync. Output captured
 *  BEFORE the detach moment is decoded in full (byte-identical to the legacy
 *  completion result); only the post-detach streaming tail is head+tail
 *  bounded so a `tail -f` background shell cannot OOM the agent. */
const DETACH_TAIL_BUDGET_BYTES = 200_000

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

/** Explicit restrictive CLI profiles are an enforcement contract, not a
 * best-effort preference. The installed slot is the existing wire authority;
 * a missing or partial wrapper must stop before `Bun.spawn` can run an
 * unsandboxed shell. */
const requiresFullSandboxEnforcement = (profile: string): boolean =>
  profile === "read-only" || profile === "workspace-write"

/**
 * Build the argv that will actually be spawned: base shell argv → snapshot
 * restore → per-call wrap → installed sandbox slot, in that order, and emit the
 * honest sandbox verdict exactly once before the spawn.
 *
 * The ORDER is load-bearing and is why this is one phase: the snapshot restore
 * must happen BEFORE sandbox wrapping, because a sandbox adapter prepends its
 * own executable and a later restore could no longer find the `*sh -c` command.
 *
 * Returns a UNION rather than throwing on a bad decision: `buildBaseShellArgv`
 * failing is a deterministic no-throw result (exit 127 = "cannot execute"), and
 * the caller must return it WITHOUT emitting a synthetic start/exit pair — no
 * process was spawned. A profile that requires full enforcement and cannot get
 * it still THROWS `SandboxUnavailableError`, unchanged.
 *
 * Extracted from {@link runShell} (god-function burndown).
 */
const resolveShellArgv = async (
  command: string,
  options: ShellOptions,
  ctx: {
    readonly cwd: string
    readonly winMode: ReturnType<typeof resolveWinShellMode>
    readonly shellProbe: Parameters<typeof buildBaseShellArgv>[3]
  },
): Promise<
  | { readonly kind: "error"; readonly result: ShellResult }
  | { readonly kind: "ok"; readonly argv: readonly string[] }
> => {
  const { cwd, winMode, shellProbe } = ctx
  const argvDecision = buildBaseShellArgv(command, process.platform, winMode, shellProbe)
  if (argvDecision.kind === "error") {
    // No-throw: a clear, deterministic failure result instead of a silent spawn
    // error. Mirrors the os-sandbox no-throw contract (exitCode 127 = "cannot
    // execute"). When an event observer is present we do NOT emit a synthetic
    // `start`/`exit` pair (no process was spawned) — the caller reads the
    // result shape, which is the same contract a non-zero exit carries.
    return {
      kind: "error",
      result: { stdout: "", stderr: argvDecision.reason, exitCode: 127, timedOut: false },
    }
  }
  const baseArgv: ReadonlyArray<string> = argvDecision.argv
  // Restore before sandbox wrapping. Sandbox adapters prepend their own
  // executable, so restoring afterward cannot find the `*sh -c` command.
  const snap = options.shellSnapshot
  const restoredArgv = snap !== undefined ? snap.restore(snap.handle, baseArgv).argv : [...baseArgv]
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
    const wrapped = await perCallWrap(restoredArgv, cwd)
    perCallArgv = wrapped.argv
    anyWrapLayerRan = true
    if (onSandboxStatus !== undefined) sandboxStatus = foldSandboxStatus(sandboxStatus, wrapped)
  } else {
    perCallArgv = restoredArgv
  }

  const slot = getShellSandbox()
  let sandboxedArgv: string[]
  if (slot !== undefined) {
    const wrapped = await slot.wrap(perCallArgv, cwd)
    if (
      requiresFullSandboxEnforcement(slot.policy.profile) &&
      (!wrapped.sandboxApplied || wrapped.degradeReason !== undefined)
    ) {
      throw new SandboxUnavailableError(
        `QUANTA_SANDBOX=${slot.policy.profile} cannot be enforced: ` +
          (wrapped.degradeReason ?? "sandbox wrapper was not applied"),
      )
    }
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
  return { kind: "ok", argv: sandboxedArgv }
}

/**
 * The STREAMING collection path — taken only when an event observer is wired.
 *
 * It shares the same `Bun.spawn` invocation and the same kill/timeout/abort
 * plumbing as the buffered path; the difference is that it drains the pipes
 * incrementally so `output` events can be emitted as the child writes, instead
 * of materialising both streams at exit.
 *
 * `timedOut` is a THUNK, not a boolean: the flag is set by the timeout timer
 * while this function is awaiting the child, so a value captured at call time
 * would always read `false`.
 *
 * Extracted from {@link runShell} (god-function burndown).
 */
const collectStreamed = async (
  proc: Subprocess<"ignore", "pipe", "pipe">,
  observer: NonNullable<ShellOptions["onShellEvent"]>,
  ctx: {
    readonly options: ShellOptions
    readonly kill: () => void
    readonly timer: ReturnType<typeof setTimeout>
    readonly disarm: () => void
    readonly onAbort: () => void
    readonly timedOut: () => boolean
    /** A THUNK for the same reason as `timedOut`: the abort listener and the
     *  timeout timer both set it while this function is awaiting the child. */
    readonly abortReason: () => "user_abort" | "timeout" | null
  },
): Promise<ShellResult> => {
  const { options, kill, disarm, onAbort, timedOut } = ctx
  const timer = ctx.timer
  let stdout: string
  let stderr: string

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
      // Read LATE, never at entry: the abort listener and the timeout timer set
      // it while this function is awaiting the child, so a value captured on the
      // way in is always `null` and every abort would paint as a plain exit.
      const abortReason = ctx.abortReason()
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
      return { stdout, stderr, exitCode, timedOut: timedOut() }
    },
  )
}

/**
 * The child's environment, composed in the order the security model requires:
 * scrub (or an explicit `inheritEnv` opt-out) → local `.env` overlay under the
 * allowlist → egress-proxy variables → brand at the scrubber chokepoint.
 *
 * The branding is what makes an env leak a `tsc` error rather than a review
 * question: the spawn routes through the typed `spawnScrubbed` boundary, which
 * only accepts a `ScrubbedEnv`.
 *
 * Extracted from {@link runShell} (god-function burndown); every step and its
 * byte-identical absent-path is unchanged.
 */
const resolveShellEnv = (options: ShellOptions): ScrubbedEnv => {
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
  return env
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
 *    3. exactly one terminal event — `exit` (code/signal/exitedAt), `aborted`
 *       (reason: user_abort | timeout, abortedAt — a REAL kill), or `detached`
 *       (WS-H: an intentional background handoff; the child is ALIVE in the
 *       registry). `exit`/`aborted` are emitted AFTER both pipes have drained;
 *       `detached` ends the foreground observation only.
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
  const env = resolveShellEnv(options)

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
  //   snapshot restore → per-call wrap → slot wrap.
  // P16/ADR-0529 — platform-aware base shell argv. POSIX hosts resolve bash to
  // an absolute executable BEFORE sandbox wrapping, so Seatbelt/bwrap cannot
  // turn a bare `bash` into an opaque execvp failure by changing PATH. Win32
  // still refuses by default unless the operator opts into a shell mode.
  const winMode = process.platform === "win32" ? resolveWinShellMode() : "error"
  const shellProbe =
    process.platform !== "win32" || winMode === "auto" ? discoverShells() : undefined
  const argvPhase = await resolveShellArgv(command, options, { cwd, winMode, shellProbe })
  if (argvPhase.kind === "error") return argvPhase.result
  const argv = argvPhase.argv
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

  // ADR-0296 auto-background — when a `background` seam is wired, the deadline
  // DETACHES the still-running child into the registry instead of killing it.
  // Self-contained path (own kill/timer/abort): completion BEFORE the deadline
  // is byte-identical to the legacy result (full-concat UTF-8 decode); only the
  // deadline branch diverges (adopt + `detached` marker). Placed before the
  // shared kill-timer so the legacy/observer paths are untouched when absent.
  const background = options.background
  if (background !== undefined) {
    return await runWithBackgroundDetach(proc, {
      command,
      cwd,
      timeoutMs,
      signal: options.signal,
      adopt: background.adopt,
      confirm: background.confirm,
      consentWaitMs: background.consentWaitMs,
      observer,
    })
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
  if (observer) {
    return await collectStreamed(proc, observer, {
      options,
      kill,
      timer,
      disarm,
      onAbort,
      timedOut: () => timedOutFlag,
      abortReason: () => abortReason,
    })
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

/** Full-concat UTF-8 decode of accumulated raw chunks — the SAME decode the
 *  legacy `new Response(stream).text()` path performs, so a background run that
 *  COMPLETES before its deadline yields a byte-identical `stdout`/`stderr`. A
 *  fresh decoder per call (no `stream:true`) flushes any trailing partial
 *  multibyte exactly as a one-shot full-buffer decode would. */
const decodeAll = (chunks: Uint8Array[]): string => new TextDecoder("utf-8").decode(concat(chunks))

/**
 * ADR-0296 auto-background — run a child that DETACHES on its deadline instead
 * of being killed. Used only when the bash tool wires a `background.adopt`
 * seam. The spawn + all pre-spawn sandbox/env/wrap layers already happened in
 * `runShell` (SSOT) — this owns only the drain + deadline race:
 *
 *  - Before the deadline: accumulate raw chunks unbounded. On normal exit,
 *    decode the full concat → a `ShellResult` byte-identical to the legacy
 *    foreground result (the bash tool then runs its usual evidence / passive-VCS
 *    / stale-read machinery on it). A user/turn abort kills the child (the user
 *    asked to stop) and resolves with whatever was captured.
 *  - At the deadline: seed head+tail bounded buffers with the pre-detach output,
 *    flip the live drains to feed them, hand the still-running child (its
 *    kill/disarm closures, buffers, exit promise, drain promise) to the registry
 *    via `adopt`, and resolve with `{ detached: { shellId } }`. The child keeps
 *    running, owned by the registry; the model resumes it via `bash_await` /
 *    `bash_kill`.
 *
 * NO double-settle: a `settled` latch + the `detached` flag make the completion
 * path and the detach path mutually exclusive whichever fires first.
 */
const runWithBackgroundDetach = async (
  proc: Subprocess<"ignore", "pipe", "pipe">,
  cfg: {
    readonly command: string
    readonly cwd: string
    readonly timeoutMs: number
    readonly signal: AbortSignal | undefined
    readonly adopt: NonNullable<ShellOptions["background"]>["adopt"]
    // ADR-0296 PROMPT mode — optional consent gate (see BackgroundDetachSeam).
    readonly confirm: NonNullable<ShellOptions["background"]>["confirm"]
    // WS-H / UUX-6-20 — injectable consent wait (absent ⇒ CONSENT_WAIT_MS).
    readonly consentWaitMs: number | undefined
    // PR-5 observer parity: when wired, emit per-chunk stdout/stderr events
    // PRE-detach + exactly-one terminal event on every exit path, so the
    // observer contract (start ≺ chunks ≺ one terminal) holds in background
    // mode too. Post-detach the registry owns the stream (turn-scoped observer
    // stops). Absent ⇒ no events (byte-identical).
    readonly observer: ((event: RunShellEvent) => void) | undefined
  },
): Promise<ShellResult> => {
  const { kill, disarm } = escalatingKill(proc, FOREGROUND_TREE_KILLER)
  // Shared mutable detach state. Pre-detach each stream accumulates raw chunks
  // (unbounded ⇒ byte-identical completion); at detach `buf`/`dec` are set and
  // `detached` flips so the live drains stream into the bounded buffers.
  const state: DetachState = {
    detached: false,
    out: { chunks: [], offset: 0 },
    err: { chunks: [], offset: 0 },
  }
  const stdoutDone = drainDetachable(proc.stdout, state.out, state, "stdout", cfg.observer)
  const stderrDone = drainDetachable(proc.stderr, state.err, state, "stderr", cfg.observer)
  const drainsDone = Promise.all([stdoutDone, stderrDone]).then(() => undefined)

  return await new Promise<ShellResult>((resolve, reject) => {
    let settled = false
    let userAborted = false
    // PROMPT mode: the user DECLINED background at the deadline ⇒ treat as a
    // legacy timeout (kill + `timedOut:true`). Latched so the completion path
    // reports it honestly.
    let declinedTimeout = false
    const settle = (r: ShellResult): void => {
      if (settled) return
      settled = true
      resolve(r)
    }
    // Explicit abort BEFORE the deadline ⇒ kill (the user asked to stop) and
    // latch `userAborted` so a deadline timer that fires in the same tick does
    // NOT detach an aborting command. After detach this listener is removed so a
    // backgrounded shell survives turn abort (its lifetime is the registry's).
    const onAbort = (): void => {
      userAborted = true
      kill()
    }
    cfg.signal?.addEventListener("abort", onAbort, { once: true })

    // Deadline reached. PROMPT mode: ask for consent first — declined ⇒ kill
    // (legacy timeout); approved (or no `confirm` ⇒ plain background) ⇒ detach.
    const cancelled = (): boolean => settled || state.detached || userAborted
    const onDeadline = async (): Promise<void> => {
      if (cancelled()) return
      // WS-H / UUX-6-05 — the detach terminal is HONEST about how it happened:
      // explicit consent vs the D-5 timeout default vs plain auto-background.
      const consentWaitMs = cfg.consentWaitMs ?? CONSENT_WAIT_MS
      const detachReason = await resolveDeadlineDetachReason(cfg, consentWaitMs)
      // The command may have completed / been aborted while the user decided
      // (the `auto` arm awaits nothing, so this re-check is a no-op there).
      if (cancelled()) return
      if (detachReason === "declined") {
        declinedTimeout = true
        kill() // legacy timeout: the completion path settles with timedOut:true
        return
      }
      await detachInto(state, cfg, {
        kill,
        disarm,
        exited: proc.exited,
        drainsDone,
        onAbort,
        observer: cfg.observer,
        detachReason,
        consentWaitMs,
      })
        .then(settle)
        // Defense-in-depth: `adopt` is structurally no-throw, but if a future
        // registry regressed and rejected we must NOT hang `runShell`. Kill the
        // (already detach-flagged) child and surface a degraded result so the
        // promise always settles.
        .catch(() => {
          kill()
          settle({ stdout: "", stderr: "background adoption failed", exitCode: 1, timedOut: false })
        })
    }
    const timer = setTimeout(() => void onDeadline(), cfg.timeoutMs)

    void drainsDone
      .then(() => proc.exited)
      .then((exitCode) => {
        if (state.detached) return // registry owns the child now
        clearTimeout(timer)
        disarm()
        cfg.signal?.removeEventListener("abort", onAbort)
        // Observer terminal (mirrors the legacy foreground contract): aborted on
        // a user abort OR a declined-timeout kill, else a normal exit.
        cfg.observer?.(selectBgTerminal(userAborted, declinedTimeout, exitCode))
        settle({
          stdout: decodeAll(state.out.chunks),
          stderr: decodeAll(state.err.chunks),
          exitCode,
          timedOut: declinedTimeout,
        })
      })
      .catch((e) => {
        if (state.detached) return
        clearTimeout(timer)
        kill()
        cfg.signal?.removeEventListener("abort", onAbort)
        reject(e)
      })
  })
}

/** ADR-0296 PROMPT mode — bounded wait for operator consent. The host's
 *  `confirm` must NEVER be able to hang `runShell` (an operator who walks away
 *  would otherwise pin the turn open forever). So we race it against a timer:
 *  on timeout we resolve `"timed_out"` (⇒ DETACH — the non-destructive D-5
 *  default: the command already outran its deadline; backgrounding keeps the
 *  work alive and recoverable via `bash_await`/`bash_kill`, whereas killing
 *  would throw it away). WS-H / UUX-6-20: the timeout default is kept but now
 *  DISTINGUISHED from an explicit approval so the `detached` terminal event
 *  can announce it. A throwing prompt is a conservative DECLINE (⇒ kill). */
const CONSENT_WAIT_MS = 60_000
type ConsentOutcome = "approved" | "declined" | "timed_out"

/** WS-H — fold the deadline consent gate into a single decision: `declined` ⇒
 *  kill (legacy timeout), else the HONEST reason the `detached` terminal event
 *  carries (`auto` when no consent gate is wired). Free helper so `onDeadline`
 *  stays under the cognitive-complexity budget. */
const resolveDeadlineDetachReason = async (
  cfg: {
    readonly command: string
    readonly timeoutMs: number
    readonly confirm: NonNullable<ShellOptions["background"]>["confirm"]
  },
  consentWaitMs: number,
): Promise<"consent" | "consent_timeout" | "auto" | "declined"> => {
  if (cfg.confirm === undefined) return "auto"
  const consent = await askConsent(cfg.confirm, cfg.command, cfg.timeoutMs, consentWaitMs)
  if (consent === "declined") return "declined"
  return consent === "timed_out" ? "consent_timeout" : "consent"
}
const askConsent = async (
  confirm: NonNullable<NonNullable<ShellOptions["background"]>["confirm"]>,
  command: string,
  elapsedMs: number,
  waitMs: number,
): Promise<ConsentOutcome> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const decided: Promise<ConsentOutcome> = confirm({ command, elapsedMs }).then(
      (ok) => (ok ? "approved" : "declined"),
      () => "declined",
    )
    const timedOut = new Promise<ConsentOutcome>((res) => {
      timer = setTimeout(() => res("timed_out"), waitMs)
    })
    return await Promise.race([decided, timedOut])
  } catch {
    return "declined"
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Pick the observer's terminal event for the background completion path:
 *  aborted on a user abort OR a declined-timeout kill, else a normal exit. */
const selectBgTerminal = (
  userAborted: boolean,
  declinedTimeout: boolean,
  exitCode: number,
): RunShellEvent => {
  if (userAborted) return { kind: "aborted", reason: "user_abort", abortedAt: Date.now() }
  if (declinedTimeout) return { kind: "aborted", reason: "timeout", abortedAt: Date.now() }
  return { kind: "exit", code: exitCode, signal: null, exitedAt: Date.now() }
}

/** Per-stream detach accumulator: raw `chunks` pre-detach, then a bounded
 *  `buf` + streaming `dec` once detached. `offset` tracks the per-stream byte
 *  position for observer chunk events. */
interface DetachStream {
  readonly chunks: Uint8Array[]
  offset: number
  buf?: BoundedBuffer
  dec?: TextDecoder
}
interface DetachState {
  detached: boolean
  readonly out: DetachStream
  readonly err: DetachStream
}

/** Drain one pipe: append to the raw `chunks` until detach, then stream-decode
 *  into the bounded `buf`. PRE-detach, forward each chunk to the observer (with
 *  its byte offset) so the foreground stream is observable; POST-detach the
 *  registry owns the stream and the turn-scoped observer stops. Hoisted (vs an
 *  inner closure) to keep `runWithBackgroundDetach` under the complexity cap. */
const drainDetachable = async (
  stream: ReadableStream<Uint8Array>,
  s: DetachStream,
  state: DetachState,
  kind: "stdout" | "stderr",
  observer: ((event: RunShellEvent) => void) | undefined,
): Promise<void> => {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (!value || value.byteLength === 0) continue
      if (state.detached && s.buf !== undefined && s.dec !== undefined) {
        s.buf.append(s.dec.decode(value, { stream: true }))
      } else {
        if (observer !== undefined) {
          observer({ kind, chunk: value, offset: s.offset })
          s.offset += value.byteLength
        }
        s.chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Deadline reached — seed the bounded buffers with the FULL pre-detach output,
 *  flip `detached`, and hand the still-running child to the registry. The
 *  seed→flag block is synchronous, so no chunk can arrive between `decodeAll`
 *  and `detached = true` (the drain's next `reader.read()` only settles on a
 *  later microtask) — nothing is double-counted or dropped. Returns the
 *  `detached` `ShellResult` the caller settles with. */
const detachInto = async (
  state: DetachState,
  cfg: {
    readonly command: string
    readonly cwd: string
    readonly signal: AbortSignal | undefined
    readonly adopt: NonNullable<ShellOptions["background"]>["adopt"]
  },
  child: {
    readonly kill: () => void
    readonly disarm: () => void
    readonly exited: Promise<number>
    readonly drainsDone: Promise<void>
    readonly onAbort: () => void
    readonly observer: ((event: RunShellEvent) => void) | undefined
    // WS-H / UUX-6-05 — how this detach came to be (honest terminal event).
    readonly detachReason: "consent" | "consent_timeout" | "auto"
    readonly consentWaitMs: number
  },
): Promise<ShellResult> => {
  const outBuf = createBoundedBuffer(DETACH_TAIL_BUDGET_BYTES)
  const errBuf = createBoundedBuffer(DETACH_TAIL_BUDGET_BYTES)
  outBuf.append(decodeAll(state.out.chunks))
  errBuf.append(decodeAll(state.err.chunks))
  state.out.buf = outBuf
  state.err.buf = errBuf
  state.out.dec = new TextDecoder("utf-8")
  state.err.dec = new TextDecoder("utf-8")
  const headOut = outBuf.value()
  const headErr = errBuf.value()
  state.detached = true
  cfg.signal?.removeEventListener("abort", child.onAbort)
  // Observer terminal: WS-H / UUX-6-05 — an INTENTIONAL detach is `detached`
  // (the child is alive in the registry), never the `aborted (timeout)` lie the
  // painter used to render. Exactly one terminal for this observer (the
  // completion path is short-circuited by `detached`). The consent-timeout
  // default (D-5) carries its wait so the surface can announce "no answer in Ns".
  child.observer?.({
    kind: "detached",
    reason: child.detachReason,
    detachedAt: Date.now(),
    ...(child.detachReason === "consent_timeout" ? { consentWaitMs: child.consentWaitMs } : {}),
  })
  const { id } = await cfg.adopt({
    command: cfg.command,
    cwd: cfg.cwd,
    kill: child.kill,
    disarm: child.disarm,
    stdout: outBuf,
    stderr: errBuf,
    exited: child.exited,
    drainsDone: child.drainsDone,
  })
  return {
    stdout: headOut,
    stderr: headErr,
    // Placeholder — the child has not exited; the caller branches on `detached`
    // before ever reading `exitCode`.
    exitCode: 0,
    timedOut: false,
    detached: { shellId: id },
  }
}
