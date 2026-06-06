/**
 * Hellgate — resolver adversarial battery.
 *
 * Targets `src/runner/knobs/resolve.ts`. Verifies layer precedence under
 * all-layer pressure, prototype-pollution-shaped inputs, unicode keys and
 * values, oversized values, parse-throw isolation, large input scale, preset
 * weirdness, and closed-port invariance (no fs/env reads).
 */
import { describe, expect, test } from "bun:test"
import { type AnyKnob, asAnyKnob, type Knob, KnobParseError, resolveKnobs } from "@/runner/knobs"

const boolParse = (raw: string | undefined): boolean | undefined =>
  raw === "1" ? true : raw === "0" ? false : undefined

const strParse = (raw: string | undefined): string | undefined => raw

const numParse = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

const mk = <T>(id: string, parse: Knob<T>["parse"], opts: Partial<Knob<T>> = {}): Knob<T> => ({
  id,
  envKey: `Q_${id.toUpperCase().replace(/-/g, "_")}`,
  category: "tool",
  surfaces: ["bench"],
  parse,
  apply: (cfg) => cfg,
  describe: id,
  ...opts,
})

const km = (...ks: ReadonlyArray<unknown>): ReadonlyMap<string, AnyKnob> => {
  const m = new Map<string, AnyKnob>()
  for (const k of ks) {
    const knob = k as { id: string }
    m.set(knob.id, asAnyKnob(k as Knob<unknown>))
  }
  return m
}

describe("hellgate / resolve — full-stack precedence under hostile inputs", () => {
  const k = mk<string>("k", strParse)
  const knobs = km(k)

  test("cli wins over EVERY other layer simultaneously", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs,
      cliArgs: { k: "cli" },
      sessionOverrides: { k: "session" },
      envVars: { Q_K: "env" } as NodeJS.ProcessEnv,
      configFile: { k: "config" },
      preset: "everything",
    })
    expect(r.get("k")?.source).toBe("cli")
    expect(r.get("k")?.value).toBe("cli")
  })

  test("session wins when cli is absent (4-way race below)", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs,
      sessionOverrides: { k: "session" },
      envVars: { Q_K: "env" } as NodeJS.ProcessEnv,
      configFile: { k: "config" },
      preset: "everything",
    })
    expect(r.get("k")?.source).toBe("session")
  })

  test("env wins when cli + session absent", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs,
      envVars: { Q_K: "env" } as NodeJS.ProcessEnv,
      configFile: { k: "config" },
      preset: "everything",
    })
    expect(r.get("k")?.source).toBe("env")
  })

  test("config wins when cli + session + env absent", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs,
      configFile: { k: "config" },
      preset: "everything",
    })
    expect(r.get("k")?.source).toBe("config-file")
  })

  test("preset is last layer above default", () => {
    const r = resolveKnobs({ surface: "bench", knobs, preset: "everything" })
    // The preset 'everything' has no 'k' entry; falls through to default.
    expect(r.has("k")).toBe(false)
  })

  test("REVERSE-order constructor: same layer present everywhere → cli still wins", () => {
    // Build the args bottom-up to flush any iteration-order bug.
    const args = {
      preset: "everything",
      configFile: { k: "config" },
      envVars: { Q_K: "env" } as NodeJS.ProcessEnv,
      sessionOverrides: { k: "session" },
      cliArgs: { k: "cli" },
      surface: "bench" as const,
      knobs,
    }
    const r = resolveKnobs(args)
    expect(r.get("k")?.source).toBe("cli")
  })
})

describe("hellgate / resolve — prototype pollution in ALL layers", () => {
  const k = mk<string>("ok", strParse)
  const knobs = km(k)

  test("__proto__ key in cliArgs is dropped (Object.hasOwn fence)", () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":"yes"},"ok":"clean"}') as Record<
      string,
      string
    >
    const r = resolveKnobs({ surface: "bench", knobs, cliArgs: hostile })
    expect(r.get("ok")?.value).toBe("clean")
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("__proto__ key in sessionOverrides is dropped", () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":"yes"},"ok":"clean"}') as Record<
      string,
      string
    >
    const r = resolveKnobs({ surface: "bench", knobs, sessionOverrides: hostile })
    expect(r.get("ok")?.value).toBe("clean")
  })

  test("__proto__ key in envVars is dropped", () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":"yes"},"Q_OK":"clean"}') as Record<
      string,
      string
    >
    const r = resolveKnobs({
      surface: "bench",
      knobs,
      envVars: hostile as NodeJS.ProcessEnv,
    })
    expect(r.get("ok")?.value).toBe("clean")
  })

  test("__proto__ key in configFile is dropped", () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":"yes"},"ok":"clean"}') as Record<
      string,
      string
    >
    const r = resolveKnobs({ surface: "bench", knobs, configFile: hostile })
    expect(r.get("ok")?.value).toBe("clean")
  })

  test("knob id literally named __proto__ never resolves (safeGet drops it)", () => {
    const evil = mk<string>("__proto__", strParse)
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(evil),
      cliArgs: { __proto__: "evil" } as Record<string, string>,
    })
    expect(r.has("__proto__")).toBe(false)
  })

  test("knob id `prototype` blocked", () => {
    const evil = mk<string>("prototype", strParse, { envKey: "X" })
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(evil),
      cliArgs: { prototype: "evil" } as Record<string, string>,
    })
    expect(r.has("prototype")).toBe(false)
  })

  test("knob id `constructor` blocked", () => {
    const evil = mk<string>("constructor", strParse, { envKey: "X" })
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(evil),
      cliArgs: { constructor: "evil" } as Record<string, string>,
    })
    expect(r.has("constructor")).toBe(false)
  })
})

describe("hellgate / resolve — unknown ids + unknown env keys gracefully ignored", () => {
  test("unknown cliArg id silently dropped", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(mk<string>("known", strParse)),
      cliArgs: { unknown: "x", another: "y" },
    })
    expect(r.has("unknown")).toBe(false)
    expect(r.has("another")).toBe(false)
  })

  test("hundreds of unrelated env keys do NOT pollute resolved map", () => {
    const env: NodeJS.ProcessEnv = {}
    for (let i = 0; i < 500; i++) env[`UNRELATED_${i}`] = String(i)
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(mk<string>("known", strParse, { envKey: "Q_KNOWN" })),
      envVars: env,
    })
    expect(r.size).toBe(0)
  })

  test("unknown preset name resolves as empty preset (no throw)", () => {
    expect(() =>
      resolveKnobs({ surface: "bench", knobs: new Map(), preset: "this-preset-DNE" }),
    ).not.toThrow()
  })

  test("empty registry never throws across maximal layers", () => {
    expect(() =>
      resolveKnobs({
        surface: "bench",
        knobs: new Map(),
        cliArgs: { a: "1" },
        sessionOverrides: { b: "2" },
        envVars: { Q_X: "3" } as NodeJS.ProcessEnv,
        configFile: { c: "4" },
        preset: "everything",
      }),
    ).not.toThrow()
  })

  test("preset with knob id NOT in supplied knob set is harmless", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(mk<string>("only-known", strParse)),
      preset: "everything",
    })
    // 'everything' references lsp/subagent/etc but we passed only 'only-known'
    // → resolver iterates only 'only-known' so the preset's other ids are
    // silently inert.
    expect(r.size).toBe(0)
  })
})

describe("hellgate / resolve — parse failures stay isolated", () => {
  test("parse throws → KnobParseError surfaces with knob id + raw", () => {
    const k = mk<number>("n", () => {
      throw new Error("oops")
    })
    try {
      resolveKnobs({ surface: "bench", knobs: km(k), cliArgs: { n: "RAW" } })
      expect(true).toBe(false)
    } catch (e) {
      expect(e).toBeInstanceOf(KnobParseError)
      expect((e as KnobParseError).knobId).toBe("n")
      expect((e as KnobParseError).raw).toBe("RAW")
    }
  })

  test("higher layer resolves → lower throwing layer never invoked", () => {
    const k = mk<number>("n", (raw) => {
      if (raw === "boom") throw new Error("x")
      return raw === undefined ? undefined : Number(raw)
    })
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(k),
      cliArgs: { n: "5" },
      envVars: { Q_N: "boom" } as NodeJS.ProcessEnv,
    })
    expect(r.get("n")?.value).toBe(5)
  })

  test("parse returning undefined for FIRST layer falls through (does NOT throw)", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(mk<boolean>("k", boolParse)),
      cliArgs: { k: "garbage" }, // boolParse returns undefined → fall through
      sessionOverrides: { k: "1" },
    })
    expect(r.get("k")?.source).toBe("session")
    expect(r.get("k")?.value).toBe(true)
  })

  test("parse-throw on env when no higher layer present still throws", () => {
    const k = mk<number>("n", (raw) => {
      if (raw === "boom") throw new Error("x")
      return undefined
    })
    expect(() =>
      resolveKnobs({
        surface: "bench",
        knobs: km(k),
        envVars: { Q_N: "boom" } as NodeJS.ProcessEnv,
      }),
    ).toThrow(KnobParseError)
  })
})

describe("hellgate / resolve — value content adversarial", () => {
  test("unicode value resolves intact", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(mk<string>("k", strParse)),
      cliArgs: { k: "héllo 🚀 世界" },
    })
    expect(r.get("k")?.value).toBe("héllo 🚀 世界")
  })

  test("empty-string value resolves when parse accepts it", () => {
    const k = mk<string>("k", (raw) => raw ?? undefined)
    const r = resolveKnobs({ surface: "bench", knobs: km(k), cliArgs: { k: "" } })
    // The closed-port `safeGet` returns "" because Object.hasOwn(...) is true.
    // The parser receives "" and decides — here it accepts → resolves.
    expect(r.get("k")?.value).toBe("")
  })

  test("very-long value (1MB) passes through without truncation", () => {
    const long = "x".repeat(1024 * 1024)
    const k = mk<string>("k", strParse)
    const r = resolveKnobs({ surface: "bench", knobs: km(k), cliArgs: { k: long } })
    expect(r.get("k")?.value).toBe(long)
  })

  test("value containing null bytes is preserved", () => {
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(mk<string>("k", strParse)),
      cliArgs: { k: "a\x00b" },
    })
    expect(r.get("k")?.value).toBe("a\x00b")
  })

  test("whitespace-only value reaches parser (parser decides)", () => {
    const k = mk<string>("k", (raw) => (raw?.trim() === "" ? undefined : raw))
    const r = resolveKnobs({ surface: "bench", knobs: km(k), cliArgs: { k: "   " } })
    expect(r.has("k")).toBe(false)
  })
})

describe("hellgate / resolve — scale + perf", () => {
  test("100 knobs × all-layer inputs resolve in <50ms", () => {
    const knobsMap = new Map<string, AnyKnob>()
    const cli: Record<string, string> = {}
    const env: NodeJS.ProcessEnv = {}
    for (let i = 0; i < 100; i++) {
      const id = `k-${i}`
      knobsMap.set(id, asAnyKnob(mk<string>(id, strParse, { envKey: `Q_K_${i}` })))
      cli[id] = `cli-${i}`
      env[`Q_K_${i}`] = `env-${i}`
    }
    const t = performance.now()
    const r = resolveKnobs({ surface: "bench", knobs: knobsMap, cliArgs: cli, envVars: env })
    const elapsed = performance.now() - t
    expect(r.size).toBe(100)
    expect(elapsed).toBeLessThan(50)
    expect(r.get("k-50")?.source).toBe("cli")
  })

  test("env with 1000 unrelated keys + 1 hit resolves in <20ms", () => {
    const env: NodeJS.ProcessEnv = {}
    for (let i = 0; i < 1000; i++) env[`UNRELATED_${i}`] = String(i)
    env.Q_K = "found"
    const t = performance.now()
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(mk<string>("k", strParse)),
      envVars: env,
    })
    expect(performance.now() - t).toBeLessThan(20)
    expect(r.get("k")?.source).toBe("env")
    expect(r.get("k")?.value).toBe("found")
  })
})

describe("hellgate / resolve — type coercion + edge values", () => {
  test("numParse rejects NaN, Infinity, -Infinity", () => {
    const k = mk<number>("n", numParse)
    const knobs = km(k)
    expect(resolveKnobs({ surface: "bench", knobs, cliArgs: { n: "NaN" } }).has("n")).toBe(false)
    expect(resolveKnobs({ surface: "bench", knobs, cliArgs: { n: "Infinity" } }).has("n")).toBe(
      false,
    )
    expect(resolveKnobs({ surface: "bench", knobs, cliArgs: { n: "-Infinity" } }).has("n")).toBe(
      false,
    )
  })

  test("default=0 still resolves (0 !== undefined)", () => {
    const k = mk<number>("n", numParse, { default: 0 })
    const r = resolveKnobs({ surface: "bench", knobs: km(k) })
    expect(r.get("n")?.value).toBe(0)
    expect(r.get("n")?.source).toBe("default")
  })

  test("default=false still resolves (false !== undefined)", () => {
    const k = mk<boolean>("k", boolParse, { default: false })
    const r = resolveKnobs({ surface: "bench", knobs: km(k) })
    expect(r.get("k")?.value).toBe(false)
    expect(r.get("k")?.source).toBe("default")
  })

  test("default=empty-string treated as resolved (truthy fix)", () => {
    const k = mk<string>("k", strParse, { default: "" })
    const r = resolveKnobs({ surface: "bench", knobs: km(k) })
    expect(r.get("k")?.value).toBe("")
    expect(r.get("k")?.source).toBe("default")
  })
})

describe("hellgate / resolve — closed-port invariance", () => {
  test("undefined cliArgs / sessionOverrides / envVars / configFile all OK", () => {
    expect(() =>
      resolveKnobs({ surface: "bench", knobs: km(mk<boolean>("k", boolParse)) }),
    ).not.toThrow()
  })

  test("resolve never reads process.env (closed port)", () => {
    // Set a real env var that the knob expects; the resolver should NOT pick
    // it up because envVars is empty.
    const k = mk<boolean>("k", boolParse, { envKey: "QUANTA_HELLGATE_PROBE" })
    const prev = process.env.QUANTA_HELLGATE_PROBE
    process.env.QUANTA_HELLGATE_PROBE = "1"
    try {
      const r = resolveKnobs({ surface: "bench", knobs: km(k) })
      expect(r.has("k")).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.QUANTA_HELLGATE_PROBE
      else process.env.QUANTA_HELLGATE_PROBE = prev
    }
  })

  test("multiple resolves with the same args are deterministic", () => {
    const k = mk<string>("k", strParse)
    const args = {
      surface: "bench" as const,
      knobs: km(k),
      cliArgs: { k: "v" },
    }
    const a = resolveKnobs(args)
    const b = resolveKnobs(args)
    expect(a.get("k")?.value).toBe(b.get("k")?.value)
    expect(a.get("k")?.source).toBe(b.get("k")?.source)
  })
})
