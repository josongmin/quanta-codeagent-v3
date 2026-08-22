/**
 * Branch-search anchor seam (ADR-0116) — wires the Shadow git ODB (ADR-0108)
 * into the speculative branch search (ADR-0084) as an OPT-IN, NO-THROW anchor
 * + per-candidate delta measurement port.
 *
 * Purpose: today's branch search runs N isolated candidates with no common
 * starting point and no quantified "how much did each candidate diverge"
 * signal. Without that, we can't audit whether the search narrowed on a
 * minimal change, can't bias winner-selection toward smaller deltas, and have
 * no rewind safety net. The Shadow ODB ledger gives us those measurements
 * non-invasively (never touches the user's `.git`).
 *
 * Closed port: `BranchSearchAnchor` is the single seam threaded through the
 * orchestrator. The default implementation `shadowOdbAnchor` is backed by
 * `ShadowOdb.registerHead` + `ShadowOdb.diffWorkspaceSinceLast`. Tests inject
 * fakes for behavioural coverage; production callers wire the default in
 * `branch-search-runner.ts` when `AgentConfig.shadowOdb` is set.
 *
 * Hard invariant: BOTH methods are NO-THROW. Anchor I/O failures (missing
 * `~/.quanta`, ENOSPC, spawn failures, git non-zero exits) MUST NOT crash the
 * branch search. Failures collapse to `{ok:false}` or `null` — the search
 * proceeds with `delta` simply OMITTED on affected candidates (fail-open).
 *
 * Default-OFF: `AgentConfig.shadowOdb` absent ⇒ the runner builds no anchor,
 * the orchestrator's anchor path is bypassed entirely, and branch-search is
 * byte-identical to its pre-ADR-0116 behaviour.
 */

import { errMessage } from "@/shared"
import type { ShadowOdb } from "@/storage/shadow-odb"
/** Quantified measurement of how much one candidate's workspace diverged
 *  from the anchor point. All fields non-negative integers. Pure data —
 *  no I/O, no methods. */
export interface DeltaMeasurement {
  readonly changedFiles: number
  readonly addedLines: number
  readonly removedLines: number
}

/** Closed-port: pluggable "register a starting point, measure per-candidate
 *  delta" seam. Both methods are NO-THROW — anchor I/O must never crash
 *  the search (fail-open). */
export interface BranchSearchAnchor {
  /** Called ONCE per search invocation, BEFORE any candidate runs. Returns
   *  `{ok:true}` on success, `{ok:false, reason}` on failure. The search
   *  proceeds regardless. Subsequent calls within the same anchor instance
   *  are idempotent (no double `registerHead`). */
  registerStart(): Promise<{ ok: true } | { ok: false; reason: string }>

  /** Called for EACH successfully-completed candidate, with the candidate's
   *  isolated workspace path. Returns `null` when measurement is impossible
   *  (anchor not registered, I/O failure of any kind) — never throws.
   *  An empty diff legitimately maps to `{0,0,0}`, NOT null. */
  measureDelta(workspace: string): Promise<DeltaMeasurement | null>
}

/** Parse a `git diff` unified-diff body into a `DeltaMeasurement`. Exported
 *  for tests AND for reuse by future anchor implementations (e.g. one
 *  backed by `git diff-tree` against a non-shadow ref).
 *
 *  Counting contract:
 *  - `changedFiles` = count of distinct `diff --git a/X b/X` headers.
 *  - `addedLines` = count of lines whose first character is `+` and that
 *    are NOT `+++ ` file-marker lines.
 *  - `removedLines` = count of lines whose first character is `-` and
 *    that are NOT `--- ` file-marker lines.
 *
 *  Pure: no I/O, no allocation beyond the line split. Empty input → all
 *  zeros (NOT an error — same as `diff` exit code 0 on an unchanged tree). */
export const parseDiffMeasurement = (diff: string): DeltaMeasurement => {
  if (diff.length === 0) return { changedFiles: 0, addedLines: 0, removedLines: 0 }
  let changedFiles = 0
  let addedLines = 0
  let removedLines = 0
  // Split on `\n` only — `git diff` is LF-terminated regardless of OS.
  // Empty trailing element from a trailing newline is harmless (no `+`/`-`
  // first character).
  const lines = diff.split("\n")
  for (const line of lines) {
    // File header (`diff --git a/foo b/foo`) — bumps file count exactly
    // once per file. Same prefix used by all `git diff` variants we
    // produce (with or without `--no-color`).
    if (line.startsWith("diff --git ")) {
      changedFiles += 1
      continue
    }
    // Reject the `+++ ` / `--- ` file-marker lines first so a file named
    // `+something` in a path doesn't collide. These markers always have
    // the second character `+`/`-` AND a space; body lines never do
    // (a body `+++` would be `+++<rest>` but we only emit that for the
    // file-marker which always starts at col 0 of a hunk).
    if (line.startsWith("+++")) continue
    if (line.startsWith("---")) continue
    // Body lines: a single leading `+` or `-`. Index lines start with
    // `index `, `@@ ` etc. — none of those collide.
    if (line.startsWith("+")) addedLines += 1
    else if (line.startsWith("-")) removedLines += 1
  }
  return { changedFiles, addedLines, removedLines }
}

/** Default `BranchSearchAnchor` backed by the Shadow ODB.
 *
 *  - `registerStart()` calls `odb.registerHead(baseCwd)` ONCE. The second
 *    call within the same anchor instance is a no-op returning `{ok:true}`.
 *    Failure surfaces as `{ok:false, reason}` — never throws.
 *  - `measureDelta(workspace)` calls
 *    `odb.diffWorkspaceSinceLast(baseCwd, workspace)`, parses the unified
 *    diff via `parseDiffMeasurement`, returns the result. Returns `null`
 *    when:
 *      * `registerStart` was never called (no ref to diff against), OR
 *      * `registerStart` failed earlier, OR
 *      * `diffWorkspaceSinceLast` throws for any reason. */
export const shadowOdbAnchor = (odb: ShadowOdb, baseCwd: string): BranchSearchAnchor => {
  // Tracked state: `registered` flips to true on the first successful
  // `registerStart`. `measureDelta` short-circuits to `null` until then,
  // mirroring the "no anchor ⇒ no measurement" invariant.
  let registered = false
  let registerCallInFlight: Promise<{ ok: true } | { ok: false; reason: string }> | null = null

  return {
    async registerStart() {
      // Idempotent: once registered, subsequent calls succeed without a
      // second `registerHead`. Concurrent first-callers share the same
      // in-flight promise so we never race two `registerHead` invocations
      // (the ODB itself also serializes, but avoiding the second call is
      // cheaper than racing).
      if (registered) return { ok: true }
      if (registerCallInFlight !== null) return registerCallInFlight
      const inflight = (async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
        try {
          await odb.registerHead(baseCwd)
          registered = true
          return { ok: true }
        } catch (err) {
          const reason = errMessage(err)
          return { ok: false, reason }
        } finally {
          registerCallInFlight = null
        }
      })()
      registerCallInFlight = inflight
      return inflight
    },

    async measureDelta(workspace: string): Promise<DeltaMeasurement | null> {
      if (!registered) return null
      try {
        const diff = await odb.diffWorkspaceSinceLast(baseCwd, workspace)
        return parseDiffMeasurement(diff)
      } catch {
        // No-throw contract: any anchor I/O error collapses to `null`
        // and the search continues with `delta` simply omitted on this
        // candidate. The cause is intentionally NOT surfaced here —
        // observability (if any) is the caller's job; the anchor itself
        // must not introduce a new failure mode.
        return null
      }
    },
  }
}
