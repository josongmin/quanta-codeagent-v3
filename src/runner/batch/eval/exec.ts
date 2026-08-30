/**
 * Tiny `bash -c` + argv-form exec helpers shared by every eval module.
 *
 * Shell exec is a tiny local Bun.spawn helper, but it spawns children with the
 * single-source `@/runtime` `scrubEnv()` allowlist (NOT raw `process.env`) so a
 * bench child can never inherit `OPENAI_API_KEY`/tokens — that is what makes
 * the trajectory's `envPolicyVersion` stamp truthful (C9). Apps may import
 * slices (RFC §3.1); reusing scrubEnv keeps ONE env policy, not a fork.
 *
 * Why `bash -c` here (and why this is safe in this module): the eval shell
 * has to honour test-suite scripts that depend on shell features (pipes,
 * redirections, `&&`/`||`, env interpolation) baked into the SWE-bench
 * `testCmd`/`installCmd` strings. The dataset/corpus that produces these
 * strings is trusted (project-controlled fixture material, not LLM output)
 * and they have always been executed as shell scripts. The strict argv-only
 * sibling {@link execArgv} is used for git pathspec invocations where shell
 * word-splitting would corrupt the `:(exclude,top)…` magic. LLM-controlled
 * inputs MUST flow through the agent's `bash` tool, NOT through this helper.
 */
import {
  applyLocalEnv,
  DEFAULT_ENV_ALLOWLIST,
  defaultPpidWalkKiller,
  escalatingKill,
  type KillableChild,
  type LocalEnvSelection,
  scrubEnv,
} from "@/runtime"

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

// jun-26 SE-audit: a bench test/install command is a process TREE
// (`bash -c "<testCmd>"` → pytest → workers). `proc.kill()` signals only the
// `bash` root, so a surviving child holds the stdout/stderr pipe open and the
// `new Response(proc.stdout).text()` await HANGS past the deadline — leaking the
// tree and stalling the whole grading run. So the deadline tree-kills.
//
// This used to hand-roll its own SIGTERM→SIGKILL escalation over a bare
// `signalTree`, and the comment here claimed it was "the same primitive the
// agent's bash bg-registry uses" — it was NOT: `bash-bg-registry.ts` calls
// `escalatingKill(proc, BG_TREE_KILLER)`, while this file bypassed
// `escalatingKill` entirely. The copy had DIVERGED from the canonical one on
// four points: no positive-pid guard (only `pid === undefined`), no `reaped`
// latch, no `unref` on the grace timer, and its own duplicate grace constant.
// The `reaped` omission was the load-bearing one — `guarded-spawn.ts` documents
// that signalling a long-dead pid risks SIGKILL-ing a RECYCLED pid two seconds
// later, and this armed exactly that with nothing to stop it.
//
// It now genuinely uses the same primitive, so all four properties (and any
// future fix to them) come for free, and this file is no longer a hand-rolled
// `signalTree` caller invisible to the single-PID-kill ban.
const BENCH_TREE_KILLER = defaultPpidWalkKiller()

/** Arm a deadline that tree-kills `proc` via the canonical escalating kill
 *  (SIGTERM, then SIGKILL after {@link KILL_GRACE_MS}). Returns the cleanup that
 *  cancels the deadline AND disarms any pending SIGKILL grace timer. */
const armTreeKillTimeout = (proc: KillableChild, timeoutMs: number): (() => void) => {
  const { kill, disarm } = escalatingKill(proc, BENCH_TREE_KILLER)
  const deadline = setTimeout(kill, timeoutMs)
  return () => {
    clearTimeout(deadline)
    disarm()
  }
}

export interface ExecOptions {
  readonly localEnv?: LocalEnvSelection
  /** EXTRA names layered onto {@link DEFAULT_ENV_ALLOWLIST} for this call —
   *  for children that need daemon-endpoint selection vars (e.g. the
   *  `DOCKER_HOST`/TLS set, mirroring `tool/container-exec/docker-run.ts`).
   *  Names only widen the allowlist; the scrub still governs, so provider
   *  credentials (`OPENAI_API_KEY`/tokens) can never ride through unless a
   *  caller explicitly allowlists them — don't. */
  readonly extraEnvAllowlist?: readonly string[]
}

const execEnv = (options: ExecOptions | undefined): NodeJS.ProcessEnv => {
  const extra = options?.extraEnvAllowlist
  const allowlist =
    extra === undefined || extra.length === 0
      ? DEFAULT_ENV_ALLOWLIST
      : [...DEFAULT_ENV_ALLOWLIST, ...extra]
  return applyLocalEnv(scrubEnv(allowlist), options?.localEnv, allowlist)
}

/**
 * Minimal `bash -c` exec via Bun.spawn with a hard timeout. C9: children are
 * spawned with the single-source `scrubEnv()` allowlist (PATH/HOME/proxy/
 * locale/TMPDIR preserved so git/bun/node still work) — the parent's secrets
 * (`OPENAI_API_KEY`/tokens) are NEVER inherited. This makes the `sandbox`
 * trajectory event's `envPolicyVersion` claim true.
 *
 * `cmd` is interpreted as a shell script (see module-level docstring on why
 * shell features are required for SWE-bench `testCmd`/`installCmd` strings).
 * Callers MUST only pass strings sourced from trusted dataset/corpus material
 * — never LLM- or user-controlled text. For trusted argv-form invocations
 * (git pathspec, etc.) use {@link execArgv} instead.
 */
export const exec = async (
  cmd: string,
  cwd: string,
  timeoutMs: number,
  options?: ExecOptions,
): Promise<ExecResult> => {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: execEnv(options),
  })
  const cancelKill = armTreeKillTimeout(proc, timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { code, stdout, stderr }
  } finally {
    cancelKill()
  }
}

/**
 * Argv-form exec (no `bash -c`). Used for git pathspec-exclude invocations
 * where the `:(exclude,top)…` magic must not pass through shell word-splitting
 * or quote-stripping. Same env scrub + timeout semantics as {@link exec}.
 */
export const execArgv = async (
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  options?: ExecOptions,
): Promise<ExecResult> => {
  const proc = Bun.spawn([...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: execEnv(options),
  })
  const cancelKill = armTreeKillTimeout(proc, timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { code, stdout, stderr }
  } finally {
    cancelKill()
  }
}

export const trimOut = (r: ExecResult): string => (r.code === 0 ? r.stdout.trim() : "")
