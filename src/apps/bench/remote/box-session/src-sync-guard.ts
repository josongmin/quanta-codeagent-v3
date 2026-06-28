/**
 * src-sync-guard — close the silent-stale-CODE class for REUSED boxes.
 *
 * A warm box's `~/quanta/src` is whatever was rsynced at its ORIGINAL bootstrap.
 * `attachBox` reuses a still-bootstrapped box WITHOUT re-syncing, so a box
 * provisioned BEFORE a code change silently grades with OLD src — a measurement
 * confound that masquerades as a real failure (jun-28: a committed sphinx -rA
 * grader fix appeared inert on a box reused from before the commit; the box's
 * file mtime predated HEAD, so the run graded with stale src and still emitted
 * grader_invalid). `isBootstrapped` only proves the box HAS a src dir + toolchain
 * — never that the src MATCHES the orchestrator's current tree.
 *
 * Fix: on every reuse, run a CONTENT-checksummed rsync of src/. It is idempotent
 * — a current box transfers nothing (fast no-op); a stale box self-heals and the
 * itemized files are surfaced for observability. The excludes are SSOT-shared
 * with the initial bootstrap rsync so the verify-sync and the seed-sync can
 * never diverge (a divergence would either ship excluded files or miss real
 * drift).
 */
import type { SpawnFn } from "../backend"
import { BENCH_SSH_SAFE_OPTS } from "./shell"

/** Paths NOT shipped to the box. SSOT for BOTH the bootstrap seed-sync and the
 *  reuse self-heal — `*.js` are stale compiled mirrors (bun runs .ts directly),
 *  `*.test.ts` are not needed to RUN the agent. */
export const SRC_RSYNC_EXCLUDES = ["node_modules", "*.js", "*.test.ts", ".quanta"] as const

/** Build the `rsync` argv that syncs `<repoDir>/src/` → box `~/quanta/src/`.
 *  With no opts the argv is byte-identical to the historical bootstrap rsync.
 *  `checksum` forces a CONTENT compare (size+mtime can BOTH coincidentally match
 *  a stale edit); `itemize` emits one line per transferred path (the self-heal
 *  observability seam). */
export const buildSrcRsyncArgs = (
  repoDir: string,
  host: string,
  sshOpts: string,
  opts?: { readonly checksum?: boolean; readonly itemize?: boolean },
): string[] => {
  const args = ["-az", "--partial"]
  if (opts?.checksum === true) args.push("--checksum")
  if (opts?.itemize === true) args.push("--itemize-changes")
  for (const ex of SRC_RSYNC_EXCLUDES) args.push("--exclude", ex)
  args.push("-e", sshOpts, `${repoDir}/src/`, `${host}:~/quanta/src/`)
  return args
}

/** rsync `--itemize-changes` prints an 11-char `YXcstpoguax` code, a space, then
 *  the path. A CONTENT transfer is a FILE update — code begins `>f`/`<f`/`cf`
 *  (send / receive / locally-created file). Directory entries (`cd`/`.d`),
 *  attr-only touches (`.f……`), and `*deleting` lines are NOT content drift and
 *  are ignored, so a current box parses to ZERO transfers. */
const TRANSFER_LINE = /^[<>c]f\S*\s+(.+)$/
export const parseItemizedTransfers = (stdout: string): string[] => {
  const out: string[] = []
  for (const raw of stdout.split("\n")) {
    const m = TRANSFER_LINE.exec(raw.trim())
    if (m?.[1] !== undefined) out.push(m[1])
  }
  return out
}

export interface SrcSyncOutcome {
  /** True iff the reused box was running stale src (≥1 file self-healed). */
  readonly wasStale: boolean
  /** The src paths rsync transferred to bring the box current. */
  readonly transferred: readonly string[]
}

/** Build the human log line for a self-heal outcome (pure; empty when current). */
export const describeSrcSync = (o: SrcSyncOutcome): string | undefined => {
  if (!o.wasStale) return undefined
  const shown = o.transferred.slice(0, 8).join(", ")
  const more = o.transferred.length > 8 ? ` (+${o.transferred.length - 8} more)` : ""
  return `[full-remote] reuse: box src was STALE — self-healed ${o.transferred.length} file(s): ${shown}${more}`
}

/** Run a checksum-mode src rsync onto a REUSED box (idempotent self-heal). Throws
 *  on rsync failure — a box whose src cannot be verified-current MUST NOT grade
 *  (the whole point is to never silently run stale code). */
export const ensureBoxSrcCurrent = async (deps: {
  readonly spawn: SpawnFn
  readonly repoDir: string
  readonly host: string
  readonly keyPath: string
  readonly log: (msg: string) => void
}): Promise<SrcSyncOutcome> => {
  const sshOpts = `ssh -i ${deps.keyPath} ${BENCH_SSH_SAFE_OPTS.join(" ")} -o ConnectTimeout=15 -o ServerAliveInterval=15`
  const args = buildSrcRsyncArgs(deps.repoDir, deps.host, sshOpts, {
    checksum: true,
    itemize: true,
  })
  const res = await deps.spawn("rsync", args)
  if (res.code !== 0) {
    throw new Error(
      `[full-remote] reuse src self-heal rsync failed (code ${res.code}): ${res.stderr}`,
    )
  }
  const transferred = parseItemizedTransfers(res.stdout)
  const outcome: SrcSyncOutcome = { wasStale: transferred.length > 0, transferred }
  const line = describeSrcSync(outcome)
  if (line !== undefined) deps.log(line)
  return outcome
}
