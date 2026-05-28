/**
 * ADR-0401 — Run Ledger attribution via hook bus: closed port + matcher
 * contract.
 *
 * Wave-1 (ADR-0395) shipped `@/agent/run-ledger` as a pure store. This wave
 * plugs a SUBSCRIBER into the in-process `HookBus` (`src/agent/hooks.ts`) so
 * the ledger gets real data from `bash` / `bash_await` / `bash_kill` /
 * `agent` / `task_output` / `task_stop` / `get_mcp_task` / `cancel_mcp_task`
 * WITHOUT mutating any of those slices.
 *
 * Slice fence: this file (and every sibling in `run-ledger-attribution/`)
 * imports ONLY `@/agent/run-ledger` (types) + `@/shared` (utils). It NEVER
 * imports `@/tool/bash`, `@/subagent`, `@/mcp`, or agent-core
 * (`@/agent` loop/dispatch/hooks/features). The matchers parse opaque tool
 * output STRINGS (the same redacted `preview` the `post_tool_use` hook
 * carries — never structured ToolEvent values) — so the slice cannot drift
 * with peer-slice internals.
 */

import type { RunLedgerPort } from "@/agent/run-ledger"

/** A single action a matcher can request against the ledger. Mirrors the
 *  three observable phases of a long-running run: open it (`start`), update
 *  its state (`touch`), or close it (`settle`). The wave-1 ledger is the
 *  authority on what each action means.
 *
 *  `exec` is NOT produced by the default matcher (no quanta tool surfaces an
 *  exec-ledger event today); the literal is kept here for forward-compat
 *  with the wave-1 `RunKind` enum so a custom matcher can target it. */
export type LedgerAction =
  | {
      kind: "start"
      id: string
      runKind: "shell" | "subagent" | "mcp_task"
      owner: string
      title: string
      resumeAction?: string
    }
  | {
      kind: "touch"
      id: string
      status?: "running" | "waiting"
      waitingOn?: "user" | "tool" | "network" | "child_agent"
    }
  | {
      kind: "settle"
      id: string
      status: "completed" | "failed" | "stopped"
      error?: string
    }

/** The shape this slice sees on the hook bus. We type it OPAQUELY (NOT
 *  `HookEvent`) so the matcher does not import `@/agent/hooks` — every field
 *  is validated defensively before use, exactly because the matcher runs at
 *  a seam where malformed input is plausible (e.g. a test fixture, a future
 *  hook variant the matcher does not know yet). */
export interface ObservedToolEvent {
  readonly name: string
  readonly input: unknown
  readonly output?: unknown
  readonly ok: boolean
}

/** Pure matcher — given an observed `post_tool_use` event, decide whether to
 *  emit a ledger action. NO side effects. NO-THROW (malformed payload ⇒
 *  null). A null return means "this event does not concern the ledger". */
export interface LedgerMatcher {
  match(event: ObservedToolEvent): LedgerAction | null
}

/** Hook handler closure to subscribe to the `post_tool_use` event. Returns
 *  `void` (handlers do not surface results back to the bus on this event).
 *  NO-THROW: invokes the ledger best-effort and swallows any error so the
 *  hook bus's contract holds. */
export type RunLedgerHookHandler = (event: ObservedToolEvent) => void

/** Dependencies for {@link createRunLedgerHookSubscriber}. `matcher` defaults
 *  to {@link createDefaultLedgerMatcher}; `owner` defaults to a constant
 *  fallback (a host that knows the active threadId should override this). */
export interface RunLedgerHookSubscriberDeps {
  readonly ledger: RunLedgerPort
  readonly matcher?: LedgerMatcher
  readonly owner?: () => string
}

/** Options for {@link createDefaultLedgerMatcher}. `owner` is invoked at
 *  `start` time to stamp the new RunEntry; it does NOT affect later touches
 *  (the ledger keeps the original owner). */
export interface DefaultLedgerMatcherOptions {
  readonly owner?: () => string
}
