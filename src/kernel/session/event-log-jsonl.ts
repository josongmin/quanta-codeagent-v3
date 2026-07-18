import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"
import {
  decodeSessionEvent,
  encodeSessionEvent,
  type SessionEvent,
  SessionProtocolValidationError,
} from "@/protocol/session"
import { errMessage } from "@/shared"
import type { KernelEventLogPort } from "./ports"

/**
 * W4-b (ADR-0540 Wave 2 item 0) — on-disk, append-only JSONL implementation of
 * {@link KernelEventLogPort}. One file per session (`<dir>/<sessionId>.jsonl`),
 * one event per line, each line being EXACTLY the `@/protocol/session` codec's
 * `encodeSessionEvent` envelope (no private format — a reader is
 * `decodeSessionEvent` per line, which is what open() below does).
 *
 * PURPOSE. The replay substrate for wire `connect({resume})` (transport-unified
 * SDK ticket 05): the log survives a process restart, `tip()` lets the kernel
 * RESUME seq issuance from the on-disk high-water mark (continuity — without it
 * resume semantics are undefined), and `readFrom(afterSeq)` is the bridge's
 * replay feed. `tip`/`readFrom`/`close` are IMPLEMENTATION surface, not port
 * surface — ticket 05 owns their wire consumption; the seq-continuity seam in
 * `@/sdk/runtime` discovers them via {@link isDurableSessionEventLog}.
 *
 * DURABILITY (v1 policy). Every append is a single `writeSync(2)` of
 * `line + "\n"` on a persistent O_APPEND fd — no userspace buffering, so an
 * acknowledged append survives a PROCESS crash. `fsync(2)` is deliberately NOT
 * issued per append: power-loss / OS-crash durability is deferred to ticket 05
 * consumption work (candidate: fdatasync batching or checkpoint-scoped syncs).
 * A crash can therefore tear at most the FINAL line, which open() recovers.
 *
 * RECOVERY (open-time scan, crash-model precise):
 *   - torn FINAL line (unterminated + JSON.parse fails — the only shape a
 *     single interrupted `write(2)` prefix can take): skip + warn + TRUNCATE
 *     the torn bytes so the next append lands on a clean line boundary.
 *   - unterminated final line that DECODES (the tear ate only the trailing
 *     `\n`): keep the event, repair the newline before the next append.
 *   - corruption anywhere else (mid-file garbage, terminated-but-invalid final
 *     line, parseable-JSON-but-invalid envelope): FAIL LOUD — none of these can
 *     come from this writer's crash model (a proper prefix of a JSON object
 *     never balances its braces), so tolerating them would be silent data loss.
 *
 * SINGLE WRITER. A sidecar `<file>.lock` (atomic hardlink create) holding the
 * owner pid guards double-open — same-process AND cross-process. A lock owned
 * by a DEAD pid (crash restart) is reclaimed with a warning; unreadable lock
 * content fails CLOSED (never steal). Callers own `close()` (the SDK runtime
 * session releases its injected log on session close). Known v1 limitation,
 * accepted: an OS-recycled pid can hold a stale lock hostage until the file is
 * removed by hand — vanishingly rare for a per-session file, documented here
 * rather than engineered around.
 */

export class JsonlSessionEventLogCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JsonlSessionEventLogCorruptionError"
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class JsonlSessionEventLogLockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JsonlSessionEventLogLockError"
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export interface JsonlSessionEventLogOptions {
  /** Directory holding the per-session `.jsonl` files (created recursively). */
  readonly dir: string
  /** Session id — becomes the file name, so it is charset-validated. */
  readonly sessionId: string
  /** Recovery/reclaim diagnostics sink. Defaults to a stderr line (matches the
   *  scheduler's `[kernel.session]` diagnostic style). Injectable for tests. */
  readonly warn?: (message: string) => void
}

/** The durable implementation surface ticket 05 consumes (port + tip/readFrom/
 *  close). The in-memory log implements NONE of these — which is exactly how
 *  the default-OFF path stays byte-identical. */
export interface DurableSessionEventLog extends KernelEventLogPort {
  /** Max event seq present in the log (high-water mark). Empty log ⇒ 0. */
  tip(): number
  /** Events with `seq > afterSeq`, in append order — the resume replay feed. */
  readFrom(afterSeq: number): SessionEvent[]
  /** Release the append fd + single-writer lock. Idempotent. */
  close(): void
}

export const isDurableSessionEventLog = (
  log: KernelEventLogPort,
): log is DurableSessionEventLog => {
  const candidate = log as Partial<DurableSessionEventLog>
  return (
    typeof candidate.tip === "function" &&
    typeof candidate.readFrom === "function" &&
    typeof candidate.close === "function"
  )
}

/** File-name safety: the session id becomes `<id>.jsonl`, so reject anything
 *  that could traverse or need escaping. (Runtime session ids are UUIDs /
 *  short slugs — this is a guard, not a codec.) */
const SESSION_ID_SAFE = /^[A-Za-z0-9._-]+$/

const defaultWarn = (message: string): void => {
  process.stderr.write(`[kernel.session.event-log] ${message}\n`)
}

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM ⇒ exists but owned by another user ⇒ alive. Anything else (ESRCH)
    // ⇒ no such process.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Atomic lock create: write pid to a temp file, `link(2)` it into place —
 *  link fails with EEXIST when the lock is held, and the lock NEVER exists in
 *  a content-less intermediate state (so unreadable content is always foreign
 *  ⇒ fail closed, never a race artifact of this writer). */
const tryCreateLock = (lockPath: string): boolean => {
  const tempPath = `${lockPath}.${process.pid}.tmp`
  writeFileSync(tempPath, String(process.pid), { mode: 0o600 })
  try {
    linkSync(tempPath, lockPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  } finally {
    rmSync(tempPath, { force: true })
  }
}

const acquireSingleWriterLock = (lockPath: string, warn: (message: string) => void): void => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (tryCreateLock(lockPath)) return
    let content: string
    try {
      content = readFileSync(lockPath, "utf8").trim()
    } catch {
      // Raced with the holder's release between link-fail and read — retry.
      continue
    }
    const pid = Number.parseInt(content, 10)
    if (!Number.isInteger(pid) || String(pid) !== content) {
      throw new JsonlSessionEventLogLockError(
        `session event log lock ${lockPath} has unreadable content ${JSON.stringify(content)} — refusing to steal it; remove the file if you know the writer is gone`,
      )
    }
    if (isPidAlive(pid)) {
      throw new JsonlSessionEventLogLockError(
        `session event log is already open by live pid ${pid} (lock ${lockPath}) — one writer per log`,
      )
    }
    warn(`reclaiming stale event-log lock ${lockPath} (owner pid ${pid} is dead)`)
    rmSync(lockPath, { force: true })
  }
  throw new JsonlSessionEventLogLockError(
    `could not acquire session event log lock ${lockPath} after stale-lock reclaim (a concurrent writer keeps re-locking)`,
  )
}

interface LoadedLog {
  readonly events: SessionEvent[]
  readonly tip: number
  /** The final line decoded fine but lost its `\n` to a tear — terminate it
   *  before the next append so lines never merge. */
  readonly repairNewline: boolean
}

const loadAndRecover = (filePath: string, warn: (message: string) => void): LoadedLog => {
  let raw: string
  try {
    raw = readFileSync(filePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], tip: 0, repairNewline: false }
    }
    throw error
  }
  if (raw === "") return { events: [], tip: 0, repairNewline: false }

  const terminated = raw.endsWith("\n")
  const lines = raw.split("\n")
  if (terminated) lines.pop() // drop the empty split sentinel after the final "\n"

  const events: SessionEvent[] = []
  let tip = 0
  let goodBytes = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string
    const isFinal = i === lines.length - 1
    try {
      const event = decodeSessionEvent(line)
      events.push(event)
      if (event.seq > tip) tip = event.seq
      goodBytes += Buffer.byteLength(line, "utf8") + 1
    } catch (error) {
      const tornWrite =
        isFinal &&
        !terminated &&
        error instanceof SessionProtocolValidationError &&
        error.issue === "invalid_json"
      if (!tornWrite) {
        throw new JsonlSessionEventLogCorruptionError(
          `corrupt session event log ${filePath} at line ${i + 1}: ${errMessage(error)} — refusing to open (skipping would be silent event loss); repair or move the file to proceed`,
        )
      }
      warn(
        `torn final line in ${filePath} (crash mid-write) — dropping ${Buffer.byteLength(line, "utf8")} partial byte(s), log resumes at seq ${tip}`,
      )
      truncateSync(filePath, goodBytes)
      return { events, tip, repairNewline: false }
    }
  }
  return { events, tip, repairNewline: !terminated }
}

export class JsonlSessionEventLog implements KernelEventLogPort, DurableSessionEventLog {
  readonly #filePath: string
  readonly #lockPath: string
  readonly #events: SessionEvent[]
  #tip: number
  /** Append fd; `undefined` once closed. */
  #fd: number | undefined

  constructor(options: JsonlSessionEventLogOptions) {
    if (
      !SESSION_ID_SAFE.test(options.sessionId) ||
      options.sessionId === "." ||
      options.sessionId === ".."
    ) {
      throw new Error(
        `unsafe sessionId for event-log file name: ${JSON.stringify(options.sessionId)} (allowed: [A-Za-z0-9._-]+)`,
      )
    }
    const warn = options.warn ?? defaultWarn
    mkdirSync(options.dir, { recursive: true, mode: 0o700 })
    this.#filePath = join(options.dir, `${options.sessionId}.jsonl`)
    this.#lockPath = `${this.#filePath}.lock`
    acquireSingleWriterLock(this.#lockPath, warn)
    try {
      const loaded = loadAndRecover(this.#filePath, warn)
      this.#events = loaded.events
      this.#tip = loaded.tip
      this.#fd = openSync(this.#filePath, "a", 0o600)
      if (loaded.repairNewline) {
        warn(`unterminated final line in ${this.#filePath} — newline repaired (event kept)`)
        writeSync(this.#fd, "\n")
      }
    } catch (error) {
      // Failed open must not leave the lock behind (it is OURS at this point).
      rmSync(this.#lockPath, { force: true })
      throw error
    }
  }

  append(event: SessionEvent): void {
    if (this.#fd === undefined) {
      throw new Error(`session event log ${this.#filePath} is closed — append rejected`)
    }
    // One event per line; see the class docblock for the v1 fsync policy.
    writeSync(this.#fd, `${encodeSessionEvent(event)}\n`)
    this.#events.push(event)
    if (event.seq > this.#tip) this.#tip = event.seq
  }

  list(): readonly SessionEvent[] {
    return [...this.#events]
  }

  tip(): number {
    return this.#tip
  }

  readFrom(afterSeq: number): SessionEvent[] {
    return this.#events.filter((event) => event.seq > afterSeq)
  }

  close(): void {
    if (this.#fd === undefined) return
    closeSync(this.#fd)
    this.#fd = undefined
    rmSync(this.#lockPath, { force: true })
  }
}
