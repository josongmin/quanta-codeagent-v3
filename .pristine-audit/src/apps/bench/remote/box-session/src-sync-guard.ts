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
 *  observability seam); `del` adds `--delete` so a file DELETED locally since the
 *  box's last sync is removed from the box too (else it lingers as an orphan that
 *  a dynamic import could still execute). `--delete` (NOT `--delete-excluded`)
 *  protects excluded paths, so the box's `*.js`/node_modules are never touched. */
export const buildSrcRsyncArgs = (
  repoDir: string,
  host: string,
  sshOpts: string,
  opts?: { readonly checksum?: boolean; readonly itemize?: boolean; readonly del?: boolean },
): string[] => {
  const args = ["-az", "--partial"]
  if (opts?.checksum === true) args.push("--checksum")
  if (opts?.itemize === true) args.push("--itemize-changes")
  if (opts?.del === true) args.push("--delete")
  for (const ex of SRC_RSYNC_EXCLUDES) args.push("--exclude", ex)
  args.push("-e", sshOpts, `${repoDir}/src/`, `${host}:~/quanta/src/`)
  return args
}

/** rsync `--itemize-changes` prints an 11-char `YXcstpoguax` code, a space, then
 *  the path. A CONTENT transfer is a FILE update — code begins `>f`/`<f`/`cf`
 *  (send / receive / locally-created file). Directory entries (`cd`/`.d`) and
 *  attr-only touches (`.f……`) are NOT content drift and are ignored, so a current
 *  box parses to ZERO transfers. */
const TRANSFER_LINE = /^[<>c]f\S*\s+(.+)$/
export const parseItemizedTransfers = (stdout: string): string[] => {
  const out: string[] = []
  for (const raw of stdout.split("\n")) {
    const m = TRANSFER_LINE.exec(raw.trim())
    if (m?.[1] !== undefined) out.push(m[1])
  }
  return out
}

/** With `--delete`, rsync prints `*deleting   <path>` for each orphan it removes
 *  from the box (a file deleted locally since the box's last sync). These are
 *  staleness too — the box was carrying code that no longer exists. */
const DELETING_LINE = /^\*deleting\s+(.+)$/
export const parseItemizedDeletions = (stdout: string): string[] => {
  const out: string[] = []
  for (const raw of stdout.split("\n")) {
    const m = DELETING_LINE.exec(raw.trim())
    if (m?.[1] !== undefined) out.push(m[1].replace(/\/$/, ""))
  }
  return out
}

export interface SrcSyncOutcome {
  /** True iff the reused box was running stale src (≥1 file transferred OR deleted). */
  readonly wasStale: boolean
  /** The src paths rsync transferred to bring the box current. */
  readonly transferred: readonly string[]
  /** The orphan src paths rsync DELETED from the box (removed-since-sync). */
  readonly deleted: readonly string[]
}

const truncList = (xs: readonly string[]): string => {
  const shown = xs.slice(0, 8).join(", ")
  return `${shown}${xs.length > 8 ? ` (+${xs.length - 8} more)` : ""}`
}

/** Build the human log line for a self-heal outcome (pure; undefined when current). */
export const describeSrcSync = (o: SrcSyncOutcome): string | undefined => {
  if (!o.wasStale) return undefined
  const parts: string[] = []
  if (o.transferred.length > 0)
    parts.push(`synced ${o.transferred.length} file(s): ${truncList(o.transferred)}`)
  if (o.deleted.length > 0)
    parts.push(`removed ${o.deleted.length} orphan(s): ${truncList(o.deleted)}`)
  return `[full-remote] reuse: box src was STALE — self-healed [${parts.join("; ")}]`
}

/** Run a checksum-mode, delete-enabled src rsync onto a REUSED box (idempotent
 *  self-heal). Throws on rsync failure — a box whose src cannot be verified-current
 *  MUST NOT grade (the whole point is to never silently run stale code). */
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
    del: true,
  })
  const res = await deps.spawn("rsync", args)
  if (res.code !== 0) {
    throw new Error(
      `[full-remote] reuse src self-heal rsync failed (code ${res.code}): ${res.stderr}`,
    )
  }
  const transferred = parseItemizedTransfers(res.stdout)
  const deleted = parseItemizedDeletions(res.stdout)
  const outcome: SrcSyncOutcome = {
    wasStale: transferred.length > 0 || deleted.length > 0,
    transferred,
    deleted,
  }
  const line = describeSrcSync(outcome)
  if (line !== undefined) deps.log(line)
  return outcome
}

/** Config files scp'd at bootstrap. Drift on REUSE is the same stale class as src:
 *  a new dep (package.json/bun.lock) or a new path alias (tsconfig*) added since
 *  the box's bootstrap would otherwise leave the reused box running old config. */
export const CONFIG_FILES = [
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "tsconfig.base.json",
  "bunfig.toml",
] as const

/** Files whose drift requires a `bun install` (dep graph changed), not just a
 *  re-copy. tsconfig/bunfig are read at bun startup, so a re-sync alone suffices. */
const INSTALL_TRIGGERS: ReadonlySet<string> = new Set(["package.json", "bun.lock"])

/** rsync argv for the config-file set → box `~/quanta/` (checksum+itemize, no
 *  `--delete`: these are individually-named files, not a mirrored tree). */
export const buildConfigRsyncArgs = (repoDir: string, host: string, sshOpts: string): string[] => {
  const args = ["-az", "--checksum", "--itemize-changes", "-e", sshOpts]
  for (const f of CONFIG_FILES) args.push(`${repoDir}/${f}`)
  args.push(`${host}:~/quanta/`)
  return args
}

/** True iff any drifted config file requires a dependency reinstall. */
export const configDriftNeedsInstall = (transferred: readonly string[]): boolean =>
  transferred.some((f) => INSTALL_TRIGGERS.has(f.replace(/^.*\//, "")))

export interface ConfigSyncOutcome {
  readonly configStale: boolean
  readonly transferred: readonly string[]
  readonly reinstalled: boolean
}

/** Bring a REUSED box's build config current too: re-sync the config-file set
 *  and, if the dependency graph drifted, re-run `bun install`. Idempotent (a
 *  current box transfers nothing). Throws on rsync/install failure. */
export const ensureBoxConfigCurrent = async (deps: {
  readonly spawn: SpawnFn
  readonly ssh: (cmd: string) => Promise<{ readonly code: number; readonly stderr: string }>
  readonly repoDir: string
  readonly host: string
  readonly keyPath: string
  readonly log: (msg: string) => void
}): Promise<ConfigSyncOutcome> => {
  const sshOpts = `ssh -i ${deps.keyPath} ${BENCH_SSH_SAFE_OPTS.join(" ")} -o ConnectTimeout=15 -o ServerAliveInterval=15`
  const res = await deps.spawn("rsync", buildConfigRsyncArgs(deps.repoDir, deps.host, sshOpts))
  if (res.code !== 0) {
    throw new Error(
      `[full-remote] reuse config self-heal rsync failed (code ${res.code}): ${res.stderr}`,
    )
  }
  const transferred = parseItemizedTransfers(res.stdout)
  if (transferred.length === 0) return { configStale: false, transferred, reinstalled: false }
  const needsInstall = configDriftNeedsInstall(transferred)
  deps.log(
    `[full-remote] reuse: box config was STALE — re-synced ${transferred.length} file(s): ${truncList(
      transferred,
    )}${needsInstall ? " → re-running bun install (dep graph drifted)" : ""}`,
  )
  if (needsInstall) {
    const install = await deps.ssh(
      "set -o pipefail; cd ~/quanta && ~/.bun/bin/bun install 2>&1 | tail -5",
    )
    if (install.code !== 0) {
      throw new Error(
        `[full-remote] reuse config self-heal bun install failed (code ${install.code}): ${install.stderr}`,
      )
    }
  }
  return { configStale: true, transferred, reinstalled: needsInstall }
}
