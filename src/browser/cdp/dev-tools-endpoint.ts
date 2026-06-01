/**
 * Browser slice — DevTools endpoint discovery (ADR-0427, Wave 2).
 *
 * Chrome launched with `--remote-debugging-port=0` writes the OS-assigned port
 * (and ws path) to `<profile>/DevToolsActivePort` once ready. We poll that file
 * rather than parse stderr — deterministic and concurrent-safe (each session
 * has its own profile dir). The file may briefly be absent or half-written, so
 * absence/malformed → keep polling until the budget elapses.
 *
 * Both functions are pure over injected `BrowserFs`/`Scheduler`/`Clock`, so the
 * full poll loop is unit-tested with a fake fs + manual clock — no real chrome.
 */

import { err, ok, type Result } from "@/shared"
import type { BrowserError } from "../types"
import type { Clock, Scheduler } from "./ports"

/** Parse a DevToolsActivePort file body. Line 1 = port, line 2 = ws path
 *  (optional). */
export const parseDevToolsActivePort = (content: string): Result<string, "malformed"> => {
  const lines = content.split("\n")
  const port = (lines[0] ?? "").trim()
  const path = (lines[1] ?? "").trim()
  if (port.length === 0 || !/^\d+$/.test(port)) return err("malformed")
  return ok(`ws://127.0.0.1:${port}${path}`)
}

export interface ReadEndpointDeps {
  /** Returns the DevToolsActivePort file content, or null if not yet present. */
  read(): string | null
  readonly scheduler: Scheduler
  readonly clock: Clock
  readonly timeoutMs?: number
  readonly pollMs?: number
  /** Abort the poll early (R1 audit [18] — without this an aborted turn hangs
   *  to the full timeout while the spawned Chrome keeps running). */
  readonly signal?: AbortSignal
}

export const readDevToolsEndpoint = async (
  deps: ReadEndpointDeps,
): Promise<Result<string, BrowserError>> => {
  const timeoutMs = deps.timeoutMs ?? 10_000
  const pollMs = deps.pollMs ?? 50
  const start = deps.clock.now()
  for (;;) {
    if (deps.signal?.aborted === true) return err({ kind: "cancelled" })
    const content = deps.read()
    if (content !== null) {
      const parsed = parseDevToolsActivePort(content)
      if (parsed.ok) return ok(parsed.value)
      // malformed (mid-write) — fall through and retry until timeout
    }
    if (deps.clock.now() - start >= timeoutMs) {
      return err({ kind: "spawn-failed", detail: "DevTools endpoint not ready before timeout" })
    }
    // R3 audit [8]: race the poll sleep against abort and cancel the timer on
    // settle — without this an abort waits a full pollMs and leaks the timer.
    await new Promise<void>((resolve) => {
      const cancel = deps.scheduler.schedule(pollMs, () => {
        deps.signal?.removeEventListener("abort", onAbort)
        resolve()
      })
      const onAbort = (): void => {
        cancel()
        resolve()
      }
      deps.signal?.addEventListener("abort", onAbort, { once: true })
    })
  }
}
