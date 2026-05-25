/**
 * Hellgate — adversarial battery for the knob framework.
 *
 * Each test pins a specific failure mode that we MUST NOT regress on:
 *   - Layer precedence under hostile inputs
 *   - Prototype-pollution-style cli/env/config keys
 *   - Unknown ids ignored gracefully (not thrown)
 *   - Conflict / requires throw deterministically
 *   - Surface filter excludes wrong-surface knobs
 *   - Persist roundtrip survives JSON oddities
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import {
  __resetRegistry,
  type AnyKnob,
  applyKnobs,
  asAnyKnob,
  type Knob,
  KnobConflictError,
  KnobMissingRequiredError,
  KnobParseError,
  type KnobValueMap,
  knobsForSurface,
  readKnobConfig,
  registerKnob,
  resolveKnobs,
  validateKnobs,
  writeKnobConfig,
} from "@/runner/knobs"

const bool = (raw: string | undefined): boolean | undefined =>
  raw === "1" ? true : raw === "0" ? false : undefined

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

/**
 * Build a `ReadonlyMap<string, AnyKnob>` from heterogeneously-typed knobs.
 * Each entry passes through `asAnyKnob` because under EOPT a `Knob<boolean>`
 * is NOT assignable to `Knob<unknown>` directly. Argument list types are
 * loose (`ReadonlyArray<unknown>`) and narrowed via a type predicate on
 * each entry — this is the runtime contract we want to preserve.
 */
const km = (...ks: ReadonlyArray<unknown>): ReadonlyMap<string, AnyKnob> => {
  const m = new Map<string, AnyKnob>()
  for (const k of ks) {
    const knob = k as { id: string }
    m.set(knob.id, asAnyKnob(k as Knob<unknown>))
  }
  return m
}

beforeEach(() => __resetRegistry())
afterEach(() => __resetRegistry())

describe("hellgate / layer precedence", () => {
  test("CLI > session > env > config > preset (full stack)", () => {
    const k = mk<string>("k", (raw) => (raw === "" ? undefined : raw))
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(k),
      cliArgs: { k: "cli" },
      sessionOverrides: { k: "session" },
      envVars: { Q_K: "env" } as NodeJS.ProcessEnv,
      configFile: { k: "config" },
      preset: "everything",
    })
    expect(r.get("k")?.value).toBe("cli")
    expect(r.get("k")?.source).toBe("cli")
  })

  test("each layer with same raw still wins by source order", () => {
    const k = mk<string>("k", (raw) => raw)
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(k),
      sessionOverrides: { k: "v" },
      envVars: { Q_K: "v" } as NodeJS.ProcessEnv,
    })
    expect(r.get("k")?.source).toBe("session")
  })

  test("layer with parse returning undefined falls through to next", () => {
    const k = mk<boolean>("k", bool)
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(k),
      cliArgs: { k: "garbage" }, // bool returns undefined → fall through
      sessionOverrides: { k: "1" },
    })
    expect(r.get("k")?.source).toBe("session")
    expect(r.get("k")?.value).toBe(true)
  })

  test("default chosen only when ALL layers absent", () => {
    const k = mk<boolean>("k", bool, { default: false })
    const r = resolveKnobs({ surface: "bench", knobs: km(k) })
    expect(r.get("k")?.source).toBe("default")
  })

  test("default NOT chosen when CLI parse succeeded", () => {
    const k = mk<boolean>("k", bool, { default: false })
    const r = resolveKnobs({ surface: "bench", knobs: km(k), cliArgs: { k: "1" } })
    expect(r.get("k")?.value).toBe(true)
    expect(r.get("k")?.source).toBe("cli")
  })
})

describe("hellgate / prototype pollution", () => {
  test("__proto__ as key in cliArgs is ignored (no pollution, no read)", () => {
    const k = mk<string>("ok", (raw) => raw)
    const hostile = JSON.parse('{"__proto__":{"polluted":"yes"},"ok":"good"}') as Record<
      string,
      string
    >
    const r = resolveKnobs({ surface: "bench", knobs: km(k), cliArgs: hostile })
    expect(r.get("ok")?.value).toBe("good")
    // Pollution check: a fresh object should not have inherited `polluted`.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("constructor key is ignored", () => {
    const k = mk<string>("ok", (raw) => raw)
    // Use `Object.create(null)` and assign via index — TS keeps `constructor`
    // typed as Function on `Record<string, string>` so we go through `unknown`.
    const hostile = Object.create(null) as Record<string, string>
    ;(hostile as unknown as { constructor: string }).constructor = "evil"
    hostile.ok = "good"
    const r = resolveKnobs({ surface: "bench", knobs: km(k), cliArgs: hostile })
    expect(r.get("ok")?.value).toBe("good")
  })

  test("prototype-key knob id never registers a value", () => {
    // A knob whose id is "__proto__" would be a developer error, but if it
    // somehow slipped through, the safeGet drops the lookup → value never
    // resolves and the key is absent from the output map.
    const k = mk<string>("__proto__", (raw) => raw)
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(k),
      cliArgs: { __proto__: "evil" } as Record<string, string>,
    })
    expect(r.has("__proto__")).toBe(false)
  })

  test("config file with __proto__ key ignored", () => {
    const k = mk<string>("ok", (raw) => raw)
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(k),
      configFile: JSON.parse('{"__proto__":{"x":"x"},"ok":"good"}') as Record<string, string>,
    })
    expect(r.get("ok")?.value).toBe("good")
  })
})

describe("hellgate / unknown ids", () => {
  test("unknown CLI knob → no throw, no resolved value", () => {
    const k = mk<string>("known", (raw) => raw)
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(k),
      cliArgs: { unknown: "ignored" },
    })
    expect(r.has("unknown")).toBe(false)
  })

  test("unknown ENV key → no throw", () => {
    const k = mk<string>("known", (raw) => raw)
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(k),
      envVars: { Q_UNKNOWN: "x" } as NodeJS.ProcessEnv,
    })
    expect(r.size).toBe(0)
  })

  test("unknown preset name → no throw, no values", () => {
    const r = resolveKnobs({ surface: "bench", knobs: new Map(), preset: "ZZ_doesnt_exist" })
    expect(r.size).toBe(0)
  })

  test("empty registry never throws regardless of layers", () => {
    expect(() =>
      resolveKnobs({
        surface: "bench",
        knobs: new Map(),
        cliArgs: { a: "1" },
        sessionOverrides: { b: "2" },
        envVars: { Q: "3" } as NodeJS.ProcessEnv,
        configFile: { c: "4" },
        preset: "everything",
      }),
    ).not.toThrow()
  })
})

describe("hellgate / parse errors", () => {
  test("parse throws → KnobParseError surfaces", () => {
    const k = mk<number>("n", () => {
      throw new Error("internal")
    })
    expect(() => resolveKnobs({ surface: "bench", knobs: km(k), cliArgs: { n: "x" } })).toThrow(
      KnobParseError,
    )
  })

  test("parse error preserves knob id + raw", () => {
    const k = mk<number>("n", () => {
      throw new Error("internal")
    })
    try {
      resolveKnobs({ surface: "bench", knobs: km(k), cliArgs: { n: "RAW" } })
      expect(true).toBe(false)
    } catch (e) {
      const pe = e as KnobParseError
      expect(pe.knobId).toBe("n")
      expect(pe.raw).toBe("RAW")
    }
  })

  test("parse error in lower layer NOT triggered when higher layer resolved", () => {
    // CLI resolves → env layer never asked. Even though env raw would throw,
    // the resolver short-circuits.
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
})

describe("hellgate / conflicts + requires", () => {
  test("conflict between two active knobs → throws", () => {
    const a = mk<boolean>("a", bool, { conflicts: ["b"] })
    const b = mk<boolean>("b", bool)
    expect(() =>
      resolveKnobs({ surface: "bench", knobs: km(a, b), cliArgs: { a: "1", b: "1" } }),
    ).toThrow(KnobConflictError)
  })

  test("missing requires → throws", () => {
    const a = mk<boolean>("a", bool, { requires: ["b"] })
    const b = mk<boolean>("b", bool)
    expect(() => resolveKnobs({ surface: "bench", knobs: km(a, b), cliArgs: { a: "1" } })).toThrow(
      KnobMissingRequiredError,
    )
  })

  test("conflict pair deduped to single entry", () => {
    const a = mk<boolean>("a", bool, { conflicts: ["b"] })
    const b = mk<boolean>("b", bool, { conflicts: ["a"] })
    try {
      validateKnobs(
        new Map([
          ["a", { value: true, source: "cli" }],
          ["b", { value: true, source: "cli" }],
        ]) as KnobValueMap,
        km(a, b),
      )
      expect(true).toBe(false)
    } catch (e) {
      const ce = e as KnobConflictError
      expect(ce.conflicts.length).toBe(1)
    }
  })

  test("circular requires A↔B with only A active → throws", () => {
    const a = mk<boolean>("a", bool, { requires: ["b"] })
    const b = mk<boolean>("b", bool, { requires: ["a"] })
    expect(() => resolveKnobs({ surface: "bench", knobs: km(a, b), cliArgs: { a: "1" } })).toThrow(
      KnobMissingRequiredError,
    )
  })

  test("circular requires A↔B with BOTH active is fine", () => {
    const a = mk<boolean>("a", bool, { requires: ["b"] })
    const b = mk<boolean>("b", bool, { requires: ["a"] })
    expect(() =>
      resolveKnobs({ surface: "bench", knobs: km(a, b), cliArgs: { a: "1", b: "1" } }),
    ).not.toThrow()
  })

  test("transitive conflict (A↔B, B↔C) with A+C only is FINE", () => {
    const a = mk<boolean>("a", bool, { conflicts: ["b"] })
    const b = mk<boolean>("b", bool, { conflicts: ["a", "c"] })
    const c = mk<boolean>("c", bool, { conflicts: ["b"] })
    expect(() =>
      resolveKnobs({
        surface: "bench",
        knobs: km(a, b, c),
        cliArgs: { a: "1", c: "1" },
      }),
    ).not.toThrow()
  })
})

describe("hellgate / surface filter", () => {
  test("knob registered for bench is not in cli surface map", () => {
    registerKnob(mk<boolean>("bench-only", bool, { surfaces: ["bench"] }))
    expect(knobsForSurface("cli").has("bench-only")).toBe(false)
    expect(knobsForSurface("bench").has("bench-only")).toBe(true)
  })

  test("wrong-surface knob in values is skipped by applyKnobs", () => {
    const k = mk<boolean>("cli-only", bool, { surfaces: ["cli"] })
    const cfg = {} as AgentConfig
    const out = applyKnobs(cfg, km(k), new Map([["cli-only", { value: true, source: "cli" }]]), {
      surface: "bench",
    })
    expect(out).toBe(cfg)
  })

  test("resolveKnobs only iterates supplied knob set (already filtered)", () => {
    // The caller is expected to pre-filter; we verify the inner contract.
    const cli = mk<boolean>("cli-only", bool, { surfaces: ["cli"] })
    // Pass cli-knob set to a bench resolve → still resolves (filtering is
    // caller-side). This documents the API.
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(cli),
      cliArgs: { "cli-only": "1" },
    })
    expect(r.get("cli-only")?.value).toBe(true)
  })
})

describe("hellgate / exactOptionalPropertyTypes contract", () => {
  test("Knob with default=undefined behaves like absent default", () => {
    // We can't literally write `default: undefined` under EOPT — but we can
    // construct a knob without the property and confirm the resolver does
    // not yield a default-sourced value.
    const k: Knob<boolean> = mk("k", bool)
    const r = resolveKnobs({ surface: "bench", knobs: km(k) })
    expect(r.has("k")).toBe(false)
  })

  test("Knob with default=false yields default-sourced value when absent", () => {
    const k: Knob<boolean> = mk("k", bool, { default: false })
    const r = resolveKnobs({ surface: "bench", knobs: km(k) })
    expect(r.get("k")?.value).toBe(false)
    expect(r.get("k")?.source).toBe("default")
  })

  test("Knob.conflicts/requires absent treated as empty (no throw)", () => {
    const k = mk<boolean>("k", bool)
    expect(() =>
      resolveKnobs({ surface: "bench", knobs: km(k), cliArgs: { k: "1" } }),
    ).not.toThrow()
  })
})

describe("hellgate / persist roundtrip", () => {
  let dir = ""
  let file = ""
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "knobs-hg-"))
    file = join(dir, "knobs.json")
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("write then read returns same map", async () => {
    await writeKnobConfig({ a: "1", b: "2" }, file)
    const r = await readKnobConfig(file)
    expect(r?.user_defaults).toEqual({ a: "1", b: "2" })
  })

  test("read rejects unknown version", async () => {
    await writeFile(file, JSON.stringify({ version: 42 }), "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("write → read → resolve as config-file layer", async () => {
    await writeKnobConfig({ k: "1" }, file)
    const cfg = await readKnobConfig(file)
    expect(cfg).not.toBeNull()
    const k = mk<boolean>("k", bool)
    const r = resolveKnobs({
      surface: "bench",
      knobs: km(k),
      configFile: cfg?.user_defaults as Record<string, string>,
    })
    expect(r.get("k")?.value).toBe(true)
    expect(r.get("k")?.source).toBe("config-file")
  })
})
