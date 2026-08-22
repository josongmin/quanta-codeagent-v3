import { describe, expect, test } from "bun:test"
import { DEFAULT_MODEL } from "@/llm/factory"

/**
 * chatgpt-oauth default model pin (jun-10; re-pinned aug-19).
 *
 * WHY a pinned slug: the original default `gpt-5` is not present in the
 * subscription catalog the `/codex/models` endpoint returns for current
 * ChatGPT accounts, so EVERY session opened with a silent-substitution warn
 * ("configured model "gpt-5" not in catalog — running "gpt-5.5" instead") and
 * ran whatever the server picked. The default must be a DELIBERATE slug that
 * actually exists in the catalog, not a bare-family name the server resolves
 * for us. Catalog drift safety stays intact: if an account's catalog ever
 * lacks the pinned slug, `resolveModelFromCatalog` still swaps to the catalog
 * default WITH the loud warn (pinned by the adapter hellgates).
 *
 * The pin was bumped `gpt-5.4` → `gpt-5.6-terra` on aug-19 (see the comment on
 * `DEFAULT_MODEL` in `@/llm/factory`); this test tracks the shipped value.
 */
describe("DEFAULT_MODEL — chatgpt-oauth", () => {
  test("subscription (GPT login) default is the deliberate gpt-5.6-terra pin", () => {
    expect(DEFAULT_MODEL["chatgpt-oauth"]).toBe("gpt-5.6-terra")
  })

  // The teeth that outlive any single slug: the default may NEVER regress to a
  // bare family name. `gpt-5` was the exact value that caused the silent
  // server-side substitution this pin exists to prevent.
  test("the default is never a bare family slug the server would substitute", () => {
    expect(DEFAULT_MODEL["chatgpt-oauth"]).not.toBe("gpt-5")
    expect(DEFAULT_MODEL["chatgpt-oauth"]).toMatch(/^gpt-5\.\d/)
  })
})
