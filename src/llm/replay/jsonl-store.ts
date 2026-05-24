/**
 * JSONL-backed `ReplayStore` (ADR-0192).
 *
 * Why JSONL: git-friendly (one line = one call, clean diffs), grep-friendly
 * (`rg "tool_use_start"` across a cassette), and append-only at the disk
 * level (a recording can be inspected mid-run). SQLite would buy us indexed
 * lookups, but cassettes rarely exceed a few hundred lines and an in-memory
 * filter is O(n) on a small n.
 *
 * Hash strategy — sorted-key JSON.stringify + SHA-256 (first 16 hex):
 *  - `JSON.stringify` is unstable under arbitrary object key order; we recurse
 *    + sort every object's keys so two equal-shaped requests collide.
 *  - 16 hex chars = 64 bits ⇒ ~10^9 records before a 50 % collision (we expect
 *    ≤10^4 per cassette). Plenty of headroom, half the bytes of full hex.
 *  - Per-policy salt prefix (`exact:` / `messages-only:` / `fuzzy-content:`)
 *    keeps the three hash spaces disjoint so a policy switch never produces a
 *    spurious hit.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname } from "node:path"
import type { Message, StreamInput } from "../types"
import type {
  MatchPolicy,
  RecordedInteraction,
  ReplayMatchOpts,
  ReplayStore,
} from "./types"

export interface JsonlReplayStoreOpts {
  /** Absolute path to the `.jsonl` cassette. Parent dir is created on demand. */
  readonly path: string
  /** Default match policy when callers don't override per-call. */
  readonly defaultPolicy?: MatchPolicy
  /** Override the request → hash function. Default: stable sorted-key JSON →
   *  SHA-256 → first 16 hex chars, salted by policy. Test doubles can replace
   *  this with a deterministic identity to make collisions inspectable. */
  readonly hashRequest?: (req: StreamInput, policy: MatchPolicy) => string
  /** Invoked once per malformed JSONL line during `load`. No-op by default
   *  (the `noConsole` rule forbids logging here; surfaces wire their own
   *  reporter). */
  readonly onMalformed?: (line: string, error: Error) => void
}

/**
 * Stable JSON: recursively sort object keys so two structurally equal values
 * serialize to the same string regardless of insertion order. Arrays preserve
 * order (significant in `messages[]`).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const k of keys) {
    const v = obj[k]
    if (v === undefined) continue
    parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`)
  }
  return `{${parts.join(",")}}`
}

/** Strip whitespace runs to a single space, trim ends — fuzzy hash helper. */
function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

function extractMessagesPayload(messages: ReadonlyArray<Message>): unknown {
  return messages.map((m) => ({ role: m.role, content: m.content }))
}

function extractFuzzyPayload(messages: ReadonlyArray<Message>): string {
  const out: string[] = []
  for (const m of messages) {
    out.push(m.role, ":")
    for (const block of m.content) {
      if (block.type === "text") out.push(normalizeText(block.text))
      else if (block.type === "tool_use") out.push(`tool_use:${block.name}`)
      else if (block.type === "tool_result") out.push(`tool_result:${normalizeText(block.content)}`)
      else if (block.type === "thinking") out.push(`thinking:${normalizeText(block.thinking)}`)
      else if (block.type === "image") out.push(`image:${block.mediaType}`)
      else if (block.type === "document") out.push(`doc:${block.mediaType}`)
    }
    out.push("|")
  }
  return out.join(" ")
}

function defaultHashRequest(req: StreamInput, policy: MatchPolicy): string {
  let payload: string
  if (policy === "exact") {
    payload = stableStringify({
      messages: req.messages,
      system: req.system ?? null,
      tools: req.tools,
      thinking: req.thinking ?? null,
      toolChoice: req.toolChoice ?? null,
    })
  } else if (policy === "messages-only") {
    payload = stableStringify(extractMessagesPayload(req.messages))
  } else {
    payload = extractFuzzyPayload(req.messages)
  }
  return createHash("sha256").update(`${policy}:${payload}`).digest("hex").slice(0, 16)
}

export function jsonlReplayStore(opts: JsonlReplayStoreOpts): ReplayStore {
  const hashFn = opts.hashRequest ?? defaultHashRequest
  const defaultPolicy: MatchPolicy = opts.defaultPolicy ?? "exact"

  let cached: RecordedInteraction[] | null = null
  const used = new Set<number>() // indexes into `cached`

  async function ensureLoaded(): Promise<RecordedInteraction[]> {
    if (cached !== null) return cached
    let raw: string
    try {
      raw = await readFile(opts.path, "utf-8")
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        cached = []
        return cached
      }
      throw err
    }
    const out: RecordedInteraction[] = []
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue
      try {
        out.push(JSON.parse(line) as RecordedInteraction)
      } catch (err) {
        opts.onMalformed?.(line, err as Error)
      }
    }
    cached = out
    return cached
  }

  async function ensureDir(): Promise<void> {
    await mkdir(dirname(opts.path), { recursive: true })
  }

  return {
    async append(record: RecordedInteraction): Promise<void> {
      await ensureDir()
      await appendFile(opts.path, `${JSON.stringify(record)}\n`, "utf-8")
      // Keep cache coherent so subsequent matches see the just-recorded entry.
      const list = await ensureLoaded()
      list.push(record)
    },
    async match(
      request: StreamInput,
      matchOpts?: ReplayMatchOpts,
    ): Promise<RecordedInteraction | null> {
      const policy: MatchPolicy = matchOpts?.policy ?? defaultPolicy
      const key = hashFn(request, policy)
      const list = await ensureLoaded()
      for (let i = 0; i < list.length; i++) {
        if (used.has(i)) continue
        const rec = list[i]
        if (rec === undefined) continue
        // Records on disk may have been hashed under a different policy; rehash
        // each candidate under the active policy so the lookup is policy-clean.
        const candidateKey = hashFn(rec.request, policy)
        if (candidateKey === key) {
          used.add(i)
          return rec
        }
      }
      return null
    },
    async load(): Promise<ReadonlyArray<RecordedInteraction>> {
      const list = await ensureLoaded()
      return list.slice()
    },
    async save(records: ReadonlyArray<RecordedInteraction>): Promise<void> {
      await ensureDir()
      const body = records.map((r) => JSON.stringify(r)).join("\n")
      await writeFile(opts.path, records.length === 0 ? "" : `${body}\n`, "utf-8")
      cached = records.slice()
      used.clear()
    },
    reset(): void {
      used.clear()
    },
  }
}

/** Exported for tests + advanced callers (e.g. tooling that pre-computes ids). */
export { defaultHashRequest, stableStringify }
