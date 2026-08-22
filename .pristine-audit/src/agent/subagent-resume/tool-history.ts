/**
 * Tool call envelope + JSONL store (ADR-0174 Phase 3).
 *
 * One {@link ToolCallRecord} per tool invocation. Persisted append-only so a
 * subagent that survives across a process restart can replay its tool history
 * deterministically (cache-the-output — Option A; matches OpenHands EventStream
 * / Aider git / Cursor BackgroundComposer / Claude Code `--resume` / Codex
 * `function_call_output`).
 *
 * Layout (mirrors `subagent-persistence-store/jsonl-store.ts`):
 *
 *     <baseDir>/<workspaceHash>/<handleId>.tool-history.jsonl
 *
 * The `.tool-history.jsonl` suffix is DISTINCT from the persistence store's
 * `.jsonl` so a single workspace dir holds BOTH artifacts side-by-side without
 * a glob collision. Crash safety: torn writes on the final newline leave the
 * prior lines intact (POSIX `O_APPEND` semantics for writes <= PIPE_BUF).
 *
 * Plane-clean: imports ONLY `node:fs/promises` + `node:path` + `node:os` +
 * `node:crypto` + `./idempotency` (sibling type). No `@/agent/loop`,
 * `@/agent/dispatch`, `@/llm`, `@/permission`, `@/tool`.
 *
 * NO-THROW on read paths:
 *   - list of unknown handle  ⇒ `[]`
 *   - byToolUseId(unknown)    ⇒ `null`
 *   - clear(unknown)          ⇒ `0`
 *   - parse failure of one line ⇒ skipped (bottom-up walker — same crash-safety
 *     posture as persistence-store's `readLatestHandle`).
 * Write path throws on disk failure (mirror `PersistenceError("io-failed")`)
 * so callers see real disk problems instead of silent data loss.
 */

import { createHash } from "node:crypto"
import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { errMessage } from "@/shared"
import type { IdempotencyTier } from "./idempotency"

/** One captured tool call. ALWAYS append-only — successive calls add new
 *  records; no record is ever rewritten. */
export interface ToolCallRecord {
  /** Caller's tool-use id (matches the LLM's `tool_use_id` echo). Unique per
   *  call within a handle. */
  readonly toolUseId: string
  /** Tool name — joins against {@link IdempotencyClassifier}. */
  readonly toolName: string
  /** SHA-256 of `JSON.stringify(args)`, first 16 hex chars. Stable so a
   *  caller can detect args drift between persisted and re-issued calls. */
  readonly argsHash: string
  /** Captured tool result (already redacted/truncated by the recording-side
   *  observer; this slice is dumb storage). */
  readonly result: { readonly ok: boolean; readonly output: string }
  /** Tier the classifier returned at record time. Persisting it (rather than
   *  re-classifying on read) lets the policy decide deterministically even if
   *  the table evolves between record + replay. */
  readonly tier: IdempotencyTier
  /** Epoch ms when the tool started. */
  readonly tsBefore: number
  /** Epoch ms when the tool finished. */
  readonly tsAfter: number
  /** Shadow ODB commit SHA captured RIGHT AFTER the call (mutating tiers
   *  only). Absent for pure-tier rows — pure tools do not mutate workspace,
   *  so there is nothing to anchor. */
  readonly shadowCommit?: string
  /** Workspace fingerprint at record time. The replay-orchestrator asserts
   *  this matches the resume workspace before applying cached output. */
  readonly workspace: string
  /** Marker bit set when a PII / secrets filter rewrote `result.output`
   *  before persistence. Cosmetic — surfaces in audit but does not change
   *  replay decisions. */
  readonly sensitiveRedacted?: boolean
}

/** Closed port. JSONL adapter is the default; tests inject in-memory fakes. */
export interface ToolHistoryStore {
  /** Append a new record under `handleId`. NEVER rewrites existing lines —
   *  pure append. Throws on disk failure. */
  append(handleId: string, record: ToolCallRecord): Promise<void>
  /** Enumerate all records for `handleId` in insertion order (oldest first).
   *  Unknown handle ⇒ `[]`. Corrupt lines are SKIPPED (NOT aborted). */
  list(handleId: string): Promise<ReadonlyArray<ToolCallRecord>>
  /** Look up the record for a specific `toolUseId` under `handleId`. Returns
   *  `null` when not present. If a `toolUseId` somehow appears twice (caller
   *  bug — we don't enforce uniqueness on append), returns the LAST entry. */
  byToolUseId(handleId: string, toolUseId: string): Promise<ToolCallRecord | null>
  /** Drop the history file for `handleId`. Returns count of records that
   *  WERE in the file before deletion (0 when unknown). Idempotent. */
  clear(handleId: string): Promise<number>
}

/** Tunables. Layout intentionally mirrors `JsonlStoreOpts`. */
export interface JsonlToolHistoryStoreOpts {
  /** Base directory. Default `~/.quanta/scheduler-tool-history/`. */
  readonly baseDir?: string
  /** Workspace hash function. Default SHA-256 first 16 hex (shadow-odb /
   *  persistence-store parity — same key joins across all 3 stores). */
  readonly workspaceHasher?: (workspace: string) => string
}

/* ------------------------------------------------------------------ */
/* path helpers                                                        */
/* ------------------------------------------------------------------ */

const WORKSPACE_HASH_PREFIX_LEN = 16

const defaultWorkspaceHash = (workspace: string): string => {
  if (workspace.length === 0) {
    return "0".repeat(WORKSPACE_HASH_PREFIX_LEN)
  }
  const canonical =
    workspace.endsWith("/") && workspace.length > 1 ? workspace.slice(0, -1) : workspace
  const h = createHash("sha256")
  h.update(canonical, "utf8")
  return h.digest("hex").slice(0, WORKSPACE_HASH_PREFIX_LEN)
}

const resolveBaseDir = (opts: JsonlToolHistoryStoreOpts | undefined): string => {
  if (opts?.baseDir !== undefined && opts.baseDir.length > 0) return opts.baseDir
  const home = homedir()
  return join(home, ".quanta", "scheduler-tool-history")
}

const workspaceDir = (baseDir: string, hasher: (w: string) => string, workspace: string): string =>
  join(baseDir, hasher(workspace))

const handleFile = (workspaceDirPath: string, id: string): string => {
  const sanitized = id.replace(/[\\/]/g, "_")
  return join(workspaceDirPath, `${sanitized}.tool-history.jsonl`)
}

/* ------------------------------------------------------------------ */
/* hash                                                                */
/* ------------------------------------------------------------------ */

/** Stable hash of a tool args payload. Caller passes already-serializable
 *  args (the args the model produced). 16-hex chars matches workspace-hash
 *  policy so audits can grep for known prefixes. */
export const hashToolArgs = (args: unknown): string => {
  const h = createHash("sha256")
  // Stringify defensively — circular refs throw, which is a programmer bug
  // worth surfacing rather than swallowing.
  h.update(JSON.stringify(args ?? null), "utf8")
  return h.digest("hex").slice(0, 16)
}

/* ------------------------------------------------------------------ */
/* parse                                                               */
/* ------------------------------------------------------------------ */

const isTier = (s: unknown): s is IdempotencyTier =>
  s === "pure" || s === "mutating-recoverable" || s === "mutating-external"

const parseRecord = (raw: unknown): ToolCallRecord | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const r = raw as Partial<ToolCallRecord>
  if (typeof r.toolUseId !== "string") return undefined
  if (typeof r.toolName !== "string") return undefined
  if (typeof r.argsHash !== "string") return undefined
  if (typeof r.workspace !== "string") return undefined
  if (typeof r.tsBefore !== "number") return undefined
  if (typeof r.tsAfter !== "number") return undefined
  if (!isTier(r.tier)) return undefined
  const result = r.result
  if (typeof result !== "object" || result === null) return undefined
  const res = result as Partial<ToolCallRecord["result"]>
  if (typeof res.ok !== "boolean") return undefined
  if (typeof res.output !== "string") return undefined

  return {
    toolUseId: r.toolUseId,
    toolName: r.toolName,
    argsHash: r.argsHash,
    result: { ok: res.ok, output: res.output },
    tier: r.tier,
    tsBefore: r.tsBefore,
    tsAfter: r.tsAfter,
    workspace: r.workspace,
    ...(typeof r.shadowCommit === "string" ? { shadowCommit: r.shadowCommit } : {}),
    ...(typeof r.sensitiveRedacted === "boolean" ? { sensitiveRedacted: r.sensitiveRedacted } : {}),
  }
}

/** Read every record in `path`. ENOENT ⇒ `[]`. Garbage lines are SKIPPED
 *  (NOT aborted) — torn-write recovery: a half-written final line is silently
 *  dropped, the prior lines remain intact. */
const readAllRecords = async (path: string): Promise<ToolCallRecord[]> => {
  let body: string
  try {
    body = await readFile(path, "utf8")
  } catch (e: unknown) {
    if ((e as { code?: string } | null)?.code === "ENOENT") return []
    throw new Error(`tool-history readFile ${path}: ${errMessage(e)}`)
  }
  const out: ToolCallRecord[] = []
  for (const rawLine of body.split("\n")) {
    const trimmed = rawLine.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Torn / garbage line — skip, do not abort.
      continue
    }
    const rec = parseRecord(parsed)
    if (rec === undefined) continue
    out.push(rec)
  }
  return out
}

/** Locate the handle file across ALL workspace dirs under `baseDir`. Used by
 *  list/clear/byToolUseId which receive only the handle id. */
const findHistoryFileAcrossWorkspaces = async (
  baseDir: string,
  id: string,
): Promise<string | undefined> => {
  let workspaceDirs: string[]
  try {
    workspaceDirs = await readdir(baseDir)
  } catch (e: unknown) {
    if ((e as { code?: string } | null)?.code === "ENOENT") return undefined
    throw new Error(`tool-history readdir base: ${errMessage(e)}`)
  }
  for (const wsd of workspaceDirs) {
    const candidate = handleFile(join(baseDir, wsd), id)
    try {
      await readFile(candidate, "utf8")
      return candidate
    } catch (e: unknown) {
      const code = (e as { code?: string } | null)?.code
      if (code === "ENOENT") continue
      throw new Error(`tool-history probe ${candidate}: ${errMessage(e)}`)
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* factory                                                             */
/* ------------------------------------------------------------------ */

export const defaultJsonlToolHistoryStore = (
  opts?: JsonlToolHistoryStoreOpts,
): ToolHistoryStore => {
  const baseDir = resolveBaseDir(opts)
  const hasher = opts?.workspaceHasher ?? defaultWorkspaceHash

  const fileForAppend = (handleId: string, workspace: string): string => {
    const wsDir = workspaceDir(baseDir, hasher, workspace)
    return handleFile(wsDir, handleId)
  }

  return {
    async append(handleId, record) {
      const target = fileForAppend(handleId, record.workspace)
      try {
        await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true })
        const line = `${JSON.stringify(record)}\n`
        await appendFile(target, line, "utf8")
      } catch (e: unknown) {
        throw new Error(`tool-history append ${handleId}: ${errMessage(e)}`)
      }
    },

    async list(handleId) {
      const path = await findHistoryFileAcrossWorkspaces(baseDir, handleId)
      if (path === undefined) return []
      return await readAllRecords(path)
    },

    async byToolUseId(handleId, toolUseId) {
      const records = await this.list(handleId)
      // Last-wins on duplicate ids (caller's append bug; we tolerate).
      let found: ToolCallRecord | null = null
      for (const r of records) {
        if (r.toolUseId === toolUseId) found = r
      }
      return found
    },

    async clear(handleId) {
      const path = await findHistoryFileAcrossWorkspaces(baseDir, handleId)
      if (path === undefined) return 0
      const before = await readAllRecords(path)
      try {
        await rm(path, { force: true })
      } catch (e: unknown) {
        throw new Error(`tool-history rm ${path}: ${errMessage(e)}`)
      }
      return before.length
    },
  }
}
