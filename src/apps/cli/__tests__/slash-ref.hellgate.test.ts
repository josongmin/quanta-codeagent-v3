/**
 * HELLGATE — WS-E.3 (jul-10, UUX-5-01): `slashRef` ghost-command gate.
 *
 * The bug class: user-facing copy hand-names slash commands and rots — the
 * context warning advertised `/compact` (a command that does NOT exist; the
 * real one is `/summarize-now`) and its own hellgate PINNED the ghost string.
 *
 * Structural kill: copy may only reference a command through `slashRef(name)`
 * whose argument type is the {@link REFERENCED_SLASH_COMMANDS} literal union,
 * and THIS test asserts every member of that union resolves in the LIVE
 * registries (BUILTINS + REPL virtual /exit + /quit + REPL-scoped /image).
 * A ghost reference is therefore structurally impossible: either the call
 * site fails to typecheck, or this test is RED.
 *
 * RED-first proof: with the current `/compact` copy converted to
 * `slashRef("compact")`, "compact" is in the referenced list and absent from
 * the registries ⇒ RED. GREEN after the copy fix (`summarize-now`).
 */

import { describe, expect, test } from "bun:test"
import { renderContextWarning } from "../context-warning"
import { BUILTINS } from "../slash-commands"
import { REFERENCED_SLASH_COMMANDS, slashRef } from "../slash-ref"

/** Commands dispatchable in the REPL but NOT `SlashCommand` entries:
 *  `/exit` + `/quit` (short-circuited by composePromptPipeline) and `/image`
 *  (intercepted by dispatchReplSlash — REPL-scoped queue). Mirrors the
 *  VIRTUAL_COMMANDS tail help-render renders. */
const REPL_VIRTUAL_NAMES: readonly string[] = ["/exit", "/quit", "/image"]

const liveSlashNames = (): ReadonlySet<string> =>
  new Set([...BUILTINS.map((c) => c.name), ...REPL_VIRTUAL_NAMES])

describe("slashRef — every referenced command exists in the live registries", () => {
  const live = liveSlashNames()

  for (const name of REFERENCED_SLASH_COMMANDS) {
    test(`slashRef("${name}") resolves to a real command`, () => {
      // A failure here means copy references a GHOST command: fix the copy
      // (and this list) — do NOT add the name to the registry to appease it.
      expect(live.has(slashRef(name))).toBe(true)
    })
  }

  test("slashRef renders the canonical leading-slash form", () => {
    expect(slashRef("help")).toBe("/help")
  })

  test("referenced list has no duplicates", () => {
    expect(new Set(REFERENCED_SLASH_COMMANDS).size).toBe(REFERENCED_SLASH_COMMANDS.length)
  })
})

describe("slashRef adoption — context warning names only REAL commands", () => {
  test("both warning branches reference existing commands (no /compact ghost)", () => {
    const live = liveSlashNames()
    const branches = [
      // compaction-imminent branch (compact ratio ≥ 90%)
      renderContextWarning({ usedTokens: 110_000, max: 200_000, compactThreshold: 120_000 }),
      // window-fullness branch (window ratio ≥ 80%)
      renderContextWarning({ usedTokens: 96_000, max: 120_000, compactThreshold: 1_000_000 }),
    ]
    for (const s of branches) {
      expect(s).not.toBe("")
      const referenced = [...s.matchAll(/\/[a-z][a-z0-9-]*/g)].map((m) => m[0])
      expect(referenced.length).toBeGreaterThan(0)
      for (const name of referenced) {
        expect(live.has(name)).toBe(true)
      }
    }
  })
})
