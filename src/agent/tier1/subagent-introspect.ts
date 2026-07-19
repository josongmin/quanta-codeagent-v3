/**
 * Tier-1 per-subsystem builder: SUBAGENT INTROSPECT block (RFC-04 / ADR-0437).
 *
 * Builds `list_agents` and/or `followup_task` when their gates are on:
 *   - `config.subagent.enableIntrospect === true` ⇒ `list_agents` (needs the
 *     shared `TaskRegistry`; joins `config.subagentAgentMeta` when wired).
 *   - `config.subagent.enableFollowup === true` ⇒ `followup_task` (needs the
 *     shared `TaskRegistry` + `config.subagentMailbox` + `config.subagentTurnWake`).
 *
 * DEFAULT-OFF: gates absent/false OR required substrate missing ⇒ the
 * corresponding tool is NOT built and the ToolRegistry stays byte-identical.
 * Mirrors `buildSubagentMailboxBlock` posture.
 *
 * SHARED REGISTRY: `list_agents` / `followup_task` MUST observe the SAME
 * `TaskRegistry` the trio/6-tool spawn into. That instance is shared by setting
 * `config.subagent.taskRegistry` (the surface-provided registry the trio also
 * adopts). Absent ⇒ the introspect tools see a FRESH (empty) registry — honest
 * degradation, never a crash — so the host is expected to wire
 * `taskRegistry` whenever it enables introspection.
 *
 * SLICE FENCE: imports `@/tool` (Tool) + `@/subagent` (the introspect slice).
 * The real `MailboxPort` is adapted onto the narrow `MailboxSendPort` mirror
 * inline (structurally identical `send`).
 */

import { redactSecrets } from "@/security"
import { logger } from "@/shared"
import { createIntrospectTools, type DeliveryPort } from "@/subagent"
import type { Tool } from "@/tool"
import {
  createSubagentDeliveryController,
  createTargetResolver,
  type DeliveryMailboxPort,
  type SubagentControlRegistry,
} from "../subagent-delivery"
import { formatPeerBody } from "../subagent-mailbox"
import type { AgentConfig } from "../types"

/** Deterministic-friendly delivery id: `del-<mailboxAgentId|root>-<seq>`. A pure
 *  monotonic counter (no clock / no randomness) so replay is byte-stable —
 *  mirrors the runner's deterministic child-id posture (ADR-0416). */
const makeDeliveryIdFactory = (scope: string): (() => string) => {
  let seq = 0
  return () => {
    seq += 1
    return `del-${scope}-${seq}`
  }
}

// ALBB-12 claim 1 — once-per-process guard so a genuinely-split surface warns
// exactly once (never spams across sessions), mirroring `wireCloseoutCritic`.
let warnedIntrospectNoRegistry = false

export const buildSubagentIntrospectBlock = (config: AgentConfig): Tool[] => {
  const sub = config.subagent
  if (sub === undefined) return []
  const wantList = sub.enableIntrospect === true
  const wantFollowup = sub.enableFollowup === true
  if (!wantList && !wantFollowup) return []

  // FAIL-CLOSED (ALBB-12 claim 1): the introspect tools MUST observe the SAME
  // `TaskRegistry` the agent/6-tool spawn path fills. The features seam writes
  // R1 back onto `config.subagent.taskRegistry`, and `wireSubagentToolGates`
  // mints one for env-gated surfaces — so `taskRegistry` is present by
  // construction whenever a surface reaches this builder correctly. If it is
  // STILL absent the surface is genuinely mis-wired: fabricating a fresh empty
  // registry here would register `list_agents`/`followup_task` over a table that
  // NEVER sees the real tasks (silent wrong output). Instead fail OPEN visibly —
  // build NO tool + surface the split ONCE — mirroring `wireCloseoutCritic`'s
  // no-reviewer posture (optional-ports.ts).
  const registry = sub.taskRegistry
  if (registry === undefined) {
    if (!warnedIntrospectNoRegistry) {
      warnedIntrospectNoRegistry = true
      logger.warn(
        "subagent introspect gate is on but no shared taskRegistry is wired — list_agents/followup_task will NOT be registered (they would observe an empty registry). Wire config.subagent.taskRegistry (the features seam / wireSubagentToolGates do this automatically).",
      )
    }
    return []
  }

  // WS3 (RFC §4.3–4.4) — `followup_task` now consumes the delivery CONTROLLER
  // instead of sequencing mailbox-send + wake itself. Build it only when the
  // followup substrate (mailbox + wake) is wired; otherwise `delivery` is absent
  // and `createIntrospectTools` skips `followup_task` (default-OFF, byte-identical).
  //
  // The `TurnWakeRegistry` is the concrete control registry, but its duck-typed
  // `ControlEndpoint` exposes `interrupt()/steer()` as `string` (slice fence), so
  // adapt it to the TYPED `SubagentControlRegistry` here — the real endpoints
  // registered by the runner ARE `SubagentControlEndpoint`, so the returned
  // values genuinely inhabit the closed unions (this is a re-typing, not a lie).
  const mailbox = config.subagentMailbox as DeliveryMailboxPort | undefined
  const wake = config.subagentTurnWake
  const delivery =
    wantFollowup && mailbox !== undefined && wake !== undefined
      ? (() => {
          const control = wake as unknown as SubagentControlRegistry
          const controller = createSubagentDeliveryController({
            control,
            mailbox,
            // RFC §4.5 — the ONE reused peer sanitizer/formatter (redact → escape
            // → untrusted provenance). Steer/interrupt injection is delivered
            // STRAIGHT to the child model (no mailbox drain to redact it later), so
            // the real secret redactor MUST be applied here — the SAME
            // `redactSecrets({origin:"tool_result"})` the queue auto-drain uses
            // (peer-team-wire). Hellaudit R3-HIGH-1: this was previously the
            // identity default ⇒ secrets in a steer body reached the child verbatim.
            formatPeer: (from, kind, body) =>
              formatPeerBody(
                { from, kind, body },
                (b) => redactSecrets(b, { origin: "tool_result" }).text,
              ),
            // RFC §4.5 "one sanitizer, ALL modes" — scrub secrets from EVERY body
            // the controller enqueues to the mailbox (queue / interrupt / steer
            // fallbacks), drain-independent (the mailbox drain redacts only under
            // QUANTA_TEAM_PEER_MSG; manual subagent_read_messages never redacts).
            redact: (b) => redactSecrets(b, { origin: "tool_result" }).text,
            resolveTarget: createTargetResolver({
              registry,
              control,
              // F-E (jul-7 audit) — gate followup_task by THIS agent's own lineage
              // (its deterministic `mailboxAgentId` label). Absent (root) ⇒ tree-
              // scoped via ROOT_LINEAGE. Self-guard from the child's own task id.
              ...(config.mailboxAgentId !== undefined
                ? { requesterLineage: config.mailboxAgentId }
                : {}),
              ...(config.subagentTaskId !== undefined ? { ownTaskId: config.subagentTaskId } : {}),
            }),
            newDeliveryId: makeDeliveryIdFactory(config.mailboxAgentId ?? "root"),
            // WS4 (RFC §9) — steer is enabled ONLY when the QUANTA_SUBAGENT_STEER
            // gate flipped `subagent.enableSteer` AND the session steer plane was
            // minted (the composition root wires both together). Gate OFF ⇒
            // `mode:"steer"` ⇒ `mode_disabled` reject (never a silent queue).
            steerEnabled: sub.enableSteer === true && sub.steerPlane !== undefined,
            // Share the session retention store so an accepted steer's payload is
            // retained where the child loop's finalization port reads it — one
            // payload map, no second registry (RFC §4.3). Absent plane ⇒ omitted
            // ⇒ WS3 behavior (accepted with no retention; steerEnabled is false
            // anyway, so `doSteer` is never reached).
            ...(sub.steerPlane !== undefined
              ? {
                  steerRetention: sub.steerPlane.retention,
                  finalization: sub.steerPlane.finalization,
                }
              : {}),
          })
          return controller as DeliveryPort
        })()
      : undefined

  return createIntrospectTools({
    registry,
    ...(config.subagentAgentMeta !== undefined ? { agentMeta: config.subagentAgentMeta } : {}),
    ...(delivery !== undefined ? { delivery } : {}),
    ...(config.mailboxAgentId !== undefined ? { callerLabel: config.mailboxAgentId } : {}),
    // F-B (jul-7 audit) — scope list_agents enumeration by THIS agent's own lineage
    // so a child sees only its own subtree + owner-less host-seeded tasks. Absent
    // (root, no label) ⇒ unscoped list (top authority).
    ...(config.mailboxAgentId !== undefined ? { requesterLineage: config.mailboxAgentId } : {}),
    ...(wantList ? { enableIntrospect: true } : {}),
    ...(wantFollowup ? { enableFollowup: true } : {}),
  })
}
