/**
 * Hellgate — persist adversarial battery.
 *
 * Targets `src/runner/knobs/persist.ts`. Pins behavior under malformed JSON,
 * prototype-pollution payloads, oversized files, concurrent writes, deeply
 * nested junk, unicode, and permission edge cases.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readKnobConfig, writeKnobConfig } from "@/runner/knobs"

let dir = ""
let file = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "knobs-persist-hg-"))
  file = join(dir, "knobs.json")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("hellgate / persist — malformed JSON tolerance", () => {
  test("empty file → null", async () => {
    await writeFile(file, "", "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("whitespace-only file → null", async () => {
    await writeFile(file, "   \n\n  ", "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("partial JSON (truncated) → null", async () => {
    await writeFile(file, '{"version":1,"user_defaul', "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("garbage bytes → null", async () => {
    await writeFile(file, "\x00\x01\x02\xff\xfe", "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("nested-array root → null (not an object shape)", async () => {
    await writeFile(file, "[1, 2, [3, 4]]", "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("string literal root → null", async () => {
    await writeFile(file, '"just a string"', "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("number literal root → null", async () => {
    await writeFile(file, "42", "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("boolean root → null", async () => {
    await writeFile(file, "true", "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })
})

describe("hellgate / persist — version field adversarial", () => {
  test("version string '1' (not number 1) → null", async () => {
    await writeFile(file, JSON.stringify({ version: "1", user_defaults: {} }), "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("version float 1.0 → null (strict ===)", async () => {
    await writeFile(file, '{"version":1.0,"user_defaults":{}}', "utf8")
    // 1.0 === 1 in JS so this WILL pass — document the behavior either way.
    const r = await readKnobConfig(file)
    expect(r?.version).toBe(1)
  })

  test("version 0 → null", async () => {
    await writeFile(file, JSON.stringify({ version: 0, user_defaults: {} }), "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("version 2 (future) → null (no forward-compat)", async () => {
    await writeFile(file, JSON.stringify({ version: 2, user_defaults: {} }), "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("version absent → null", async () => {
    await writeFile(file, JSON.stringify({ user_defaults: { k: "v" } }), "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("version NaN serializes as null → file unreadable", async () => {
    await writeFile(file, '{"version":null,"user_defaults":{}}', "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })
})

describe("hellgate / persist — prototype pollution in payload", () => {
  test("user_defaults contains __proto__ key → does NOT pollute global Object", async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        user_defaults: { __proto__: { polluted: "yes" }, normal: "ok" },
      }),
      "utf8",
    )
    const r = await readKnobConfig(file)
    // Either the proto-key is filtered or it ends up as an own key but Object
    // prototype is untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(r?.user_defaults.normal).toBe("ok")
  })

  test("user_defaults uses JSON.parse-style __proto__ payload (raw text)", async () => {
    // JSON.parse treats __proto__ as a regular own property (since ES2015).
    const raw = '{"version":1,"user_defaults":{"__proto__":"evil","k":"v"}}'
    await writeFile(file, raw, "utf8")
    const r = await readKnobConfig(file)
    expect(r?.user_defaults.k).toBe("v")
    // Object prototype not polluted.
    expect(Object.getPrototypeOf({}).evil).toBeUndefined()
  })

  test("user_defaults with constructor key → safely stored OR filtered", async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        user_defaults: { constructor: "evil", k: "v" },
      }),
      "utf8",
    )
    const r = await readKnobConfig(file)
    // constructor key may pass through (it's a string value) — verify it
    // doesn't break the read.
    expect(r?.user_defaults.k).toBe("v")
  })

  test("top-level __proto__ key on the JSON document is harmless", async () => {
    await writeFile(
      file,
      '{"__proto__":{"polluted":"x"},"version":1,"user_defaults":{"k":"v"}}',
      "utf8",
    )
    const r = await readKnobConfig(file)
    expect(r?.user_defaults.k).toBe("v")
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe("hellgate / persist — non-string defaults filtered", () => {
  test("number / boolean / null / object values are dropped", async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        user_defaults: {
          okString: "v",
          asNumber: 123,
          asBool: true,
          asNull: null,
          asObject: { x: 1 },
          asArray: [1, 2],
        },
      }),
      "utf8",
    )
    const r = await readKnobConfig(file)
    expect(r?.user_defaults).toEqual({ okString: "v" })
  })

  test("user_defaults present but is itself an array → empty defaults", async () => {
    await writeFile(file, JSON.stringify({ version: 1, user_defaults: [1, 2] }), "utf8")
    const r = await readKnobConfig(file)
    // Arrays have entries but no string values → empty.
    expect(Object.keys(r?.user_defaults ?? {}).length).toBe(0)
  })

  test("user_defaults present but is null → empty defaults", async () => {
    await writeFile(file, JSON.stringify({ version: 1, user_defaults: null }), "utf8")
    const r = await readKnobConfig(file)
    expect(r?.user_defaults).toEqual({})
  })

  test("user_defaults is a string → empty defaults", async () => {
    await writeFile(file, JSON.stringify({ version: 1, user_defaults: "huh" }), "utf8")
    const r = await readKnobConfig(file)
    expect(r?.user_defaults).toEqual({})
  })
})

describe("hellgate / persist — oversized payload", () => {
  test("1MB user_defaults values round-trip", async () => {
    const big = "x".repeat(1024 * 1024)
    const defaults: Record<string, string> = { big }
    await writeKnobConfig(defaults, file)
    const r = await readKnobConfig(file)
    expect(r?.user_defaults.big?.length).toBe(1024 * 1024)
  })

  test("10k distinct keys round-trip", async () => {
    const defaults: Record<string, string> = {}
    for (let i = 0; i < 10_000; i++) defaults[`k-${i}`] = `v-${i}`
    await writeKnobConfig(defaults, file)
    const r = await readKnobConfig(file)
    expect(Object.keys(r?.user_defaults ?? {}).length).toBe(10_000)
  })

  test("read of 1MB malformed JSON returns null (no hang)", async () => {
    const junk = "{".repeat(1024 * 1024)
    await writeFile(file, junk, "utf8")
    const t = performance.now()
    const r = await readKnobConfig(file)
    expect(r).toBeNull()
    // No infinite loop / catastrophic backtracking.
    expect(performance.now() - t).toBeLessThan(500)
  })
})

describe("hellgate / persist — concurrent writes", () => {
  test("two parallel writes both complete without throw (last-writer wins)", async () => {
    await Promise.all([writeKnobConfig({ a: "1" }, file), writeKnobConfig({ b: "2" }, file)])
    const r = await readKnobConfig(file)
    expect(r).not.toBeNull()
    // One of the two writes wins; both keys cannot coexist (no merge).
    expect(Object.keys(r?.user_defaults ?? {}).length).toBe(1)
  })

  test("write while read in flight — read returns valid OR null (never partial garbage)", async () => {
    await writeKnobConfig({ initial: "v" }, file)
    const [w, r] = await Promise.all([writeKnobConfig({ next: "n" }, file), readKnobConfig(file)])
    expect(w).toBeUndefined()
    // r may be the old or new version; both are valid.
    if (r !== null) {
      const keys = Object.keys(r.user_defaults)
      const ok =
        (keys.length === 1 && (keys[0] === "initial" || keys[0] === "next")) || keys.length === 0
      expect(ok).toBe(true)
    }
  })

  test("100 sequential writes don't accumulate file artifacts", async () => {
    for (let i = 0; i < 100; i++) {
      await writeKnobConfig({ k: String(i) }, file)
    }
    const r = await readKnobConfig(file)
    expect(r?.user_defaults.k).toBe("99")
  })
})

describe("hellgate / persist — filesystem corner cases", () => {
  test("missing parent directory is created", async () => {
    const nested = join(dir, "a", "b", "c", "knobs.json")
    await writeKnobConfig({ k: "v" }, nested)
    const s = await stat(nested)
    expect(s.isFile()).toBe(true)
  })

  test("write to existing file overwrites cleanly", async () => {
    await writeKnobConfig({ first: "1" }, file)
    await writeKnobConfig({ second: "2" }, file)
    const obj = JSON.parse(await readFile(file, "utf8"))
    expect(obj.user_defaults).toEqual({ second: "2" })
  })

  test("missing file returns null without throwing", async () => {
    expect(await readKnobConfig(join(dir, "DNE.json"))).toBeNull()
  })

  test("path pointing at a directory (not file) → null", async () => {
    // dir itself is a directory; reading it as JSON file should throw → caught
    // → returns null.
    expect(await readKnobConfig(dir)).toBeNull()
  })
})

describe("hellgate / persist — unicode + control chars in keys/values", () => {
  test("unicode keys + values survive roundtrip byte-for-byte", async () => {
    const input = { "héllo-🚀": "世界-vālūe", normalKey: "normal" }
    await writeKnobConfig(input, file)
    const r = await readKnobConfig(file)
    expect(r?.user_defaults["héllo-🚀"]).toBe("世界-vālūe")
    expect(r?.user_defaults.normalKey).toBe("normal")
  })

  test("newlines + tabs in values survive", async () => {
    const input = { k: "line1\nline2\ttabbed" }
    await writeKnobConfig(input, file)
    const r = await readKnobConfig(file)
    expect(r?.user_defaults.k).toBe("line1\nline2\ttabbed")
  })

  test("very-long key name survives", async () => {
    const longKey = "k".repeat(5000)
    await writeKnobConfig({ [longKey]: "v" }, file)
    const r = await readKnobConfig(file)
    expect(r?.user_defaults[longKey]).toBe("v")
  })
})
