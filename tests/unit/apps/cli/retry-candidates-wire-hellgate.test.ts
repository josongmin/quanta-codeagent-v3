/**
 * Hellgate — `/retry-with` model-candidate env wiring (`buildRetryCandidates`).
 *
 * Pins the env→candidates parse that backs the `ctx.retry` slot the REPL
 * surface wires into the slash dispatch:
 *
 *   RETRY-CAND-01  unset `QUANTA_RETRY_MODELS` ⇒ [] (slot omitted, default-OFF)
 *   RETRY-CAND-02  empty / whitespace-only ⇒ []
 *   RETRY-CAND-03  comma list ⇒ current model prepended + each alternate
 *   RETRY-CAND-04  current model in the list ⇒ NOT duplicated (dedup)
 *   RETRY-CAND-05  missing provider key ⇒ candidate dropped (no crash)
 *   RETRY-CAND-06  blank entries between commas are skipped
 */

import { describe, expect, test } from "bun:test"
import { buildRetryCandidates } from "../../../../src/apps/cli/repl/surface-compose"

const KEYED = { OPENAI_API_KEY: "sk-test-key" } as NodeJS.ProcessEnv

describe("/retry-with buildRetryCandidates", () => {
  test("RETRY-CAND-01 — unset QUANTA_RETRY_MODELS ⇒ []", () => {
    expect(buildRetryCandidates(KEYED, "openai", "gpt-5")).toEqual([])
  })

  test("RETRY-CAND-02 — empty / whitespace ⇒ []", () => {
    expect(buildRetryCandidates({ ...KEYED, QUANTA_RETRY_MODELS: "" }, "openai", "gpt-5")).toEqual(
      [],
    )
    expect(
      buildRetryCandidates({ ...KEYED, QUANTA_RETRY_MODELS: "   " }, "openai", "gpt-5"),
    ).toEqual([])
  })

  test("RETRY-CAND-03 — comma list ⇒ current prepended + alternates", () => {
    const out = buildRetryCandidates(
      { ...KEYED, QUANTA_RETRY_MODELS: "gpt-4o,gpt-4o-mini" },
      "openai",
      "gpt-5",
    )
    expect(out.map((c) => c.id)).toEqual(["gpt-5", "gpt-4o", "gpt-4o-mini"])
    // Each candidate carries a live port.
    for (const c of out) expect(typeof c.port.stream).toBe("function")
  })

  test("RETRY-CAND-04 — current model in list is not duplicated", () => {
    const out = buildRetryCandidates(
      { ...KEYED, QUANTA_RETRY_MODELS: "gpt-5,gpt-4o" },
      "openai",
      "gpt-5",
    )
    expect(out.map((c) => c.id)).toEqual(["gpt-5", "gpt-4o"])
  })

  test("RETRY-CAND-05 — missing provider key ⇒ candidates dropped (no crash)", () => {
    const out = buildRetryCandidates(
      { QUANTA_RETRY_MODELS: "gpt-4o" } as NodeJS.ProcessEnv,
      "openai",
      "gpt-5",
    )
    expect(out).toEqual([])
  })

  test("RETRY-CAND-06 — blank entries between commas skipped", () => {
    const out = buildRetryCandidates(
      { ...KEYED, QUANTA_RETRY_MODELS: "gpt-4o, ,, gpt-4o-mini ," },
      "openai",
      "gpt-5",
    )
    expect(out.map((c) => c.id)).toEqual(["gpt-5", "gpt-4o", "gpt-4o-mini"])
  })
})
