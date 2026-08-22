import { describe, expect, test } from "bun:test"
import {
  TIMELINE_FALLBACK_AGENT_EVENT_TYPES,
  TIMELINE_FORMATTED_AGENT_EVENT_TYPES,
} from "../../../src/apps/cli/timeline-panel"
import { TURN_SUMMARY_CONSUMED_AGENT_EVENT_TYPES } from "../../../src/apps/cli/turn-summary"
import { AGENT_EVENT_TYPES } from "../../../src/stream"

/**
 * AgentEvent surface inventory hellgate.
 *
 * `timeline-panel` and `turn-summary` are two first-class CLI `AgentEvent`
 * consumers. This guard pins their declared inventory against the canonical
 * `AGENT_EVENT_TYPES` set so event-family growth cannot silently bypass these
 * surfaces.
 */
describe("AgentEvent surface inventory hellgate", () => {
  test("timeline formatted + fallback partitions AGENT_EVENT_TYPES exactly", () => {
    const canonical = [...AGENT_EVENT_TYPES].sort()
    const formatted = [...TIMELINE_FORMATTED_AGENT_EVENT_TYPES].sort()
    const fallback = [...TIMELINE_FALLBACK_AGENT_EVENT_TYPES].sort()
    const combined = [...new Set([...formatted, ...fallback])].sort()

    expect(combined).toEqual(canonical)

    const fallbackSet = new Set<string>(fallback)
    expect(formatted.filter((t) => fallbackSet.has(t))).toEqual([])
  })

  test("turn-summary consumed set is a strict subset of AGENT_EVENT_TYPES", () => {
    const canonical = new Set<string>(AGENT_EVENT_TYPES)
    for (const type of TURN_SUMMARY_CONSUMED_AGENT_EVENT_TYPES) {
      expect(canonical.has(type)).toBe(true)
    }
    expect(TURN_SUMMARY_CONSUMED_AGENT_EVENT_TYPES.length).toBe(6)
    expect(TURN_SUMMARY_CONSUMED_AGENT_EVENT_TYPES.length).toBeLessThan(AGENT_EVENT_TYPES.length)
  })

  test("timeline inventory teeth: removing one handled event breaks the partition", () => {
    const canonical = [...AGENT_EVENT_TYPES].sort()
    const mutated = [
      ...TIMELINE_FORMATTED_AGENT_EVENT_TYPES.filter((t) => t !== "turn_start"),
      ...TIMELINE_FALLBACK_AGENT_EVENT_TYPES,
    ].sort()
    expect(mutated).not.toEqual(canonical)
  })
})
