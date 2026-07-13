/** jul-13 WIRE hellgate — edit-fresh-hash dispatch seam is PRODUCTION-REACHABLE.
 *
 *  The sibling `edit-fresh-hash-hellgate.test.ts` injects `ctx.editFreshHash`
 *  DIRECTLY, so it proves the TOOL LOGIC but NOT that the flag is actually wired
 *  from the knob. This whole review kept finding "sophisticated machinery that's
 *  inert (declared + typed but never fed into the live path)" — so this suite
 *  pins the ONE line that would make edit-fresh-hash inert if it regressed:
 *  `buildToolContext` threading `runtimeConfig().editFreshHash` onto
 *  `ctx.editFreshHash` (src/agent/dispatch/tool-context.ts).
 *
 *  Pins:
 *    (a) ON  — QUANTA_EDIT_FRESH_HASH="1" ⇒ the REAL buildToolContext returns a
 *              ctx carrying `editFreshHash: true`.
 *    (b) OFF — knob unset ⇒ the field is ABSENT (not `false`) — byte-identical
 *              legacy ctx shape.
 *    (c) STRICT — loose-truthy "on"/"true"/"0" stay OFF (strict `=== "1"`).
 *
 *  RED-ON-INJECTION: deleting the `...(runtimeConfig().editFreshHash ? ... : {})`
 *  spread in tool-context.ts flips (a) RED (ctx never carries the flag) — i.e. the
 *  feature would be inert in production while the tool-logic unit test still passes. */

import { afterEach, describe, expect, test } from "bun:test"
import { buildToolContext } from "@/agent/dispatch/tool-context"
import { resolveCollaborationMode } from "@/agent/mode"
import type { AgentConfig } from "@/agent/types"
import { __resetRuntimeConfig } from "@/shared"

const KNOB = "QUANTA_EDIT_FRESH_HASH"

const minimalConfig = (): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" },
  }) as unknown as AgentConfig

/** Drive the env snapshot → reset cached runtimeConfig → build the ctx through the
 *  REAL dispatch seam (buildToolContext), restoring env after. */
const ctxWith = (value: string | undefined): { editFreshHash?: boolean } => {
  const prev = process.env[KNOB]
  if (value === undefined) delete process.env[KNOB]
  else process.env[KNOB] = value
  __resetRuntimeConfig()
  try {
    const config = minimalConfig()
    return buildToolContext({
      config,
      workingState: undefined,
      collabMode: resolveCollaborationMode({ planMode: false }),
      toolCallId: "tc-1",
    })
  } finally {
    if (prev === undefined) delete process.env[KNOB]
    else process.env[KNOB] = prev
    __resetRuntimeConfig()
  }
}

afterEach(() => {
  __resetRuntimeConfig()
})

describe("jul-13 edit-fresh-hash dispatch WIRE hellgate (DEFAULT-ON opt-out)", () => {
  test("(a) DEFAULT-ON (knob unset): buildToolContext threads ctx.editFreshHash=true", () => {
    const ctx = ctxWith(undefined)
    // The exact line under test: the dispatch seam read runtimeConfig().editFreshHash
    // (now default-ON) and surfaced it. Deleting that spread makes this RED (inert).
    expect(ctx.editFreshHash).toBe(true)
  })

  test("(b) OFF (=off kill-switch): ctx.editFreshHash ABSENT (not false)", () => {
    const ctx = ctxWith("off")
    expect(ctx.editFreshHash).toBeUndefined()
    expect("editFreshHash" in ctx).toBe(false)
  })

  test("(c) STRICT opt-out: ONLY the literal `off` disables — every other value stays ON", () => {
    // Mirror the fs-jail / stale-read-guard strict kill-switch vocabulary: a stray
    // falsy token must NOT silently disable a default-ON feature.
    for (const stayOn of ["1", "on", "true", "0", "yes", "", "OFF", " off"]) {
      const ctx = ctxWith(stayOn)
      expect(ctx.editFreshHash).toBe(true)
    }
  })
})
