/**
 * `@/apps/web-daemon/runtime-factory/readout-sources` — ONE responsibility:
 * the READ-ONLY projection layer behind `GET /readout/:name` (UUX-1-11).
 *
 * Two narrow record projectors (`TaskRecord` → fleet row, `MemoryEntry` →
 * readout entry — so the renderer never imports `@/subagent` or `@/memory`)
 * plus the assembler that binds them to the SAME live collaborators the loop
 * runs on. Pure reads: nothing here mints, mutates or gates anything, and an
 * absent collaborator simply omits its accessor (honest "not wired" line).
 *
 * Extracted verbatim from `../runtime-factory.ts` (god-module split). The edge
 * is ONE-WAY — the parent imports this file.
 */

import type { PlanStore } from "@/agent/plan/state"
import type { PersistentStorePort } from "@/memory"
import { checkSessionStoreHealth } from "@/session"
import type { SkillRuntimeAuthority } from "@/skill"
import type { TaskRegistry } from "@/subagent"
import { buildSkillsReadoutSource } from "../authority-readouts"
import type { CanvasUsageSourceHandle } from "../canvas-usage-source"
import type { AgentFleetReadoutRow, MemoryReadoutEntry, WebReadoutSources } from "../readout"
import type { WebModelSwitchHandle } from "../web-model-switch"

/** UUX-1-11 — project a subagent `TaskRecord` onto the narrow readout row
 *  (structural copy; the readout renderer never imports `@/subagent`). */
const toAgentFleetReadoutRow = (rec: {
  id: string
  description: string
  agentType?: string
  status: "running" | "completed" | "failed" | "stopped"
  startedAt: number
  endedAt?: number
  error?: string
}): AgentFleetReadoutRow => ({
  id: rec.id,
  description: rec.description,
  ...(rec.agentType !== undefined ? { agentType: rec.agentType } : {}),
  status: rec.status,
  startedAt: rec.startedAt,
  ...(rec.endedAt !== undefined ? { endedAt: rec.endedAt } : {}),
  ...(rec.error !== undefined ? { error: rec.error } : {}),
})

/** UUX-1-11 — project a durable `MemoryEntry` onto the narrow readout view
 *  (id/tier/text/importance only — tags & embeddings stay host-side). */
const toMemoryReadoutEntry = (entry: {
  id: string
  tier?: string
  text: string
  importance?: number
  createdAt: number
}): MemoryReadoutEntry => ({
  id: entry.id,
  ...(entry.tier !== undefined ? { tier: entry.tier } : {}),
  text: entry.text,
  ...(entry.importance !== undefined ? { importance: entry.importance } : {}),
  createdAt: entry.createdAt,
})

/**
 * UUX-1-11 — assemble the read-only {@link WebReadoutSources} bundle from the
 * live session collaborators this factory just minted. Every accessor is a
 * thin projection over the SAME instance the loop runs on (no split-brain):
 *  - `agents`  → the TaskRegistry threaded into `subagent.taskRegistry`
 *  - `plan`    → the PlanStore on `base.planStore` (the 5 plan tools write it)
 *  - `skills`  → the shared skill runtime authority's `active` projection
 *                (RFC-06 F4: NO independent discovery scan; converges with the
 *                prompt/ToolSearch/invocation/CLI set)
 *  - `memory`  → the durable store `buildMemoryForSession(env)` resolves (the
 *                store the CLI writes; READ-ONLY here — this surface composes
 *                no memory config, so web turns do not write memories yet)
 *  - `context` → the always-on prompt-usage holder (`onPromptAssembled` sink)
 * `/cost` is deliberately absent: `startWebDaemon` projects the facade's
 * canonical usage authority and owns the independent turn tally
 * from `turn.completed` events (the daemon-native usage truth).
 */
export const buildReadoutSources = (args: {
  readonly taskRegistry: TaskRegistry | undefined
  readonly planStore: PlanStore | undefined
  readonly skillAuthority: SkillRuntimeAuthority | undefined
  readonly memoryStore: PersistentStorePort | undefined
  readonly usageHolder: CanvasUsageSourceHandle
  /** aug-27 — the model switch (sticky store + lazy provider catalog). Present ⇒
   *  the `/model` readout lists what `set_model` can actually select. */
  readonly modelSwitch?: WebModelSwitchHandle | undefined
  /** ADR-0493 (G2b-01 wire) — the daemon env the thin-client route gate reads;
   *  threaded to the skills source so each row carries its RESOLVED route on
   *  this (web = thin) surface. Absent ⇒ gate off ⇒ byte-identical rows. */
  readonly env?: Record<string, string | undefined>
}): WebReadoutSources => {
  const { taskRegistry, planStore, skillAuthority, memoryStore, usageHolder, modelSwitch, env } =
    args
  return {
    ...(taskRegistry !== undefined
      ? { agents: () => taskRegistry.list().map(toAgentFleetReadoutRow) }
      : {}),
    ...(planStore !== undefined ? { plan: () => planStore.current() } : {}),
    // RFC-06 F4 — the `/skills` readout reads the ONE shared authority's `active`
    // projection (see {@link buildSkillsReadoutSource}); there is NO independent
    // discovery scan on this surface any more (the discovery-owner ratchet pins
    // it removed). So the web panel converges with the prompt/ToolSearch/
    // invocation/CLI set — a disabled skill vanishes here too. Absent authority
    // (skills off / fail-open) ⇒ honest missing-source line.
    ...(skillAuthority !== undefined
      ? { skills: buildSkillsReadoutSource(skillAuthority, env) }
      : {}),
    ...(memoryStore !== undefined
      ? { memory: async () => (await memoryStore.all()).map(toMemoryReadoutEntry) }
      : {}),
    context: () => usageHolder.latest(),
    // P4/P2 (jul-11, UUX-4-18) — session-store health is a dependency-free
    // async probe (no SlashContext needed), so the `/doctor` readout is ALWAYS
    // available on this daemon (CLI parity for the store-health check).
    doctor: () => checkSessionStoreHealth(),
    // aug-27 — READ half of the web model switch. The probe is AWAITED here (not
    // at daemon boot) so listing costs one lazy provider round-trip at the moment
    // a client asks, and a rejected probe still renders the seeded candidates.
    ...(modelSwitch !== undefined
      ? {
          model: async (): Promise<{ current: string; ids: readonly string[] }> => {
            await modelSwitch.refresh()
            return { current: await modelSwitch.current(), ids: modelSwitch.ids() }
          },
        }
      : {}),
  }
}
