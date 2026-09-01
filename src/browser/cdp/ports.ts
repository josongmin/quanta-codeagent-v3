/**
 * Browser slice — CDP adapter injected boundaries (ADR-0427, Wave 2).
 *
 * Every non-deterministic edge the CDP adapter touches (process spawn, the
 * WebSocket transport, the filesystem, timers) is a port declared HERE. The
 * adapter's logic is written against these interfaces only, so the whole thing
 * is unit-testable with fakes — zero real browser. The thin Bun-backed default
 * implementations live in `./defaults` and are the only un-unit-tested code in
 * the slice (smoke-tested when a real chrome is present).
 *
 * `@/shared` is the only cross-slice import allowed here.
 */

import type { Result } from "@/shared"

// ── process ────────────────────────────────────────────────────────────────

export interface SpawnedProcess {
  readonly pid: number
  kill(signal?: number | "SIGTERM" | "SIGKILL"): void
  /** Resolves with the exit code when the process ends. */
  readonly exited: Promise<number>
  /** Production process owners provide a bounded liveness check so teardown
   *  can wait for SIGTERM and escalate to SIGKILL without ever hanging. Fakes
   *  may omit it when kill() is synchronous by contract. */
  waitForExit?(timeoutMs: number): Promise<boolean>
}

export interface ProcessSpawner {
  /** Absolute path of `cmd` on PATH, or null. Synchronous (gates
   *  `availability()`). */
  which(cmd: string): string | null
  spawn(argv: readonly string[]): SpawnedProcess
}

// ── transport ────────────────────────────────────────────────────────────────

export interface CdpConnection {
  send(payload: string): void
  onMessage(cb: (raw: string) => void): void
  /** Fired ONCE when the transport drops (ws close/error / process death) —
   *  lets the session fail every in-flight + future call fast instead of
   *  grinding each to its timeout (R3 audit [1]). Optional: in-memory fakes that
   *  never drop may omit it. */
  onClose?(cb: () => void): void
  close(): void
}

export interface CdpTransport {
  connect(
    wsUrl: string,
    signal?: AbortSignal,
  ): Promise<Result<CdpConnection, { readonly detail: string }>>
}

// ── filesystem ────────────────────────────────────────────────────────────────

export interface BrowserFs {
  existsSync(path: string): boolean
  /** Read a file's text, or null if absent/unreadable (used to poll the
   *  DevToolsActivePort file — absence is normal, not an error). */
  readFile(path: string): string | null
  mkdirp(path: string): void
  rmrf(path: string): void
}

// ── timers ────────────────────────────────────────────────────────────────

export interface Scheduler {
  /** Run `cb` after `ms`; returns an idempotent cancel function. */
  schedule(ms: number, cb: () => void): () => void
}

export interface Clock {
  now(): number
}
