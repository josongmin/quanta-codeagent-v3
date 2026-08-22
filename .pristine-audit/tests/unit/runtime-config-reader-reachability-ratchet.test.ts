/**
 * Runtime-config reader-reachability ratchet.
 *
 * Two runtime-config fields carried honesty-notes claiming "zero production
 * consumers / byte-identical even when ON" long after their reader call-sites
 * actually landed. This ratchet pins the READER so that class of doc-drift
 * fails loudly: if the composition/setup site that reads the field is removed,
 * the corresponding note's "dead / zero-consumer" claim would silently become
 * true again — and this test goes red first.
 *
 * Structural on purpose: constructing the full MCP composition root or the
 * interactive REPL session-setup would hide the regression behind runtime
 * wiring. The field-parsing and gate behavior are owned by the sibling
 * `mcp-sampling-*` and `statusline-config-knob-hellgate` tests; this file owns
 * reachability of the reader (the exact claim the notes make).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const srcRoot = join(import.meta.dir, "..", "..", "src")

const mcpCompositionPath = join(srcRoot, "host", "mcp-composition.ts")
const sessionSetupPath = join(srcRoot, "apps", "cli", "repl", "session-setup.ts")

/** Match a real `runtimeConfig().<field>` read; imports/comments/a bare
 * identifier do not satisfy the reader obligation. */
const readerCalls = (source: string, field: string): readonly number[] =>
  [...source.matchAll(new RegExp(`runtimeConfig\\(\\)\\.${field}\\b`, "g"))].map(
    (match) => match.index ?? -1,
  )

describe("runtime-config reader-reachability ratchet", () => {
  test("mcpSampling has a live reader in host/mcp-composition.ts", () => {
    const source = readFileSync(mcpCompositionPath, "utf8")
    // Anti-vacuum floor: a zero-match drift must fail rather than silently
    // resurrect the "zero production consumers" note in runtime-config/types.ts.
    expect(readerCalls(source, "mcpSampling").length).toBeGreaterThan(0)
    // The read is passed into the sampling wiring gate (advertise-iff-able).
    expect(source).toMatch(/buildSamplingWiring\(\s*runtimeConfig\(\)\.mcpSampling/)
  })

  test("statusLineConfig has a live reader in apps/cli/repl/session-setup.ts", () => {
    const source = readFileSync(sessionSetupPath, "utf8")
    expect(readerCalls(source, "statusLineConfig").length).toBeGreaterThan(0)
    // The read drives the statusline driver construction when defined.
    expect(source).toMatch(/createStatusLineDriver\(/)
  })

  test("red-on-injection: removing a reader leaves no live reader", () => {
    const mcpSource = readFileSync(mcpCompositionPath, "utf8")
    const injected = mcpSource.replace(
      /runtimeConfig\(\)\.mcpSampling\b/g,
      "removedRuntimeConfigRead()",
    )
    expect(readerCalls(injected, "mcpSampling")).toHaveLength(0)
  })
})
