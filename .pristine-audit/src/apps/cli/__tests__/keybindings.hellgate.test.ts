/**
 * RFC-11 / ADR-0447 — keybinding config loader + merge + key normalization
 * hellgate. Pure unit coverage of the fail-safe config layer:
 *
 *   §B-1  merge over defaults: a valid override adds the binding, defaults kept
 *   §B-2  bad config fail-safe (each defect ⇒ no throw, defaults survive):
 *           invalid JSON / version!=1 / not-an-object / bindings not object /
 *           unknown action / invalid key / duplicate modifier / non-string action
 *   §B-3  __proto__ / prototype / constructor keys rejected (pollution guard)
 *   §B-4  normalizeKeySpec canonicalization (case, modifier order, chord seq)
 *   §B-5  keyOf runtime projection round-trips with normalizeKeySpec
 *   §B-6  absent file ⇒ defaults, NO warning
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_KEYBINDINGS } from "../keybindings/defaults"
import { loadKeybindings, mergeOverDefaults } from "../keybindings/load"
import { keyOf, normalizeKeySpec } from "../keybindings/normalize"

const tmpFile = async (content: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "quanta-kb-test-"))
  const path = join(dir, "keybindings.json")
  await writeFile(path, content, "utf8")
  return path
}

describe("RFC-11 keybindings — merge over defaults", () => {
  test("§B-1 valid override adds the binding AND keeps every default", () => {
    const { map, warnings } = mergeOverDefaults({
      version: 1,
      bindings: { "ctrl+p": "history-prev" },
    })
    expect(warnings).toEqual([])
    expect(map.get("ctrl+p")).toBe("history-prev")
    // every default survives
    for (const [k, v] of DEFAULT_KEYBINDINGS) expect(map.get(k)).toBe(v)
  })

  test("§B-1 override of an existing default key replaces its action", () => {
    const { map } = mergeOverDefaults({ version: 1, bindings: { tab: "submit" } })
    expect(map.get("tab")).toBe("submit")
    // unrelated defaults untouched
    expect(map.get("return")).toBe("submit")
    expect(map.get("ctrl+r")).toBe("reverse-search")
  })

  test("§B-1 case + modifier-order are normalized before merge", () => {
    const { map } = mergeOverDefaults({
      version: 1,
      bindings: { "Ctrl+P": "history-prev", "SHIFT+Ctrl+K": "abort" },
    })
    expect(map.get("ctrl+p")).toBe("history-prev")
    expect(map.get("ctrl+shift+k")).toBe("abort")
  })
})

describe("RFC-11 keybindings — fail-safe (never throws, defaults survive)", () => {
  const expectDefaults = (parsed: unknown): readonly string[] => {
    const { map, warnings } = mergeOverDefaults(parsed)
    expect(map).toBe(DEFAULT_KEYBINDINGS as never)
    return warnings
  }

  test("§B-2 version != 1 ⇒ defaults + warning", () => {
    const w = expectDefaults({ version: 2, bindings: { tab: "submit" } })
    expect(w.some((s) => s.includes("unknown version"))).toBe(true)
  })

  test("§B-2 non-object ⇒ defaults + warning", () => {
    expect(expectDefaults(42).length).toBeGreaterThan(0)
    expect(expectDefaults(null).length).toBeGreaterThan(0)
    expect(expectDefaults("nope").length).toBeGreaterThan(0)
  })

  test("§B-2 bindings not an object ⇒ defaults, no per-entry warning", () => {
    const { map, warnings } = mergeOverDefaults({ version: 1, bindings: [] })
    expect(map).toBe(DEFAULT_KEYBINDINGS as never)
    expect(warnings).toEqual([])
  })

  test("§B-2 unknown action ⇒ that entry dropped + warning, rest survive", () => {
    const { map, warnings } = mergeOverDefaults({
      version: 1,
      bindings: { "ctrl+p": "explode", tab: "submit" },
    })
    expect(map.get("ctrl+p")).toBeUndefined()
    expect(map.get("tab")).toBe("submit")
    expect(warnings.some((s) => s.includes("unknown action `explode`"))).toBe(true)
  })

  test("§B-2 invalid key ⇒ dropped + `invalid keybinding` warning", () => {
    const { warnings } = mergeOverDefaults({
      version: 1,
      bindings: { "not a real key!!": "submit" },
    })
    expect(warnings.some((s) => s.startsWith("invalid keybinding"))).toBe(true)
  })

  test("§B-2 duplicate modifier ⇒ `duplicate modifier` warning", () => {
    const { warnings } = mergeOverDefaults({
      version: 1,
      bindings: { "ctrl+ctrl+e": "open-editor" },
    })
    expect(warnings.some((s) => s.startsWith("duplicate modifier"))).toBe(true)
  })

  test("§B-2 non-string action ⇒ `missing action` warning", () => {
    const { warnings } = mergeOverDefaults({ version: 1, bindings: { "ctrl+p": 123 } })
    expect(warnings.some((s) => s.includes("missing action"))).toBe(true)
  })

  test("§B-2 two configs mapping to same normalized key ⇒ duplicate warning", () => {
    const { warnings } = mergeOverDefaults({
      version: 1,
      bindings: { "ctrl+p": "history-prev", "Ctrl+P": "history-next" },
    })
    expect(warnings.some((s) => s.startsWith("duplicate keybinding"))).toBe(true)
  })
})

describe("RFC-11 keybindings — prototype-pollution guard", () => {
  test("§B-3 __proto__ / prototype / constructor keys are declined", () => {
    const { map, warnings } = mergeOverDefaults({
      version: 1,
      bindings: { __proto__: "submit", prototype: "abort", constructor: "abort", tab: "submit" },
    })
    // The valid `tab` entry still merges; the pollution keys are dropped silently.
    expect(map.get("tab")).toBe("submit")
    // No pollution of the resulting map's prototype chain.
    expect(Object.getPrototypeOf(map)).toBe(Map.prototype)
    expect(warnings.every((w) => !w.includes("__proto__"))).toBe(true)
    // The base prototype is untouched.
    // biome-ignore lint/suspicious/noExplicitAny: prototype-pollution probe
    expect(({} as any).submit).toBeUndefined()
  })
})

describe("RFC-11 keybindings — normalizeKeySpec", () => {
  test("§B-4 single chord lower-cases + orders modifiers", () => {
    expect(normalizeKeySpec("Ctrl+X")).toEqual({ spec: "ctrl+x" })
    expect(normalizeKeySpec("Shift+Ctrl+K")).toEqual({ spec: "ctrl+shift+k" })
    expect(normalizeKeySpec("UP")).toEqual({ spec: "up" })
  })

  test("§B-4 chord SEQUENCE joins with a single space", () => {
    expect(normalizeKeySpec("Ctrl+X Ctrl+E")).toEqual({ spec: "ctrl+x ctrl+e" })
  })

  test("§B-4 empty / malformed ⇒ invalid error", () => {
    expect(normalizeKeySpec("")).toEqual({ error: "invalid" })
    expect(normalizeKeySpec("ctrl+")).toEqual({ error: "invalid" })
    expect(normalizeKeySpec("ctrl+x+y")).toEqual({ error: "invalid" })
    expect(normalizeKeySpec("nonsensekey")).toEqual({ error: "invalid" })
  })

  test("§B-4 repeated modifier ⇒ duplicate error", () => {
    expect(normalizeKeySpec("ctrl+ctrl+e")).toEqual({ error: "duplicate" })
  })
})

describe("RFC-11 keybindings — keyOf runtime projection", () => {
  test("§B-5 ctrl chord projects to canonical token", () => {
    expect(keyOf({ name: "r", ctrl: true })).toBe("ctrl+r")
    expect(keyOf({ name: "x", ctrl: true })).toBe("ctrl+x")
  })

  test("§B-5 named keys project bare", () => {
    expect(keyOf({ name: "up" })).toBe("up")
    expect(keyOf({ name: "return" })).toBe("return")
  })

  test("§B-5 a plain printable letter projects to its bare key (no shift noise)", () => {
    expect(keyOf({ name: "a" })).toBe("a")
  })

  test("§B-5 unknown / nameless event ⇒ null (falls through to insert path)", () => {
    expect(keyOf({})).toBeNull()
    expect(keyOf({ name: "f13" })).toBeNull()
  })

  test("§B-5 the default open-editor sequence round-trips", () => {
    const norm = normalizeKeySpec("ctrl+x ctrl+e")
    expect(norm).toEqual({ spec: "ctrl+x ctrl+e" })
    expect(DEFAULT_KEYBINDINGS.get("ctrl+x ctrl+e")).toBe("open-editor")
  })
})

describe("RFC-11 keybindings — file loader", () => {
  test("§B-6 absent file ⇒ defaults, NO warning", async () => {
    const { map, warnings } = await loadKeybindings(join(tmpdir(), "definitely-missing-xyz.json"))
    expect(map).toBe(DEFAULT_KEYBINDINGS as never)
    expect(warnings).toEqual([])
  })

  test("§B-2 invalid JSON file ⇒ defaults + warning (no throw)", async () => {
    const path = await tmpFile("{ not json ]")
    const { map, warnings } = await loadKeybindings(path)
    expect(map).toBe(DEFAULT_KEYBINDINGS as never)
    expect(warnings.some((s) => s.includes("invalid JSON"))).toBe(true)
  })

  test("§B-1 valid file ⇒ merged map", async () => {
    const path = await tmpFile(
      JSON.stringify({ version: 1, bindings: { "ctrl+p": "history-prev" } }),
    )
    const { map } = await loadKeybindings(path)
    expect(map.get("ctrl+p")).toBe("history-prev")
    expect(map.get("return")).toBe("submit")
  })
})
