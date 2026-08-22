import { describe, expect, test } from "bun:test"
import { DEFAULT_MODEL } from "@/llm/factory"

/**
 * chatgpt-oauth default model pin (jun-10).
 *
 * WHY gpt-5.4: the prior default `gpt-5` is not present in the subscription
 * catalog the `/codex/models` endpoint returns for current ChatGPT accounts,
 * so EVERY session opened with a silent-substitution warn
 * ("configured model "gpt-5" not in catalog — running "gpt-5.5" instead") and
 * ran whatever the server picked. The default must be a slug that actually
 * exists in the catalog so the operator's session starts on a deliberate
 * model, not a server-side fallback. Catalog drift safety stays intact: if an
 * account's catalog ever lacks gpt-5.4, `resolveModelFromCatalog` still swaps
 * to the catalog default WITH the loud warn (pinned by the adapter hellgates).
 */
describe("DEFAULT_MODEL — chatgpt-oauth", () => {
  test("subscription (GPT login) default is gpt-5.4", () => {
    expect(DEFAULT_MODEL["chatgpt-oauth"]).toBe("gpt-5.4")
  })
})
