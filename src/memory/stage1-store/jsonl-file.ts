/**
 * ADR-0207 — JSONL-file `Stage1OutputsStore`.
 *
 * Append-only one-line JSON to `~/.quanta/memory/stage1.jsonl`
 * (configurable via `opts.filePath`). On construction the file is
 * read and replayed into an in-memory map; corrupted lines (parse
 * failure or shape-guard rejection) are SKIPPED with a single
 * warning per line via the injected logger (default no-op) and
 * never throw.
 *
 * Durability tier: best-effort. No fsync; `prune` does NOT rewrite
 * the file in-place (no compaction). The in-memory hydrated map is
 * the source of truth post-construction; the on-disk log is the
 * crash-recovery seed.
 *
 * Security: the directory is created with mode `0700`; the file is
 * created with mode `0600`. Existing files have their mode set to
 * `0600` on construction so a previously-permissive file gets
 * tightened.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { InMemoryStage1Store } from "./in-memory"
import type { Stage1ListFilter, Stage1OutputsStore, Stage1PruneOpts } from "./port"
import type { Stage1Entry } from "./types"

/** No-op warning sink. Replace via opts.onWarn for visibility. */
const defaultOnWarn = (_msg: string): void => {
  /* swallow — opt-in observability via opts.onWarn */
}

const isStage1Entry = (v: unknown): v is Stage1Entry => {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  if (typeof r.threadId !== "string" || r.threadId.length === 0) return false
  if (typeof r.sourceUpdatedAt !== "number") return false
  if (typeof r.rawMemory !== "string") return false
  if (typeof r.rolloutSummary !== "string") return false
  if (typeof r.generatedAt !== "number") return false
  if (typeof r.rolloutSlug !== "string") return false
  if (typeof r.usageCount !== "number") return false
  if (typeof r.lastUsage !== "number") return false
  if (typeof r.selectedForPhase2 !== "boolean") return false
  if (
    r.selectedForPhase2SourceUpdatedAt !== undefined &&
    typeof r.selectedForPhase2SourceUpdatedAt !== "number"
  ) {
    return false
  }
  return true
}

type Op =
  | { op: "put"; entry: Stage1Entry }
  | { op: "touch"; threadId: string; lastUsage: number; usageCount: number }
  | { op: "mark"; threadId: string; sourceUpdatedAt: number }

const isOp = (v: unknown): v is Op => {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  if (r.op === "put") return isStage1Entry(r.entry)
  if (r.op === "touch") {
    return (
      typeof r.threadId === "string" &&
      typeof r.lastUsage === "number" &&
      typeof r.usageCount === "number"
    )
  }
  if (r.op === "mark") {
    return typeof r.threadId === "string" && typeof r.sourceUpdatedAt === "number"
  }
  return false
}

export interface JsonlFileStage1StoreOpts {
  readonly filePath: string
  readonly now: () => number
  readonly onWarn?: (msg: string) => void
}

export class JsonlFileStage1Store implements Stage1OutputsStore {
  private readonly inner: InMemoryStage1Store
  private readonly filePath: string
  private readonly onWarn: (msg: string) => void

  constructor(opts: JsonlFileStage1StoreOpts) {
    this.filePath = opts.filePath
    this.onWarn = opts.onWarn ?? defaultOnWarn
    this.inner = new InMemoryStage1Store({ now: opts.now })

    // Ensure parent dir exists at 0700 and tighten any existing file.
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    if (existsSync(this.filePath)) {
      try {
        chmodSync(this.filePath, 0o600)
      } catch (e) {
        this.onWarn(`stage1-store: chmod 0600 failed for ${this.filePath}: ${String(e)}`)
      }
      this.hydrate()
    }
  }

  private hydrate(): void {
    const text = readFileSync(this.filePath, "utf8")
    const lines = text.split("\n")
    for (const line of lines) {
      if (line === "") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        this.onWarn(`stage1-store: skipped corrupted JSON line: ${line.slice(0, 80)}`)
        continue
      }
      if (!isOp(parsed)) {
        this.onWarn(`stage1-store: skipped shape-invalid line: ${line.slice(0, 80)}`)
        continue
      }
      // Replay the op into the in-memory store without re-appending to
      // disk (replay is read-side only).
      this.replay(parsed)
    }
  }

  private replay(op: Op): void {
    if (op.op === "put") {
      this.inner.put(op.entry)
      return
    }
    if (op.op === "touch") {
      const cur = this.inner.get(op.threadId)
      if (!cur) return
      // Reconstruct exact post-touch state from the recorded values
      // (do NOT advance the clock during replay).
      this.inner.put({ ...cur, usageCount: op.usageCount, lastUsage: op.lastUsage })
      return
    }
    if (op.op === "mark") {
      const cur = this.inner.get(op.threadId)
      if (!cur) return
      this.inner.put({
        ...cur,
        selectedForPhase2: true,
        selectedForPhase2SourceUpdatedAt: op.sourceUpdatedAt,
      })
      return
    }
  }

  private append(op: Op): void {
    const line = `${JSON.stringify(op)}\n`
    // First write creates the file at 0600 via flag "a" + mode; on
    // existing files mode is a no-op but harmless.
    appendFileSync(this.filePath, line, { mode: 0o600 })
    // Tighten mode in case the file already existed with a wider mode
    // and the chmod in constructor was a no-op (race-safe; cheap).
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      /* swallow — best-effort */
    }
  }

  get(threadId: string): Stage1Entry | null {
    return this.inner.get(threadId)
  }

  put(entry: Stage1Entry): void {
    this.inner.put(entry)
    this.append({ op: "put", entry })
  }

  touch(threadId: string): void {
    this.inner.touch(threadId)
    const post = this.inner.get(threadId)
    if (!post) return // no-op replay
    this.append({
      op: "touch",
      threadId,
      lastUsage: post.lastUsage,
      usageCount: post.usageCount,
    })
  }

  markSelectedForPhase2(threadId: string, sourceUpdatedAt: number): void {
    this.inner.markSelectedForPhase2(threadId, sourceUpdatedAt)
    const post = this.inner.get(threadId)
    if (!post) return
    this.append({ op: "mark", threadId, sourceUpdatedAt })
  }

  list(filter?: Stage1ListFilter): readonly Stage1Entry[] {
    return this.inner.list(filter)
  }

  prune(opts: Stage1PruneOpts): number {
    // No on-disk compaction (per ADR-0207 §Decision). The hydrated map
    // is the source of truth after construction; the log keeps growing
    // until a future compaction pass.
    return this.inner.prune(opts)
  }
}
