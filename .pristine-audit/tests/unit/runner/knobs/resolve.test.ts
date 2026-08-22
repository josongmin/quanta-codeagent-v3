/**
 * Resolver — layer precedence, default fallback, parse-error surface.
 *
 * Each test passes the knob set directly (not via the global registry) so
 * we exercise the closed-port contract: resolve consumes ONLY ResolveArgs.
 */
import { describe, expect, test } from "bun:test"
import { type AnyKnob, asAnyKnob, type Knob, KnobParseError, resolveKnobs } from "@/runner/knobs"

const boolParse = (raw: string | undefined): boolean | undefined =>
  raw === "1" ? true : raw === "0" ? false : undefined

const numParse = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

const mk = <T>(id: string, parse: Knob<T>["parse"], default_?: T | undefined): Knob<T> => ({
  id,
  envKey: `Q_${id.toUpperCase().replace(/-/g, "_")}`,
  category: "tool",
  surfaces: ["bench"],
  parse,
  apply: (cfg) => cfg,
  describe: id,
  ...(default_ !== undefined ? { default: default_ } : {}),
})

/**
 * Build a `ReadonlyMap<string, AnyKnob>` from heterogeneously-typed knobs.
 * Each entry passes through `asAnyKnob` because under EOPT a `Knob<boolean>`
 * is NOT assignable to `Knob<unknown>` directly. Argument list types are
 * loose so callers can pass `Knob<T>` for any T without a per-call wrap.
 */
const knobMap = (...ks: ReadonlyArray<unknown>): ReadonlyMap<string, AnyKnob> => {
  const m = new Map<string, AnyKnob>()
  for (const k of ks) {
    const knob = k as { id: string }
    m.set(knob.id, asAnyKnob(k as Knob<unknown>))
  }
  return m
}
const wide = <T>(k: Knob<T>): AnyKnob => asAnyKnob(k)

describe("resolveKnobs — layer precedence", () => {
  const k = mk<boolean>("lsp", boolParse)
  const knobs = knobMap(wide(k))

  test("CLI beats session", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs,
      cliArgs: { lsp: "1" },
      sessionOverrides: { lsp: "0" },
    })
    expect(r.get("lsp")?.source).toBe("cli")
    expect(r.get("lsp")?.value).toBe(true)
  })

  test("session beats env", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs,
      sessionOverrides: { lsp: "1" },
      envVars: { Q_LSP: "0" } as NodeJS.ProcessEnv,
    })
    expect(r.get("lsp")?.source).toBe("session")
    expect(r.get("lsp")?.value).toBe(true)
  })

  test("env beats config", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs,
      envVars: { Q_LSP: "1" } as NodeJS.ProcessEnv,
      configFile: { lsp: "0" },
    })
    expect(r.get("lsp")?.source).toBe("env")
    expect(r.get("lsp")?.value).toBe(true)
  })

  test("config beats preset", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs,
      configFile: { lsp: "1" },
      preset: "everything", // includes lsp=1; but config wins anyway by source
    })
    expect(r.get("lsp")?.source).toBe("config-file")
  })

  test("preset used when no higher layer present", () => {
    const r = resolveKnobs({ surface: "bench", knobs, preset: "everything" })
    expect(r.get("lsp")?.source).toBe("preset")
    expect(r.get("lsp")?.value).toBe(true)
  })

  test("default used when nothing else resolves", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs: knobMap(wide(mk<boolean>("flag", boolParse, false))),
    })
    expect(r.get("flag")?.source).toBe("default")
    expect(r.get("flag")?.value).toBe(false)
  })

  test("absent + no default → key not present", () => {
    const r = resolveKnobs({ surface: "bench", knobs })
    expect(r.has("lsp")).toBe(false)
  })

  test("layer with parse=undefined falls through to next", () => {
    // raw "x" is not recognised by boolParse → undefined → falls through.
    const r = resolveKnobs({
      surface: "bench",
      knobs,
      cliArgs: { lsp: "x" },
      envVars: { Q_LSP: "1" } as NodeJS.ProcessEnv,
    })
    expect(r.get("lsp")?.source).toBe("env")
    expect(r.get("lsp")?.value).toBe(true)
  })
})

describe("resolveKnobs — parse error", () => {
  test("throwing parse becomes KnobParseError", () => {
    const k: Knob<number> = mk("n", (raw) => {
      if (raw === "bad") throw new Error("boom")
      return numParse(raw)
    })
    expect(() =>
      resolveKnobs({ surface: "bench", knobs: knobMap(wide(k)), cliArgs: { n: "bad" } }),
    ).toThrow(KnobParseError)
  })

  test("KnobParseError captures knobId + raw", () => {
    const k: Knob<number> = mk<number>("n", () => {
      throw new Error("x")
    })
    try {
      resolveKnobs({ surface: "bench", knobs: knobMap(wide(k)), cliArgs: { n: "raw-text" } })
      expect(true).toBe(false)
    } catch (e) {
      expect(e).toBeInstanceOf(KnobParseError)
      const pe = e as KnobParseError
      expect(pe.knobId).toBe("n")
      expect(pe.raw).toBe("raw-text")
    }
  })
})

describe("resolveKnobs — unknown ids ignored", () => {
  test("unknown cliArg id is silently skipped", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs: knobMap(wide(mk("known", boolParse))),
      cliArgs: { unknown: "1", known: "1" },
    })
    expect(r.has("unknown")).toBe(false)
    expect(r.has("known")).toBe(true)
  })

  test("unknown env key (not in any knob.envKey) silently skipped", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs: knobMap(wide(mk("known", boolParse))),
      envVars: { Q_KNOWN: "1", Q_OTHER: "1" } as NodeJS.ProcessEnv,
    })
    expect(r.get("known")?.value).toBe(true)
  })
})

describe("resolveKnobs — empty inputs", () => {
  test("empty registry returns empty map", () => {
    const r = resolveKnobs({ surface: "bench", knobs: new Map(), cliArgs: { x: "1" } })
    expect(r.size).toBe(0)
  })

  test("no inputs + no defaults → empty map", () => {
    const r = resolveKnobs({ surface: "bench", knobs: knobMap(wide(mk("k", boolParse))) })
    expect(r.size).toBe(0)
  })
})

describe("resolveKnobs — number knob roundtrip", () => {
  test("CLI numeric parse", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs: knobMap(wide(mk<number>("n", numParse))),
      cliArgs: { n: "5" },
    })
    expect(r.get("n")?.value).toBe(5)
  })

  test("malformed number → falls through to default", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs: knobMap(wide(mk<number>("n", numParse, 7))),
      cliArgs: { n: "not-a-number" },
    })
    expect(r.get("n")?.source).toBe("default")
    expect(r.get("n")?.value).toBe(7)
  })
})
