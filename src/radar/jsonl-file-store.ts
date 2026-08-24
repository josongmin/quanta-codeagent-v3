/**
 * JSONL-file `RadarStore` (ADR-0231).
 *
 * Append-only one-line JSON ops to `~/.quanta/radar/cards.jsonl`
 * (configurable via `opts.filePath`). On construction the file is read
 * and replayed into an `InMemoryRadarStore`; corrupted lines (parse
 * failure or shape-guard rejection) are SKIPPED with a single warning
 * per line via the injected logger (default no-op) and never throw.
 *
 * Durability tier: best-effort. No fsync; `prune` does NOT rewrite the
 * file (no compaction — future ADR). The in-memory hydrated map is the
 * source of truth post-construction; the on-disk log is the crash-
 * recovery seed.
 *
 * Security: the directory is created with mode `0700`; the file is
 * created with mode `0600`. Existing files have their mode set to
 * `0600` on construction and on every append so a previously-permissive
 * file gets tightened. Mirrors `Stage1OutputsStore` (ADR-0207).
 *
 * Replay correctness: hydrate runs ONCE in the constructor under a
 * private `replaying = true` flag. Public-API methods short-circuit
 * `append()` when the flag is set, so replay does NOT double-write the
 * log. Card ids are preserved across reload by replaying `propose` ops
 * with a transient `mintId` that drains the recorded-id queue.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { errMessage, omitUndef, type Result } from "@/shared"
import { InMemoryRadarStore } from "./in-memory-store"
import type { RadarOpError, RadarStore } from "./port"
import type { BugFixProposalMetadata, CardKind, CardStatus, ProposeOpts, RadarCard } from "./types"

/** No-op warning sink. Replace via opts.onWarn for visibility. */
const defaultOnWarn = (_msg: string): void => {
  /* swallow — opt-in observability via opts.onWarn */
}

const KNOWN_KINDS: readonly CardKind[] = ["suggestion", "warning", "next-step", "bug-fix"]
const KNOWN_STATUSES: readonly CardStatus[] = ["active", "adopted", "dismissed", "expired"]

const isCardKind = (v: unknown): v is CardKind =>
  typeof v === "string" && (KNOWN_KINDS as readonly string[]).includes(v)

const isCardStatus = (v: unknown): v is CardStatus =>
  typeof v === "string" && (KNOWN_STATUSES as readonly string[]).includes(v)

const isBugFixMetadata = (v: unknown): v is BugFixProposalMetadata => {
  if (typeof v !== "object" || v === null) return false
  const b = v as Record<string, unknown>
  return (
    typeof b.errorSummary === "string" &&
    typeof b.file === "string" &&
    typeof b.line === "number" &&
    Array.isArray(b.hypothesisRanked) &&
    b.hypothesisRanked.every(
      (h) =>
        typeof h === "object" &&
        h !== null &&
        typeof (h as Record<string, unknown>).cause === "string" &&
        typeof (h as Record<string, unknown>).fix === "string" &&
        (["high", "medium", "low"] as const).includes(
          (h as Record<string, unknown>).confidence as "high" | "medium" | "low",
        ),
    ) &&
    (b.verifyRail === undefined || typeof b.verifyRail === "string")
  )
}

/**
 * Whether a raw card's bug-fix metadata is coherent with its kind.
 *
 * A unit because these are two rules that only mean something together: a
 * `bug-fix` card MUST carry the metadata, and ANY card that carries it must
 * carry a well-formed one. Together they say a non-bug-fix card may omit the
 * block but may never fake it.
 */
const hasCoherentBugFixMetadata = (r: Record<string, unknown>): boolean => {
  if (r.kind === "bug-fix" && !isBugFixMetadata(r.bugFix)) return false
  return r.bugFix === undefined || isBugFixMetadata(r.bugFix)
}

const isRadarCard = (v: unknown): v is RadarCard => {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  if (typeof r.id !== "string" || r.id.length === 0) return false
  if (!isCardKind(r.kind)) return false
  if (typeof r.title !== "string") return false
  if (typeof r.description !== "string") return false
  if (r.sessionId !== undefined && typeof r.sessionId !== "string") return false
  if (typeof r.createdAtMs !== "number") return false
  if (!isCardStatus(r.status)) return false
  if (typeof r.engagementCount !== "number") return false
  return hasCoherentBugFixMetadata(r)
}

type Op =
  | { op: "propose"; card: RadarCard }
  | { op: "setStatus"; id: string; status: CardStatus }
  | { op: "recordEngagement"; id: string }

const isOp = (v: unknown): v is Op => {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  if (r.op === "propose") return isRadarCard(r.card)
  if (r.op === "setStatus") {
    return typeof r.id === "string" && isCardStatus(r.status)
  }
  if (r.op === "recordEngagement") return typeof r.id === "string"
  return false
}

export interface JsonlFileRadarStoreOpts {
  readonly filePath: string
  readonly cap?: number
  readonly mintId?: () => string
  readonly onWarn?: (msg: string) => void
}

export class JsonlFileRadarStore implements RadarStore {
  private readonly inner: InMemoryRadarStore
  private readonly filePath: string
  private readonly onWarn: (msg: string) => void
  /** Drained during constructor replay; null afterwards. */
  private replayIds: string[] | null
  private replayIdsPtr = 0
  /** When true, public-API mutators do NOT append to disk. */
  private replaying = true
  /** Host-supplied id minter, consulted only AFTER the replay ids drain. */
  private readonly userMint: (() => string) | undefined
  /** Ids minted after replay drained — offset past `replayIds.length` so a
   *  post-replay id can never collide with a replayed one. */
  private postReplayCounter = 0

  constructor(opts: JsonlFileRadarStoreOpts) {
    this.filePath = opts.filePath
    this.onWarn = opts.onWarn ?? defaultOnWarn

    // Pre-scan the file to capture recorded ids in propose-order. This
    // lets the in-memory inner store mint the SAME ids during replay
    // (so post-hydration state is byte-identical to pre-crash).
    const { ops, recordedIds } = this.preScan()
    this.replayIds = recordedIds

    this.userMint = opts.mintId

    this.inner = new InMemoryRadarStore(
      omitUndef({ cap: opts.cap, mintId: (): string => this.nextCardId() }) as {
        cap?: number
        mintId?: () => string
      },
    )

    const dir = dirname(this.filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    if (existsSync(this.filePath)) {
      try {
        chmodSync(this.filePath, 0o600)
      } catch (e) {
        this.onWarn(`radar-store: chmod 0600 failed for ${this.filePath}: ${errMessage(e)}`)
      }
    }

    // Replay through the public API (which short-circuits append while
    // `this.replaying === true`).
    for (const op of ops) {
      this.replayOp(op)
    }

    // Replay drained — switch to live mode.
    this.replaying = false
    this.replayIds = null
  }

  /**
   * Mint the next card id.
   *
   * A unit because the ORDER here is the hydration contract: the recorded ids
   * are replayed in propose-order first — that is what makes post-hydration
   * state byte-identical to pre-crash — and only once they drain does the host
   * minter (or the store-scoped counter) take over.
   */
  private nextCardId(): string {
    if (this.replayIds && this.replayIdsPtr < this.replayIds.length) {
      const id = this.replayIds[this.replayIdsPtr]
      this.replayIdsPtr += 1
      return id ?? ""
    }
    if (this.userMint) return this.userMint()
    // Default deterministic counter, scoped to this store. Counts up
    // independently of `replayIdsPtr` so post-replay ids never collide
    // with one another.
    this.postReplayCounter += 1
    const drained = this.replayIds
    return `radar-card-${drained ? drained.length + this.postReplayCounter : this.postReplayCounter}`
  }

  /**
   * Re-apply one recorded op through the PUBLIC mutators.
   *
   * A unit because replay deliberately goes through the same API a live caller
   * uses — that is what makes the hydrated state provably the state those ops
   * produced — with `this.replaying` suppressing the re-append. Keeping the
   * op → mutator mapping in one place is what stops a newly-added op kind from
   * silently replaying as a no-op.
   */
  private replayOp(op: Op): void {
    if (op.op === "propose") {
      this.proposeCard({
        kind: op.card.kind,
        title: op.card.title,
        description: op.card.description,
        ...(op.card.sessionId !== undefined ? { sessionId: op.card.sessionId } : {}),
        createdAtMs: op.card.createdAtMs,
        ...(op.card.bugFix !== undefined ? { bugFix: op.card.bugFix } : {}),
      })
    } else if (op.op === "setStatus") {
      this.setStatus(op.id, op.status)
    } else if (op.op === "recordEngagement") {
      this.recordEngagement(op.id)
    }
  }

  private preScan(): { ops: Op[]; recordedIds: string[] } {
    const ops: Op[] = []
    const recordedIds: string[] = []
    if (!existsSync(this.filePath)) return { ops, recordedIds }
    const text = readFileSync(this.filePath, "utf8")
    for (const line of text.split("\n")) {
      if (line === "") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        this.onWarn(`radar-store: skipped corrupted JSON line: ${line.slice(0, 80)}`)
        continue
      }
      if (!isOp(parsed)) {
        this.onWarn(`radar-store: skipped shape-invalid line: ${line.slice(0, 80)}`)
        continue
      }
      ops.push(parsed)
      if (parsed.op === "propose") recordedIds.push(parsed.card.id)
    }
    return { ops, recordedIds }
  }

  private append(op: Op): void {
    if (this.replaying) return
    const line = `${JSON.stringify(op)}\n`
    appendFileSync(this.filePath, line, { mode: 0o600 })
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      /* swallow — best-effort */
    }
  }

  proposeCard(opts: ProposeOpts): RadarCard {
    const card = this.inner.proposeCard(opts)
    this.append({ op: "propose", card })
    return card
  }

  listActive(): readonly RadarCard[] {
    return this.inner.listActive()
  }

  setStatus(id: string, status: CardStatus): Result<RadarCard, RadarOpError> {
    const r = this.inner.setStatus(id, status)
    if (r.ok) this.append({ op: "setStatus", id, status })
    return r
  }

  recordEngagement(id: string): Result<RadarCard, RadarOpError> {
    const r = this.inner.recordEngagement(id)
    if (r.ok) this.append({ op: "recordEngagement", id })
    return r
  }

  prune(olderThanMs: number, now: number): number {
    // No on-disk compaction; expirations are derived state and can be
    // re-computed at any time. MVP keeps prune in-memory-only.
    return this.inner.prune(olderThanMs, now)
  }
}

// Note: this adapter delegates `setStatus` / `recordEngagement` to the
// inner in-memory store, which already produces the `Result` value. No
// direct `ok` / `err` construction is needed here.
