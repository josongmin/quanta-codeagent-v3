/**
 * RFC-01 A2 — build the OPTIONAL post-turn rewind-checkpoint feeder hook.
 *
 * This is the composition-root gate for {@link feedCheckpointCapture}: it returns
 * a `PersistTurnCheckpointHook` ONLY when
 *
 *   1. the dedicated capture gate `QUANTA_REWIND_CAPTURE` is set, AND
 *   2. a per-tool granular checkpoint policy is wired (so a live tag→SHA
 *      registry exists — the SHA source the restore effect resolves against).
 *
 * Absent either ⇒ `undefined` ⇒ `persistTurn` makes ZERO extra calls and is
 * byte-identical to the save-only path. The hook itself is best-effort +
 * non-throwing (the feeder swallows every failure to a typed result).
 *
 * # SHA source
 *
 * The hook binds the NEWEST live-registry anchor SHA (`registry.list()[0].sha`,
 * newest-first) — the freshest post-mutation shadow head of the turn — so the
 * durable record's `checkpointSha` is a SHA the restore registry already knows
 * (no fresh `registerHead`; see the feeder module docstring).
 */

import { type FeederMessage, feedCheckpointCapture } from "@/agent/rewind-capture-feeder"
import type { PersistTurnCheckpointHook } from "@/runner/orchestrate/persist-turn"
import { runtimeConfig } from "@/shared"
import type { RuntimeBase } from "./types"

/** The dedicated default-OFF capture gate — read through `runtimeConfig()`
 *  (`QUANTA_REWIND_CAPTURE`, declared in runtime-config.ts + runtime-config-knobs). */
export const REWIND_CAPTURE_GATE = "QUANTA_REWIND_CAPTURE"

/** Build the post-turn checkpoint feeder hook, or `undefined` when the gate is
 *  off / no granular registry is wired (byte-identical: no hook ⇒ no capture).
 *
 *  `captureOn` is injectable (default `runtimeConfig().rewindCapture`) purely so
 *  the wiring hellgate can drive both gate arms without a global env mutation. */
export const buildRewindCaptureHook = (
  base: RuntimeBase,
  captureOn: boolean = runtimeConfig().rewindCapture,
): PersistTurnCheckpointHook | undefined => {
  if (!captureOn) return undefined
  const registry = base.shadowCheckpoint?.granularPolicy?.registry
  // No registry ⇒ no SHA source the restore effect could resolve. Recording a
  // checkpoint whose SHA the registry never saw would only fail-close later at
  // `checkpoint-anchor-missing`, so we DON'T build the hook at all.
  if (registry === undefined) return undefined
  const workspace = base.cwd
  return async ({ sessionId, messages }) => {
    // The feeder is fully best-effort/non-throwing; we forward the newest anchor
    // SHA source + the (structural) messages verbatim.
    await feedCheckpointCapture({
      sessionId,
      workspace,
      messages: messages as readonly FeederMessage[],
      latestAnchorSha: () => registry.list()[0]?.sha,
    })
  }
}
