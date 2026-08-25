// source-grep allowed: asserts the CLI composition root consumes the canonical seed union.
/**
 * HELLGATE — WS-E.2 (jul-10, UUX-1-09 / UUX-6-26): CLI-seeded gate ⟷ /help
 * ENV-table parity.
 *
 * The bug: `/help`'s env table was derived from the RuntimeConfig SSOT only,
 * so EVERY gate the CLI host seeds default-ON via `CLI_FEATURE_GATES`
 * (QUANTA_READ_DEDUP, QUANTA_EXTERNAL_EDITOR, QUANTA_KEYBINDINGS, …) was
 * invisible — the operator had no discoverable OFF switch for behavior that
 * is ON out of the box.
 *
 * Structural kill: the gate list is data (`cli-feature-gates.ts`, each entry
 * with a one-line description); `/help` renders ENV = curated ENV_TABLE ∪
 * derived seeded-gate rows. THIS parity gate pins:
 *   (a) every CLI_FEATURE_GATES entry appears in the rendered help as an env
 *       ROW exactly once (adding a gate without copy ⇒ RED; double-printing a
 *       gate that also lives in ENV_TABLE ⇒ RED),
 *   (b) descriptions are non-empty and don't start with a QUANTA_ token (row
 *       keys are detected by line prefix),
 *   (c) the seed loop in index.ts consumes THIS module (no parallel list to
 *       drift — source-scan, index.ts has top-level side effects).
 *
 * RED-first proof: (a) is RED at HEAD for every seeded gate that is not a
 * curated ENV_TABLE row (16 of 17).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CLI_FEATURE_GATES } from "@/apps/cli/cli-feature-gates"
import { CLI_SEEDED_GATES } from "@/apps/cli/cli-seeded-gates"
import { renderHelp } from "@/apps/cli/help-render"
import { BUILTINS } from "@/apps/cli/slash-commands"
import { seedEnvVarsForSurface } from "@/tool"
import { setColorPolicy, stripAnsi } from "@/ui/ui-helpers"

beforeEach(() => setColorPolicy("off"))
afterEach(() => setColorPolicy(null))

/** Count the RENDERED ENV ROWS whose key column is `gate`. A row key sits at
 *  the start of a box line (after the border + pad), followed by column
 *  padding — a describe-text MENTION of a gate is mid-line and not counted. */
const envRowCount = (out: string, gate: string): number => {
  const rowKey = new RegExp(`^[│\\s]*${gate}\\s{2,}`)
  return out.split("\n").filter((l) => rowKey.test(l)).length
}

describe("CLI_FEATURE_GATES ⟷ /help env-table parity", () => {
  const out = stripAnsi(renderHelp(BUILTINS))

  for (const { gate } of CLI_FEATURE_GATES) {
    test(`${gate} appears as an env row exactly once`, () => {
      expect(envRowCount(out, gate)).toBe(1)
    })
  }

  for (const gate of seedEnvVarsForSurface("cli")) {
    test(`CLI-default tool gate ${gate} appears as an env row exactly once`, () => {
      expect(envRowCount(out, gate)).toBe(1)
    })
  }

  test("the canonical startup seed union is duplicate-free", () => {
    const names = CLI_SEEDED_GATES.map(({ gate }) => gate)
    expect(new Set(names).size).toBe(names.length)
  })

  test("gate list is non-empty and duplicate-free", () => {
    expect(CLI_FEATURE_GATES.length).toBeGreaterThan(0)
    const names = CLI_FEATURE_GATES.map((g) => g.gate)
    expect(new Set(names).size).toBe(names.length)
  })

  test("every description is a non-empty one-liner not starting with QUANTA_", () => {
    for (const { gate, describe: d } of CLI_FEATURE_GATES) {
      expect(d.trim().length, `${gate} needs a description`).toBeGreaterThan(0)
      expect(d.includes("\n")).toBe(false)
      // Row-key detection is prefix-based; a describe that STARTS with a
      // QUANTA_ token would be miscounted as a second row.
      expect(/^QUANTA_/.test(d.trim())).toBe(false)
    }
  })
})

describe("seed loop consumes the canonical union (no parallel list)", () => {
  test("index.ts imports cli-seeded-gates and has no inline gate array", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "..", "src/apps/cli/index.ts"),
      "utf8",
    )
    expect(src).toContain("./cli-seeded-gates")
    expect(src).toContain("CLI_SEEDED_GATE_NAMES")
    // The old inline literal must be gone — otherwise two lists drift.
    expect(/const CLI_FEATURE_GATES\s*=\s*\[/.test(src)).toBe(false)
  })
})
