/**
 * AutoApprovalReview (ADR-0135 §4 — Codex `automaticApprovalReview`).
 *
 * Periodic "are we still OK with these auto-approvals?" prompt. The reviewer
 * is a pure ledger: callers record every approval decision (auto vs user vs
 * deny), and the reviewer reports when a threshold of consecutive auto-
 * approvals has been crossed. The actual UX prompt is rendered by the caller
 * (CLI / Tauri / web) — this slice owns only the bookkeeping.
 *
 * Default threshold: 10 auto-approvals between user-visible reviews. The
 * count is RESET on a user-driven decision (the operator was already in the
 * loop), and on a denial (the gate spoke loud — no need to re-prompt).
 *
 * Slice rules: pure data structure + small helpers. No IO. Tests inject a
 * clock for determinism.
 */

/** One row in the review ledger. */
export interface ApprovalRecord {
  /** Stable tool identifier (`bash` / `edit` / …). Used in the summary. */
  readonly tool: string
  /** True ⇒ the gate allowed the action; false ⇒ denied. */
  readonly granted: boolean
  /** Source of the decision. `auto` ⇒ no user prompt; `user` ⇒ explicit
   *  human approval; `system` ⇒ HARD_DENY or policy default. */
  readonly method: "auto" | "user" | "system"
  /** Wall-clock ms when the decision landed. */
  readonly decidedAt: number
}

export interface ApprovalReviewerOpts {
  /** How many consecutive auto-approvals before a user-facing review fires.
   *  Default 10 (ADR-0135 §4). Must be ≥ 1. */
  readonly threshold?: number
  /** Max records the in-memory ledger retains. Default 200 (bounded so a
   *  long session does not unbounded-grow). */
  readonly capacity?: number
  /** Clock — tests pass a deterministic counter. */
  readonly now?: () => number
}

const DEFAULT_THRESHOLD = 10
const DEFAULT_CAPACITY = 200

/** Scan from the newest record backward, collecting consecutive auto-granted
 *  records until hitting a boundary (user/system event OR a denial) or the
 *  cap. Returned oldest → newest. Pure helper extracted to keep the
 *  reviewer methods low-complexity. */
const collectRecentAutoApprovals = (
  ledger: ReadonlyArray<ApprovalRecord>,
  cap: number,
): ApprovalRecord[] => {
  const acc: ApprovalRecord[] = []
  for (let i = ledger.length - 1; i >= 0 && acc.length < cap; i--) {
    const r = ledger[i]
    if (r === undefined) break
    if (r.method !== "auto" || !r.granted) break
    acc.push(r)
  }
  acc.reverse()
  return acc
}

export interface ApprovalReviewer {
  /** Append a decision. Returns true when this call CROSSES the threshold
   *  — the caller should prompt the user. The counter then resets so the
   *  next prompt fires after another N auto-approvals. */
  record(record: Omit<ApprovalRecord, "decidedAt">): boolean

  /** Plain-text summary of the most recent auto-approvals. Reads
   *  back-to-front so the operator sees freshest activity first.
   *  Empty string when the ledger is empty. */
  generateReviewSummary(): string

  /** Number of consecutive auto-approvals since the last user / deny event
   *  (or since the last prompt fired). Used by surfaces that want to show
   *  a progress indicator. */
  consecutiveAutoApprovals(): number

  /** Frozen snapshot of every record (oldest → newest). Diagnostic /
   *  audit surface. */
  history(): ReadonlyArray<ApprovalRecord>

  /** Reset state. */
  clear(): void
}

// FORWARD-SEAM (not wired): live auto-approval cadence = auto-approval-review-observer + allowlistEscalated; this ledger is Codex-parity substrate, no runtime consumer.
/** Create an ApprovalReviewer. Pure factory — produces a closure with the
 *  ledger captured. */
export const createApprovalReviewer = (opts: ApprovalReviewerOpts = {}): ApprovalReviewer => {
  const threshold = Math.max(1, opts.threshold ?? DEFAULT_THRESHOLD)
  const capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY)
  const clock = opts.now ?? Date.now

  const ledger: ApprovalRecord[] = []
  let consecutiveAuto = 0

  const push = (r: ApprovalRecord): void => {
    ledger.push(r)
    if (ledger.length > capacity) ledger.shift()
  }

  return {
    record(input) {
      const rec: ApprovalRecord = { ...input, decidedAt: clock() }
      push(rec)
      // Only AUTO-granted approvals count toward the threshold. A user/system
      // event resets the streak (operator was in the loop already).
      if (rec.method === "auto" && rec.granted) {
        consecutiveAuto++
        if (consecutiveAuto >= threshold) {
          consecutiveAuto = 0 // reset so the next prompt fires after N more.
          return true
        }
        return false
      }
      // Non-auto OR a denial — streak broken.
      consecutiveAuto = 0
      return false
    },
    generateReviewSummary() {
      if (ledger.length === 0) return ""
      // Most-recent N auto-approvals (the threshold's worth) read from the
      // tail, stopping at the previous user/deny boundary — the summary is
      // "what happened since you last looked".
      const since = collectRecentAutoApprovals(ledger, threshold)
      const head = `Auto-approval review — ${since.length} recent auto-approval${since.length === 1 ? "" : "s"}:`
      const lines = since.map((r, idx) => `  ${idx + 1}. ${r.tool} (granted, auto)`)
      const hint =
        "Hint: respond to confirm the policy is still appropriate, or revoke the auto-approval scope."
      return [head, ...lines, hint].join("\n")
    },
    consecutiveAutoApprovals: () => consecutiveAuto,
    history: () => Object.freeze([...ledger]),
    clear() {
      ledger.length = 0
      consecutiveAuto = 0
    },
  }
}
