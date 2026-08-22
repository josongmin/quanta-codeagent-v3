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
// tree and stalling the whole grading run. Tree-kill on timeout (SIGTERM, then
// SIGKILL after a grace) — the same primitive the agent's bash bg-registry uses.
const BENCH_TREE_KILLER = defaultPpidWalkKiller()
const TREE_SIGKILL_GRACE_MS = 2_000

/** Arm a deadline that tree-kills `proc` (SIGTERM → SIGKILL escalation). Returns
 *  the cleanup that cancels both timers. No-op when `proc.pid` is undefined. */
const armTreeKillTimeout = (proc: { pid?: number }, timeoutMs: number): (() => void) => {
  let kill9: ReturnType<typeof setTimeout> | undefined
  const term = setTimeout(() => {
    const pid = proc.pid
    if (pid === undefined) return
    BENCH_TREE_KILLER.signalTree(pid, "SIGTERM")
    kill9 = setTimeout(() => BENCH_TREE_KILLER.signalTree(pid, "SIGKILL"), TREE_SIGKILL_GRACE_MS)
  }, timeoutMs)
  return () => {
    clearTimeout(term)
    if (kill9 !== undefined) clearTimeout(kill9)
  }
}

export interface ExecOptions {
  readonly localEnv?: LocalEnvSelection
}

const execEnv = (options: ExecOptions | undefined): NodeJS.ProcessEnv =>
  applyLocalEnv(scrubEnv(), options?.localEnv, DEFAULT_ENV_ALLOWLIST)

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
