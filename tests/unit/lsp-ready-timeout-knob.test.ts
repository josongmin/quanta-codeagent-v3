/**
 * Guard for the QUANTA_LSP_READY_TIMEOUT_MS knob (jun-23 LSP-03).
 *
 * The knob lets an operator raise the LSP readiness-probe budget for slow-but-
 * resolvable large repos WITHOUT a code change, and only on the LSP grounding
 * path. This test locks the env→runtimeConfig wiring so a future runtime-config
 * reconcile/refactor that silently drops the parse (making the knob inert →
 * always falling back to the 90s default) fails here instead of going unnoticed.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"

const KEY = "QUANTA_LSP_READY_TIMEOUT_MS"
const prior = process.env[KEY]

afterEach(() => {
  if (prior === undefined) delete process.env[KEY]
  else process.env[KEY] = prior
  __resetRuntimeConfig()
})

describe("QUANTA_LSP_READY_TIMEOUT_MS knob", () => {
  test("parses a positive int into runtimeConfig().lspReadyTimeoutMs", () => {
    process.env[KEY] = "180000"
    __resetRuntimeConfig()
    expect(runtimeConfig().lspReadyTimeoutMs).toBe(180000)
  })

  test("absent ⇒ undefined (so the LSP path falls back to its hardcoded default)", () => {
    delete process.env[KEY]
    __resetRuntimeConfig()
    expect(runtimeConfig().lspReadyTimeoutMs).toBeUndefined()
  })

  test("rejects garbage ⇒ undefined (no silent 0/NaN budget)", () => {
    process.env[KEY] = "not-a-number"
    __resetRuntimeConfig()
    expect(runtimeConfig().lspReadyTimeoutMs).toBeUndefined()
  })
})
