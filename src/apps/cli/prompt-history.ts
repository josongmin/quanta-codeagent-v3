/**
 * Bash-style prompt history for the CLI raw-line composer.
 *
 * Backed by a newline-delimited file (default `~/.quanta/history`). Reads are
 * synchronous on first construction (small file, ≤1000 lines by default);
 * writes are async fire-and-forget — `push()` returns immediately so the REPL
 * loop never blocks on disk.
 *
 * Default behavior is **default-OFF** at the surface boundary: only the REPL
 * entry wires history into `readLine()`. Construct via {@link createPromptHistory};
 * the caller (`apps/cli/repl.ts`) decides whether to instantiate one at all
 * based on `QUANTA_HISTORY`.
 *
 * Invariants
 * ----------
 *  - **Empty lines skipped** (matches bash `HISTCONTROL=ignorespace`).
 *  - **Consecutive duplicates suppressed** (matches bash `HISTCONTROL=ignoredups`).
 *  - **Ring buffer** capped at `maxLines` (oldest line evicted; FIFO).
 *  - **Silent disk failure** — any `EACCES` / `ENOSPC` / `ENOENT` is swallowed
 *    and history falls back to in-memory only. The REPL never crashes because
 *    `$HOME/.quanta` is read-only.
 *  - **Cursor model** — `prev()` walks backward toward older entries; `next()`
 *    walks forward toward newer entries (and past-end ⇒ `undefined` = restore
 *    the user's draft). `reset()` clears the cursor (call on new input start).
 *  - **Filter** — `prev/next(filter)` skip entries that don't start with
 *    `filter`. Matches the readline `history-search-backward` UX.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface PromptHistory {
  push(line: string): void
  prev(filter?: string): string | undefined
  next(filter?: string): string | undefined
  /** Find the most recent entry containing `query` (case-sensitive substring).
   *  Returns `undefined` when no match. Cursor moved to the matched entry so a
   *  follow-up `prev()` continues backward from there. */
  search(query: string): string | undefined
  /** Clear cursor — call on every fresh input start so the next `prev()`
   *  resumes from the newest entry. */
  reset(): void
  size(): number
  /** Test-only: synchronous snapshot of the ring buffer (oldest first). */
  __snapshot(): readonly string[]
}

export interface PromptHistoryOptions {
  /** Disk path. Default: `~/.quanta/history`. */
  filePath?: string
  /** Max lines kept. Default: 1000. */
  maxLines?: number
  /** Disable disk persistence (in-memory only, e.g. tests). */
  ephemeral?: boolean
}

const DEFAULT_PATH = (): string => join(homedir(), ".quanta", "history")
const DEFAULT_MAX = 1000

/** Synchronous bootstrap: read+normalize the file once on construction. We do
 *  this synchronously (via a fire-and-forget promise that resolves into the
 *  buffer) so the first `prev()` call hits a populated array. To keep the
 *  factory non-async we use a small "pending load" gate: prev/next/search no-op
 *  until the disk read settles, which on a 1000-line file is < 1 ms. */
const loadInitial = async (filePath: string, maxLines: number): Promise<string[]> => {
  try {
    const raw = await readFile(filePath, "utf8")
    const lines = raw.split("\n").filter((l) => l !== "")
    if (lines.length <= maxLines) return lines
    return lines.slice(lines.length - maxLines)
  } catch {
    return []
  }
}

export const createPromptHistory = (opts?: PromptHistoryOptions): PromptHistory => {
  const filePath = opts?.filePath ?? DEFAULT_PATH()
  const maxLines = opts?.maxLines ?? DEFAULT_MAX
  const ephemeral = opts?.ephemeral === true

  // Ring buffer; oldest first. `cursor === buf.length` ⇒ "past newest" (draft).
  let buf: string[] = []
  let cursor = -1 // -1 ⇒ no navigation in progress
  let loaded = ephemeral

  if (!ephemeral) {
    void loadInitial(filePath, maxLines).then((lines) => {
      // If the user already pushed during the load window, prepend disk lines
      // so the in-memory ones (newer) win the duplicate-suppress check.
      buf = [...lines, ...buf]
      loaded = true
    })
  }

  // Fire-and-forget append. Errors are swallowed (silent fallback to in-mem).
  // We track an in-flight queue so the test ephemeral path can stay sync.
  const writeQueue = { tail: Promise.resolve() }
  const persist = (line: string): void => {
    if (ephemeral) return
    writeQueue.tail = writeQueue.tail
      .then(async () => {
        try {
          await mkdir(dirname(filePath), { recursive: true })
          await appendFile(filePath, `${line}\n`, "utf8")
        } catch {
          /* silent — disk failure is non-fatal */
        }
      })
      .catch(() => undefined)
  }

  const push: PromptHistory["push"] = (line) => {
    cursor = -1 // any push resets navigation
    if (line === "") return
    const last = buf[buf.length - 1]
    if (last === line) return // suppress consecutive duplicates
    buf.push(line)
    if (buf.length > maxLines) buf.shift()
    persist(line)
  }

  /** Walk from `start` toward 0, returning the index of the most recent entry
   *  matching `filter`. `filter` is a prefix match (empty filter ⇒ any). */
  const findPrev = (start: number, filter: string): number => {
    for (let i = start; i >= 0; i -= 1) {
      const entry = buf[i] ?? ""
      if (filter === "" || entry.startsWith(filter)) return i
    }
    return -1
  }

  const findNext = (start: number, filter: string): number => {
    for (let i = start; i < buf.length; i += 1) {
      const entry = buf[i] ?? ""
      if (filter === "" || entry.startsWith(filter)) return i
    }
    return -1
  }

  const prev: PromptHistory["prev"] = (filter) => {
    if (!loaded || buf.length === 0) return undefined
    const f = filter ?? ""
    const startFrom = cursor === -1 ? buf.length - 1 : cursor - 1
    if (startFrom < 0) return undefined
    const idx = findPrev(startFrom, f)
    if (idx < 0) return undefined
    cursor = idx
    return buf[idx]
  }

  const next: PromptHistory["next"] = (filter) => {
    if (!loaded || buf.length === 0 || cursor === -1) return undefined
    const f = filter ?? ""
    const idx = findNext(cursor + 1, f)
    if (idx < 0) {
      cursor = -1 // walked past newest — restore draft
      return undefined
    }
    cursor = idx
    return buf[idx]
  }

  const search: PromptHistory["search"] = (query) => {
    if (!loaded || buf.length === 0 || query === "") return undefined
    const startFrom = cursor === -1 ? buf.length - 1 : cursor - 1
    for (let i = startFrom; i >= 0; i -= 1) {
      const entry = buf[i] ?? ""
      if (entry.includes(query)) {
        cursor = i
        return entry
      }
    }
    return undefined
  }

  const reset = (): void => {
    cursor = -1
  }

  const size = (): number => buf.length

  const __snapshot = (): readonly string[] => buf.slice()

  return { push, prev, next, search, reset, size, __snapshot }
}

/** Test-only synchronous variant for unit tests: constructs an ephemeral
 *  history and seeds it with `seed` entries (preserving order). Mirrors the
 *  bash file-load path without touching the disk. */
export const __createSeededHistoryForTest = (seed: readonly string[]): PromptHistory => {
  const h = createPromptHistory({ ephemeral: true })
  for (const line of seed) h.push(line)
  return h
}
