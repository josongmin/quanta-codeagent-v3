/**
 * ★ HELLGATE (MR-08 item 1) — the sticky-model STORAGE KEY is vetted, not merely
 * classified.
 *
 * `~/.quanta/sticky-model.json` is untrusted: any local process, and the agent's
 * own bash tool, can write it. Its VALUES have been vetted since aug-28
 * (`isPlausibleModelSlug`). Its KEYS were only ever CLASSIFIED — the boot vetting
 * asked `key.includes(":")` and `key.startsWith(`${provider}:`)`, which decide
 * WHOSE a key is and never WHETHER it is one.
 *
 * MEASURED, pre-fix: a file holding
 *   {"anthropic:<ESC>[2J<ESC>]0;pwned<BEL>default": "claude-sonnet-4-6"}
 * passed vetting untouched (the key contains a colon and starts with
 * `anthropic:`; the value is a perfectly ordinary slug), seeded the session cell,
 * and reached `/sticky-model`'s listing verbatim. Key length was unbounded.
 *
 * The cases below drive the REAL codec — no hand-rolled parser lives in this
 * file. Two of them are DRIFT GUARDS rather than examples: every member of
 * `AGENT_PROMPT_MODES` and every member of `LLM_PROVIDERS` must parse, so a mode
 * or vendor added upstream cannot silently start reading as "invalid" and
 * dropping a real user preference.
 *
 * RED-on-injection (each verified, then restored from a `cp` backup):
 *   - replace the mode check with `mode.length > 0`  ⇒ HOSTILE-1/2 go green→red.
 *   - drop the length cap                            ⇒ LENGTH case reds.
 *   - make `isStickyModelKeyInScope` return true for a scoped key regardless of
 *     provider                                       ⇒ SCOPE-2 reds.
 */

import { describe, expect, test } from "bun:test"
import { LLM_PROVIDERS } from "@/llm/provider-types"
import { AGENT_PROMPT_MODES } from "@/shared"
import {
  isStickyModelKeyInScope,
  parseStickyModelStorageKey,
  STICKY_MODEL_KEY_MAX_LENGTH,
  stickyModelKeyOf,
} from ".."

/** The two shapes the store itself has ever written, exactly as `stickyModelKeyOf`
 *  composes them — so the codec is tested against the PRODUCER, not against a
 *  literal a test author guessed. */
const canonicalScoped = (provider: string, mode: string): string =>
  stickyModelKeyOf({ mode: mode as never, provider })

describe("MR-08 · sticky-model storage-key codec", () => {
  // ── drift guards ─────────────────────────────────────────────────────────
  test("DRIFT-1: every AGENT_PROMPT_MODES member parses as a legacy bare key", () => {
    for (const mode of AGENT_PROMPT_MODES) {
      expect(parseStickyModelStorageKey(mode)).toEqual({ kind: "legacy", mode })
    }
    // Population floor — an empty SSOT would make the loop above vacuous.
    expect(AGENT_PROMPT_MODES.length).toBeGreaterThanOrEqual(6)
  })

  test("DRIFT-2: every LLM_PROVIDERS × AGENT_PROMPT_MODES pair parses as scoped", () => {
    let checked = 0
    for (const provider of LLM_PROVIDERS) {
      for (const mode of AGENT_PROMPT_MODES) {
        expect(parseStickyModelStorageKey(canonicalScoped(provider, mode))).toEqual({
          kind: "scoped",
          provider,
          mode,
        })
        checked += 1
      }
    }
    expect(checked).toBe(LLM_PROVIDERS.length * AGENT_PROMPT_MODES.length)
    expect(checked).toBeGreaterThanOrEqual(42)
  })

  test("DRIFT-3: the longest constructible canonical key fits under the length cap", () => {
    // The cap must never be able to reject a key the store itself writes. Derived
    // from the SSOTs rather than asserted as a literal, so adding a long vendor
    // name fails HERE (visibly) instead of at a user's boot (silently).
    const longest = Math.max(
      ...LLM_PROVIDERS.flatMap((p) => AGENT_PROMPT_MODES.map((m) => canonicalScoped(p, m).length)),
    )
    expect(longest).toBeLessThanOrEqual(STICKY_MODEL_KEY_MAX_LENGTH)
  })

  // ── the hostile keys the pre-fix classifier admitted ─────────────────────
  test("HOSTILE-1: a scoped key whose MODE segment carries ANSI/OSC + a newline is invalid", () => {
    const key = "anthropic:\u001b[2J\u001b]0;pwned\u0007default"
    // Paired control on the very thing the old check asked: this key DOES contain
    // a colon and DOES start with `anthropic:` — the properties the pre-fix
    // classifier accepted it on.
    expect(key.includes(":")).toBe(true)
    expect(key.startsWith("anthropic:")).toBe(true)
    const parsed = parseStickyModelStorageKey(key)
    expect(parsed.kind).toBe("invalid")
    expect(isStickyModelKeyInScope(parsed, "anthropic")).toBe(false)
  })

  test("HOSTILE-2: a BARE key carrying an SGR escape is invalid (the legacy branch)", () => {
    const parsed = parseStickyModelStorageKey("\u001b[31mdefault")
    expect(parsed.kind).toBe("invalid")
    expect(isStickyModelKeyInScope(parsed, undefined)).toBe(false)
  })

  test("HOSTILE-3: a forged banner line smuggled through the PROVIDER segment is invalid", () => {
    const parsed = parseStickyModelStorageKey("anthro\npic:default")
    expect(parsed.kind).toBe("invalid")
  })

  test("LENGTH: a key past the cap is rejected, and the reason never quotes it", () => {
    const key = `anthropic:${"a".repeat(STICKY_MODEL_KEY_MAX_LENGTH)}`
    const parsed = parseStickyModelStorageKey(key)
    expect(parsed.kind).toBe("invalid")
    if (parsed.kind !== "invalid") throw new Error("expected invalid")
    // The rejection REASON is operator-facing text that a caller concatenates into
    // a log line, so it must not become a second echo channel for the payload.
    expect(parsed.reason).not.toContain("aaaa")
    // Paired control: one char UNDER the cap is only rejected on its mode, and
    // the reason says so — proving the length branch, not a catch-all, fired above.
    const under = `anthropic:${"a".repeat(STICKY_MODEL_KEY_MAX_LENGTH - "anthropic:".length)}`
    expect(under.length).toBe(STICKY_MODEL_KEY_MAX_LENGTH)
    const underParsed = parseStickyModelStorageKey(under)
    expect(underParsed.kind).toBe("invalid")
    if (underParsed.kind !== "invalid") throw new Error("expected invalid")
    expect(underParsed.reason).toContain("mode")
  })

  test("EDGE: empty, colon-only, unknown vendor, unknown mode, and a double colon", () => {
    const verdicts = [
      "",
      ":",
      "default:",
      ":default",
      "notavendor:default",
      "anthropic:turbo",
      "anthropic:openai:default",
      "turbo",
      "Default",
      " default",
      "default ",
    ].map((k) => [k, parseStickyModelStorageKey(k).kind] as const)
    expect(verdicts.every(([, kind]) => kind === "invalid")).toBe(true)
  })

  // ── scope semantics (preserved exactly) ──────────────────────────────────
  test("SCOPE-1: a scoped key is in scope for its OWN provider only", () => {
    const key = parseStickyModelStorageKey("openai:default")
    expect(isStickyModelKeyInScope(key, "openai")).toBe(true)
    expect(isStickyModelKeyInScope(key, "anthropic")).toBe(false)
  })

  test("SCOPE-2: a scoped key is out of scope for a session with NO provider", () => {
    // Nothing to compare against ⇒ the pick cannot be claimed. (Pre-fix this was
    // the `provider === undefined` arm of the old prefix test; it is preserved.)
    expect(isStickyModelKeyInScope(parseStickyModelStorageKey("openai:plan"), undefined)).toBe(
      false,
    )
  })

  test("SCOPE-3: a LEGACY bare key is in scope for every provider and for none", () => {
    const key = parseStickyModelStorageKey("review")
    expect(isStickyModelKeyInScope(key, "openai")).toBe(true)
    expect(isStickyModelKeyInScope(key, "anthropic")).toBe(true)
    expect(isStickyModelKeyInScope(key, undefined)).toBe(true)
  })
})
