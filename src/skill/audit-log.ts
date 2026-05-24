/**
 * Skill install audit log (ADR-0134 §3 — "Audit trail" invariant).
 *
 * Append-only JSONL at `<repo>/.quanta/audit/skill-install.log`. Every admin
 * install/remove, every blocked user attempt against a banned skill, and
 * every user attempt to disable an admin-installed skill is appended as one
 * timestamped record. The log is the compliance surface — enterprises rely
 * on it for "show me every time skill X was force-installed" queries.
 *
 * Closed-port:
 *  - {@link AuditClock}.now() returns Epoch ms (Date.now in production)
 *  - {@link AuditWriter}.append(path, line) is the single side-effect seam
 *
 * The default {@link nodeAuditWriter} uses node:fs/promises.appendFile +
 * ensures the parent dir exists. Tests inject a {@link memoryAuditWriter}
 * and assert the line contents directly — no tmpdir required.
 *
 * Immutability: this slice does NOT delete or rewrite existing lines. There
 * is no "rotate" or "compact" helper here by design — append-only is the
 * point. A host that wants log rotation operates on the file out-of-band.
 */

import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { SkillScope } from "./types"

/** Every event type the audit log records. */
export type AuditEvent =
  | "admin_install"
  | "admin_remove"
  | "admin_attempt_disable"
  | "banned_install_blocked"
  | "policy_load"
  | "policy_violation"

/** One log line, JSON-serialised. */
export interface AuditEntry {
  /** ISO 8601 timestamp (UTC) — derived from {@link AuditClock.now}. */
  readonly ts: string
  /** Monotonic sequence within a process — disambiguates same-ms events. */
  readonly seq: number
  /** Event type — see {@link AuditEvent}. */
  readonly event: AuditEvent
  /** Skill name (or "<n/a>" for policy_load). */
  readonly skillName: string
  /** Admin / org identifier (optional). */
  readonly admin?: string
  /** Acting user (optional — often unknown for batch installs). */
  readonly user?: string
  /** Scope of the skill (or attempted scope). */
  readonly scope?: SkillScope
  /** Free-form note (e.g. "disable attempt blocked"). */
  readonly note?: string
}

/** Injectable clock — {@link Date.now} in production, deterministic in tests. */
export interface AuditClock {
  now(): number
}

/** Default clock — {@link Date.now}. */
export const systemAuditClock: AuditClock = { now: () => Date.now() }

/** Injectable writer — appendFile(path, line) in production. */
export interface AuditWriter {
  append(path: string, line: string): Promise<void>
}

/** Default writer — ensures the parent dir exists then appendFile. */
export const nodeAuditWriter: AuditWriter = {
  append: async (path, line) => {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, line, "utf8")
  },
}

/** In-memory writer — testing seam. The {@link lines} field is a public
 *  buffer the test asserts against. */
export interface MemoryAuditWriter extends AuditWriter {
  readonly lines: string[]
}

/** Factory for the in-memory writer (one buffer per call so tests are isolated). */
export const memoryAuditWriter = (): MemoryAuditWriter => {
  const lines: string[] = []
  return {
    lines,
    append: async (_path, line) => {
      lines.push(line)
    },
  }
}

/**
 * Compute the canonical audit log path for a repo. ADR-0134 §3 fixes the
 * location at `<repo>/.quanta/audit/skill-install.log`.
 */
export const auditLogPathFor = (repoRoot: string): string =>
  join(repoRoot, ".quanta", "audit", "skill-install.log")

/** Per-process monotonic seq counter. Tied to module identity which is fine
 *  for the "two events in the same ms" disambiguation case the seq exists
 *  for. Tests that need a deterministic seq can call {@link resetAuditSeqForTesting}. */
let _seq = 0

/** Reset the monotonic seq counter — test seam ONLY. */
export const resetAuditSeqForTesting = (): void => {
  _seq = 0
}

/** Build one {@link AuditEntry} from caller-supplied event data + injected clock. */
export const buildAuditEntry = (
  event: Omit<AuditEntry, "ts" | "seq">,
  clock: AuditClock,
): AuditEntry => {
  _seq += 1
  return {
    ts: new Date(clock.now()).toISOString(),
    seq: _seq,
    ...event,
  }
}

/**
 * Append one audit entry to the log file. Deliberately one-shot: callers
 * that emit many entries should call this in a loop rather than batch
 * (each line ⇒ one fsync-friendly atomic appendFile call).
 *
 * The clock + writer are injected so unit tests can assert byte-identical
 * output without touching the filesystem (see {@link memoryAuditWriter}).
 */
export const appendAuditEntry = async (opts: {
  logPath: string
  event: Omit<AuditEntry, "ts" | "seq">
  clock?: AuditClock
  writer?: AuditWriter
}): Promise<AuditEntry> => {
  const clock = opts.clock ?? systemAuditClock
  const writer = opts.writer ?? nodeAuditWriter
  const entry = buildAuditEntry(opts.event, clock)
  await writer.append(opts.logPath, `${JSON.stringify(entry)}\n`)
  return entry
}
