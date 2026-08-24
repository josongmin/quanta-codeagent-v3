/**
 * N1 — background side-agent tools (`side_agent_spawn` / `_list` / `_stop` /
 * `_findings`). The model-facing surface over the resident daemon registry
 * (`@/side-agent`, RFC `docs/plans/jun-4-background-side-agent.md`).
 *
 * A side-agent is a PERSISTENT background daemon (monitor / cleanup / periodic
 * check) that wakes on its own cadence, runs ONE bounded pass per wake, and
 * PUSHES findings via the mailbox — never blocks the main loop. Distinct from
 * one-shot `subagent_*_bg` (ADR-0130) and the scheduler (drives the MAIN loop).
 *
 * Slice posture: `@/tool` may NOT import `@/side-agent` (fence), so this file
 * declares a DUCK-TYPED {@link SideAgentDaemonPort} (a structural mirror of
 * `@/side-agent`'s `SideAgentDaemonRegistry`) — the composition root passes the
 * real registry, which matches structurally. NO-THROW: every path yields a typed
 * `ok:false` on failure (incl. the registry's single `cap-exceeded` throw).
 *
 * DEFAULT-OFF: registered ONLY when the host wires a daemon registry
 * (tier1 `buildSideAgentBlock` on `AgentConfig.sideAgentDaemons`, gated on
 * `QUANTA_SIDE_AGENT`); absent ⇒ not in the menu ⇒ byte-identical.
 */

import { z } from "zod"
import { errMessage } from "@/shared"
import type { CoreToolContext, Tool, ToolEvent, ToolFailure, ToolResult } from "../types"

/** Duck-typed mirror of `@/side-agent`'s `SideAgentTrigger`. */
export type SideAgentTriggerView =
  | { readonly kind: "interval"; readonly everyMs: number }
  | { readonly kind: "event"; readonly topic: string }

/** Duck-typed mirror of `@/side-agent`'s `SideAgentSpec`. */
export interface SideAgentSpecView {
  readonly task: string
  readonly trigger: SideAgentTriggerView
  readonly maxWakes: number
  readonly maxTurnsPerWake: number
  readonly idleReapMs?: number
  readonly metadata?: Readonly<Record<string, string>>
}

/** Duck-typed mirror of `@/side-agent`'s `SideAgentSnapshot`. */
export interface SideAgentSnapshotView {
  readonly id: string
  readonly status: string
  readonly spec: SideAgentSpecView
  readonly wakesDone: number
  readonly lastFindingAt?: number
  readonly startedAt: number
  readonly stoppedAt?: number
}

/** Duck-typed mirror of `@/side-agent`'s `SideAgentFinding`. */
export interface SideAgentFindingView {
  readonly daemonId: string
  readonly wake: number
  readonly summary: string
  readonly detail?: string
  readonly at: number
}

/** Duck-typed mirror of `@/side-agent`'s `SideAgentDaemonRegistry` (the
 *  model-facing subset — `stopAll` is session-shutdown, host-only). `spawn`
 *  MAY throw the registry's single `cap-exceeded` error; the tool catches it. */
export interface SideAgentDaemonPort {
  spawn(spec: SideAgentSpecView): string
  findings(opts?: { readonly since?: number }): ReadonlyArray<SideAgentFindingView>
  list(): ReadonlyArray<SideAgentSnapshotView>
  stop(id: string): boolean
}

const ok = (output: string): ToolResult => ({ ok: true, output })
const err = (output: string, failure: ToolFailure): ToolResult => ({ ok: false, output, failure })

const triggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("interval"),
    every_ms: z.number().int().positive().describe("Wake cadence in milliseconds."),
  }),
  z.object({
    kind: z.literal("event"),
    topic: z.string().min(1).describe("Event topic to wake on."),
  }),
])

export const sideAgentSpawnInputSchema = z.object({
  task: z.string().min(1).describe("Charter prompt the daemon re-runs each wake."),
  trigger: triggerSchema.describe("What wakes the daemon: interval or event."),
  max_wakes: z.number().int().positive().describe("Hard ceiling on total wakes (runaway guard)."),
  max_turns_per_wake: z.number().int().positive().describe("Per-wake model-turn budget."),
  idle_reap_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Auto-stop after this much wall-idle with no finding; omit for never."),
  metadata: z
    .record(z.string(), z.string())
    .optional()
    .describe("Free-form string tags attached to the daemon (for tracking/filtering in list)."),
})
export type SideAgentSpawnInput = z.infer<typeof sideAgentSpawnInputSchema>

export const sideAgentListInputSchema = z.object({})
export type SideAgentListInput = z.infer<typeof sideAgentListInputSchema>

export const sideAgentStopInputSchema = z.object({
  id: z.string().min(1).describe("Daemon id to stop (idempotent; findings kept)."),
})
export type SideAgentStopInput = z.infer<typeof sideAgentStopInputSchema>

export const sideAgentFindingsInputSchema = z.object({
  since: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Drain findings newer than this epoch-ms."),
})
export type SideAgentFindingsInput = z.infer<typeof sideAgentFindingsInputSchema>

const toSpec = (input: SideAgentSpawnInput): SideAgentSpecView => ({
  task: input.task,
  trigger:
    input.trigger.kind === "interval"
      ? { kind: "interval", everyMs: input.trigger.every_ms }
      : { kind: "event", topic: input.trigger.topic },
  maxWakes: input.max_wakes,
  maxTurnsPerWake: input.max_turns_per_wake,
  ...(input.idle_reap_ms !== undefined ? { idleReapMs: input.idle_reap_ms } : {}),
  ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
})

const renderSnapshot = (s: SideAgentSnapshotView): string => {
  const t =
    s.spec.trigger.kind === "interval"
      ? `every ${s.spec.trigger.everyMs}ms`
      : `on "${s.spec.trigger.topic}"`
  return `  ${s.id} [${s.status}] ${t} wakes=${s.wakesDone}/${s.spec.maxWakes} — ${s.spec.task}`
}

const makeSpawnTool = (
  registry: SideAgentDaemonPort,
  admitChild: () => boolean,
): Tool<SideAgentSpawnInput> => ({
  name: "side_agent_spawn",
  description:
    "Spawn a PERSISTENT background side-agent (monitor / cleanup / periodic check) " +
    "that wakes on an interval or event, runs one bounded pass per wake, and pushes " +
    "findings WITHOUT blocking you. Returns the daemon id immediately.",
  inputSchema: sideAgentSpawnInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(input: SideAgentSpawnInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = sideAgentSpawnInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: err(`invalid input: ${parsed.error.message}`, {
          mode: "rejected",
          reason: "bad_input",
        }),
      }
      return
    }
    if (ctx.signal.aborted) {
      yield {
        type: "result",
        result: err("aborted before start", { mode: "rejected", reason: "aborted" }),
      }
      return
    }
    // DEPTH AUTHORITY (rev.4 §4 defense-in-depth). Daemon CREATION is a
    // descendant-spawn vector: a leaf / cap-0 agent must not mint a persistent
    // background daemon even via a forced/held path the projection cannot hide.
    // `admitChild` is the SAME min-cap authority every other spawn vector uses
    // (injected by `buildSideAgentBlock` = `childDepthOf(config)` vs `effectiveCap`,
    // fail-closed). Kept as an injected predicate so `@/tool` never imports the
    // `@/agent` authority (slice fence).
    if (!admitChild()) {
      yield {
        type: "result",
        result: err(
          "side-agent daemon creation denied: spawn depth cap reached — a leaf agent cannot mint background daemons (raise QUANTA_MAX_DESCENDANT_DEPTH or run from the root).",
          { mode: "rejected", reason: "depth_exceeded" },
        ),
      }
      return
    }
    try {
      const id = registry.spawn(toSpec(parsed.data))
      yield { type: "result", result: ok(`Spawned side-agent ${id}.`) }
    } catch (e) {
      // The registry's single throw is `cap-exceeded` (max concurrent daemons).
      yield {
        type: "result",
        result: err(`cannot spawn side-agent: ${errMessage(e)}`, {
          mode: "rejected",
          reason: "cap_exceeded",
        }),
      }
    }
  },
})

const makeListTool = (registry: SideAgentDaemonPort): Tool<SideAgentListInput> => ({
  name: "side_agent_list",
  description: "List background side-agents (newest first) with status + wake progress.",
  inputSchema: sideAgentListInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(_input: SideAgentListInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    if (ctx.signal.aborted) {
      yield {
        type: "result",
        result: err("aborted before start", { mode: "rejected", reason: "aborted" }),
      }
      return
    }
    // NO-THROW boundary (Tool contract §2): a misbehaving registry must surface
    // a typed result, never reject the iterator.
    let all: ReadonlyArray<SideAgentSnapshotView>
    try {
      all = registry.list()
    } catch (e) {
      const msg = errMessage(e)
      yield {
        type: "result",
        result: err(`cannot list side-agents: ${msg}`, { mode: "error", modelVisibleError: msg }),
      }
      return
    }
    if (all.length === 0) {
      yield { type: "result", result: ok("No background side-agents.") }
      return
    }
    yield {
      type: "result",
      result: ok([`Side-agents (${all.length}):`, ...all.map(renderSnapshot)].join("\n")),
    }
  },
})

const makeStopTool = (registry: SideAgentDaemonPort): Tool<SideAgentStopInput> => ({
  name: "side_agent_stop",
  description: "Stop a background side-agent by id (idempotent; its findings are kept).",
  inputSchema: sideAgentStopInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(input: SideAgentStopInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = sideAgentStopInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: err(`invalid input: ${parsed.error.message}`, {
          mode: "rejected",
          reason: "bad_input",
        }),
      }
      return
    }
    if (ctx.signal.aborted) {
      yield {
        type: "result",
        result: err("aborted before start", { mode: "rejected", reason: "aborted" }),
      }
      return
    }
    let stopped: boolean
    try {
      stopped = registry.stop(parsed.data.id)
    } catch (e) {
      const msg = errMessage(e)
      yield {
        type: "result",
        result: err(`cannot stop side-agent: ${msg}`, { mode: "error", modelVisibleError: msg }),
      }
      return
    }
    if (!stopped) {
      yield {
        type: "result",
        result: err(`unknown side-agent: ${parsed.data.id}`, { mode: "not_found" }),
      }
      return
    }
    yield { type: "result", result: ok(`Stopped side-agent ${parsed.data.id}.`) }
  },
})

const makeFindingsTool = (registry: SideAgentDaemonPort): Tool<SideAgentFindingsInput> => ({
  name: "side_agent_findings",
  description:
    "Drain background side-agent findings (optionally newer than `since` epoch-ms). " +
    "Read-only — the daemons push these as they work.",
  inputSchema: sideAgentFindingsInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: SideAgentFindingsInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = sideAgentFindingsInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: err(`invalid input: ${parsed.error.message}`, {
          mode: "rejected",
          reason: "bad_input",
        }),
      }
      return
    }
    if (ctx.signal.aborted) {
      yield {
        type: "result",
        result: err("aborted before start", { mode: "rejected", reason: "aborted" }),
      }
      return
    }
    let found: ReadonlyArray<SideAgentFindingView>
    try {
      found = registry.findings(parsed.data.since !== undefined ? { since: parsed.data.since } : {})
    } catch (e) {
      const msg = errMessage(e)
      yield {
        type: "result",
        result: err(`cannot drain findings: ${msg}`, { mode: "error", modelVisibleError: msg }),
      }
      return
    }
    if (found.length === 0) {
      yield { type: "result", result: ok("No new findings.") }
      return
    }
    const lines = found.map((f) => `  [${f.daemonId} wake ${f.wake}] ${f.summary}`)
    yield { type: "result", result: ok([`Findings (${found.length}):`, ...lines].join("\n")) }
  },
})

/** Build the side-agent management tools over a wired daemon registry.
 *
 *  `admitChild` is the spawn-depth authority for daemon CREATION (rev.4 §4): it
 *  returns whether THIS agent may mint a new descendant (the daemon). Production
 *  wiring (`buildSideAgentBlock`) injects `childDepthOf(config)` vs `effectiveCap`
 *  so a leaf / cap-0 agent is denied. Default `() => true` keeps the tool-only
 *  call sites (which do not model depth) byte-identical; the production injection
 *  is pinned by a wiring hellgate. */
export const sideAgentTools = (
  registry: SideAgentDaemonPort,
  admitChild: () => boolean = () => true,
): Tool[] => [
  makeSpawnTool(registry, admitChild) as Tool,
  makeListTool(registry) as Tool,
  makeStopTool(registry) as Tool,
  makeFindingsTool(registry) as Tool,
]
