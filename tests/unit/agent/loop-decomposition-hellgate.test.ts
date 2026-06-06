/**
 * Structural hellgate — loop.ts Phase-1 decomposition must stay split.
 *
 * Prevents re-inlining turn-gate / turn-outcome into the monolith.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../../..")
const loopSrc = readFileSync(join(ROOT, "src/agent/loop.ts"), "utf8")

describe("loop decomposition hellgate (phase 1)", () => {
  test("turn-gate lives in dedicated module", () => {
    expect(readFileSync(join(ROOT, "src/agent/loop/turn-gate.ts"), "utf8")).toContain(
      "export const classifyTurnAbort",
    )
    expect(loopSrc).toContain('from "./loop/turn-gate"')
    expect(loopSrc).not.toMatch(/const classifyTurnAbort\s*=/)
    expect(loopSrc).not.toMatch(/const buildTurnSessionView\s*=/)
  })

  test("turn-outcome lives in dedicated module", () => {
    expect(readFileSync(join(ROOT, "src/agent/loop/turn-outcome.ts"), "utf8")).toContain(
      "export const resolveTurnLoopOutcome",
    )
    expect(loopSrc).toContain('from "./loop/turn-outcome"')
    expect(loopSrc).not.toMatch(/const resolveTurnLoopOutcome\s*=/)
    expect(loopSrc).not.toMatch(/const shouldParkOnGate\s*=/)
  })

  test("shared loop types live in loop/types.ts", () => {
    const typesSrc = readFileSync(join(ROOT, "src/agent/loop/types.ts"), "utf8")
    expect(typesSrc).toContain("export type TurnResult")
    expect(typesSrc).toContain("export type TurnLoopResolution")
    expect(loopSrc).toContain('from "./loop/types"')
    expect(loopSrc).not.toMatch(/type TurnLoopResolution\s*=/)
  })

  test("public runAgent export unchanged entrypoint", () => {
    expect(loopSrc).toContain("export const runAgent")
  })
})
