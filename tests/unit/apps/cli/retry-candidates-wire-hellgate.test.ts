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
 *   RETRY-CAND-07  every port is DECORATED, never a bare adapter (INVARIANT B)
 *   RETRY-CAND-08  decoration does not eat the port's capability surface
 *   RETRY-CAND-09  the CONSUMER (`/model`'s catalog) really receives the
 *                  decorated port — these candidates are seeded VERBATIM
 *
 * MR-07 — WHY -07..-09 EXIST. These candidates stopped being `/retry-with`-only:
 * `surface-compose/core-state` hands them to `buildModelCatalogWire` as `seeded`,
 * and the catalog takes a seeded port VERBATIM (it only mints its own for
 * probe-discovered ids). The builder minted `tryCreateLLM(...)` BARE, so a
 * `/model` pick of a `QUANTA_RETRY_MODELS` id swapped the whole turn onto an
 * undecorated adapter — no bounded retry (a transient 429 became a hard turn
 * failure), no empty-stream circuit breaker, no progress heartbeat — while a
 * probe-discovered pick of the identical shape got all three. The `instanceof`
 * PAIRED CONTROL below is what makes -07 non-vacuous: it proves the same
 * `tryCreateLLM` call still yields a bare adapter, so "not an adapter instance"
 * is evidence of decoration and not of a broken factory.
 */

import { describe, expect, test } from "bun:test"
import { tryCreateLLM } from "@/llm"
import { OpenAIResponsesAdapter } from "@/llm/adapters/openai-responses"
import { buildModelCatalogWire } from "@/llm/model-catalog"
import { decorateSwappableModelPort } from "@/runner/assemble"
import { buildRetryCandidates } from "../../../../src/apps/cli/repl/surface-compose"

const KEYED = { OPENAI_API_KEY: "sk-test-key" } as NodeJS.ProcessEnv

/** An anthropic env whose adapter pins a `contextWindowKey` (`QUANTA_CONTEXT_1M`
 *  + a 1M-eligible model) — the field three decorators historically ATE. */
const ANTHROPIC_1M = {
  ANTHROPIC_API_KEY: "sk-ant-test-key",
  QUANTA_CONTEXT_1M: "1",
  QUANTA_RETRY_MODELS: "claude-sonnet-4-5",
} as NodeJS.ProcessEnv

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

  test("RETRY-CAND-07 — every port is DECORATED, not the bare adapter (INVARIANT B)", () => {
    const env = { ...KEYED, QUANTA_RETRY_MODELS: "gpt-4o" }
    const out = buildRetryCandidates(env, "openai", "gpt-5")
    expect(out.map((c) => c.id)).toEqual(["gpt-5", "gpt-4o"])

    // PAIRED CONTROL — the same factory call the builder makes still returns a
    // BARE adapter instance. Without this the `not.toBeInstanceOf` below would
    // also pass if `tryCreateLLM` had simply stopped returning that class.
    const bare = tryCreateLLM("openai", { model: "gpt-4o" }, env)
    expect(bare).toBeInstanceOf(OpenAIResponsesAdapter)

    for (const c of out) {
      expect(c.port, `${c.id} was seeded BARE`).not.toBeInstanceOf(OpenAIResponsesAdapter)
      // …and it is the SAME decorator chain the catalog's own `buildPort` uses:
      // identical own-key surface as a reference decoration of the same adapter.
      const reference = decorateSwappableModelPort({ inner: bare as NonNullable<typeof bare> })
      expect(Object.keys(c.port).sort()).toEqual(Object.keys(reference).sort())
    }
  })

  test("RETRY-CAND-08 — decoration forwards the capability surface (listModels + contextWindowKey)", () => {
    const out = buildRetryCandidates(ANTHROPIC_1M, "anthropic", "claude-sonnet-4-6")
    expect(out.map((c) => c.id)).toEqual(["claude-sonnet-4-6", "claude-sonnet-4-5"])

    for (const c of out) {
      const bare = tryCreateLLM("anthropic", { model: c.id }, ANTHROPIC_1M)
      // The bare adapter is the ground truth for what MUST survive the wrappers.
      expect(bare?.contextWindowKey, `${c.id}: control has no window key`).toBe(`${c.id}-1m`)
      expect(typeof bare?.listModels).toBe("function")

      expect(c.port.model).toBe(c.id)
      expect(c.port.contextWindowKey, `${c.id}: decoration ATE contextWindowKey`).toBe(`${c.id}-1m`)
      expect(typeof c.port.listModels, `${c.id}: decoration ATE listModels`).toBe("function")
      // MR-07 — and it must still accept the cancellation signal (arity kept).
      expect(c.port.listModels?.length).toBe(1)
    }
  })

  test("RETRY-CAND-09 — the catalog seeds the DECORATED port verbatim (the consumer sees it)", () => {
    const env = { ...KEYED, QUANTA_RETRY_MODELS: "gpt-4o" }
    const seeded = buildRetryCandidates(env, "openai", "gpt-5")
    const catalog = buildModelCatalogWire({
      provider: "openai",
      bootModel: "gpt-5",
      llm: seeded[0]?.port as NonNullable<(typeof seeded)[number]>["port"],
      seeded,
      env,
    })

    // Boot model excluded from `candidates` (invariant A) — `gpt-4o` is the pick.
    expect(catalog.candidates.map((c) => c.id)).toEqual(["gpt-4o"])
    expect(catalog.ids()).toEqual(["gpt-5", "gpt-4o"])
    const picked = catalog.candidates[0]?.port
    expect(picked).toBeDefined()
    expect(picked, "a /model pick of a QUANTA_RETRY_MODELS id runs UNDECORATED").not.toBeInstanceOf(
      OpenAIResponsesAdapter,
    )
    // Verbatim: the catalog must not re-mint (that would drop the decoration too).
    expect(picked).toBe(seeded[1]?.port)
  })
})
