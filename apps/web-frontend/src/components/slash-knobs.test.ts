import { describe, expect, it, vi, afterEach } from "vitest"
import {
  CONFIG_WRITABLE_KEYS,
  displayKnobValue,
  fetchKnobs,
  filterKnobGroups,
  isToggleableBool,
  isWritableKnob,
  type KnobEntry,
  type KnobGroup,
  knobBoolValue,
  parseKnobsResponse,
  postKnobValue,
} from "./slash-knobs"

const knob = (over: Partial<KnobEntry>): KnobEntry => ({
  envKey: "QUANTA_X",
  kind: "bool",
  default: false,
  describe: "desc",
  home: "loop",
  hotToggleable: false,
  value: false,
  source: "default",
  isDefault: true,
  ...over,
})

const realFetch = globalThis.fetch
const stubFetch = (impl: typeof fetch) => {
  globalThis.fetch = impl
}

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe("parseKnobsResponse", () => {
  it("parses a well-formed response", () => {
    const parsed = parseKnobsResponse({
      total: 1,
      groups: [
        {
          group: "g1",
          knobs: [
            {
              envKey: "QUANTA_FAST",
              kind: "bool",
              default: false,
              describe: "fast mode",
              home: "llm",
              hotToggleable: true,
              value: true,
              source: "env",
              isDefault: false,
            },
          ],
        },
      ],
    })
    expect(parsed.total).toBe(1)
    expect(parsed.groups[0]?.group).toBe("g1")
    expect(parsed.groups[0]?.knobs[0]?.envKey).toBe("QUANTA_FAST")
    expect(parsed.groups[0]?.knobs[0]?.hotToggleable).toBe(true)
  })

  it("tolerates missing fields with safe defaults", () => {
    const parsed = parseKnobsResponse({ groups: [{ knobs: [{}] }] })
    expect(parsed.groups[0]?.group).toBe("(ungrouped)")
    const k = parsed.groups[0]?.knobs[0]
    expect(k?.envKey).toBe("(unknown)")
    expect(k?.hotToggleable).toBe(false)
    expect(parsed.total).toBe(1) // derived from knob count
  })

  it("throws on a non-object payload", () => {
    expect(() => parseKnobsResponse(null)).toThrow()
    expect(() => parseKnobsResponse("nope")).toThrow()
  })
})

describe("writability gating mirrors the daemon allowlist", () => {
  it("only treats allowlisted + hotToggleable knobs as writable", () => {
    expect(isWritableKnob(knob({ envKey: "QUANTA_FAST", hotToggleable: true }))).toBe(true)
    // hotToggleable but NOT in allowlist → read-only
    expect(isWritableKnob(knob({ envKey: "QUANTA_OTHER", hotToggleable: true }))).toBe(false)
    // allowlisted but not hotToggleable → read-only
    expect(isWritableKnob(knob({ envKey: "QUANTA_FAST", hotToggleable: false }))).toBe(false)
  })

  it("isToggleableBool additionally requires kind=bool", () => {
    expect(
      isToggleableBool(knob({ envKey: "QUANTA_FAST", hotToggleable: true, kind: "bool" })),
    ).toBe(true)
    expect(
      isToggleableBool(knob({ envKey: "QUANTA_MODEL", hotToggleable: true, kind: "string" })),
    ).toBe(false)
  })

  it("CONFIG_WRITABLE_KEYS matches the daemon's CONFIG_ALLOWED_KEYS", () => {
    // Must stay member-for-member in lock-step with `CONFIG_ALLOWED_KEYS` in
    // `src/apps/web-daemon/server.ts`. The cross-package drift guard lives in
    // `tests/unit/web-frontend-protocol-drift-contract-hellgate.test.ts` (it
    // reads both files as text). This in-tree assertion pins the literal set.
    expect([...CONFIG_WRITABLE_KEYS].sort()).toEqual(
      [
        "QUANTA_FAST",
        "QUANTA_MODEL",
        "QUANTA_REASONING_EFFORT",
        "QUANTA_REASONING_SUMMARY",
        "QUANTA_REASONING_VERBOSITY",
        "QUANTA_SERVICE_TIER",
      ].sort(),
    )
  })
})

describe("knobBoolValue", () => {
  it("coerces common truthy/falsy representations", () => {
    expect(knobBoolValue(knob({ value: true }))).toBe(true)
    expect(knobBoolValue(knob({ value: "1" }))).toBe(true)
    expect(knobBoolValue(knob({ value: "on" }))).toBe(true)
    expect(knobBoolValue(knob({ value: "TRUE" }))).toBe(true)
    expect(knobBoolValue(knob({ value: "0" }))).toBe(false)
    expect(knobBoolValue(knob({ value: null }))).toBe(false)
    expect(knobBoolValue(knob({ value: 2 }))).toBe(true)
  })
})

describe("displayKnobValue", () => {
  it("renders redacted markers without un-redacting", () => {
    expect(displayKnobValue(knob({ value: "[redacted]" }))).toBe("[redacted]")
    expect(displayKnobValue(knob({ value: "[REDACTED]" }))).toBe("[redacted]")
    expect(displayKnobValue(knob({ value: "***" }))).toBe("[redacted]")
  })

  it("renders booleans / unset / empty distinctly", () => {
    expect(displayKnobValue(knob({ value: true }))).toBe("on")
    expect(displayKnobValue(knob({ value: false }))).toBe("off")
    expect(displayKnobValue(knob({ value: null }))).toBe("(unset)")
    expect(displayKnobValue(knob({ value: "" }))).toBe("(empty)")
    expect(displayKnobValue(knob({ value: "gpt-5" }))).toBe("gpt-5")
    expect(displayKnobValue(knob({ value: 42 }))).toBe("42")
  })
})

describe("filterKnobGroups", () => {
  const groups: readonly KnobGroup[] = [
    {
      group: "llm",
      knobs: [
        knob({ envKey: "QUANTA_FAST", describe: "fast mode" }),
        knob({ envKey: "QUANTA_MODEL", describe: "model override" }),
      ],
    },
    {
      group: "loop",
      knobs: [knob({ envKey: "QUANTA_MAX_TURNS", describe: "turn cap" })],
    },
  ]

  it("returns all groups for an empty query", () => {
    expect(filterKnobGroups(groups, "")).toBe(groups)
    expect(filterKnobGroups(groups, "  ")).toBe(groups)
  })

  it("matches by envKey", () => {
    const out = filterKnobGroups(groups, "model")
    expect(out).toHaveLength(1)
    expect(out[0]?.knobs.map((k) => k.envKey)).toEqual(["QUANTA_MODEL"])
  })

  it("matches by describe", () => {
    const out = filterKnobGroups(groups, "turn cap")
    expect(out).toHaveLength(1)
    expect(out[0]?.group).toBe("loop")
  })

  it("matches a whole group by group name", () => {
    const out = filterKnobGroups(groups, "llm")
    expect(out).toHaveLength(1)
    expect(out[0]?.knobs).toHaveLength(2)
  })

  it("drops groups with no matches", () => {
    expect(filterKnobGroups(groups, "zzz")).toHaveLength(0)
  })
})

describe("fetchKnobs", () => {
  it("attaches the Bearer header and parses the body", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ total: 0, groups: [] }), { status: 200 }),
    )
    stubFetch(fetchMock)
    const out = await fetchKnobs({ httpUrl: "http://x:1/", token: "tok" })
    expect(out.total).toBe(0)
    const call = fetchMock.mock.calls[0]
    expect(call?.[0]).toBe("http://x:1/api/knobs")
    expect(call?.[1]?.headers).toMatchObject({ authorization: "Bearer tok" })
  })

  it("throws on a non-ok response", async () => {
    stubFetch(vi.fn(async () => new Response("nope", { status: 401 })))
    await expect(fetchKnobs({ httpUrl: "http://x:1" })).rejects.toThrow(/401/)
  })
})

describe("postKnobValue", () => {
  it("POSTs a single key + returns ok", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response("{}", { status: 200 }),
    )
    stubFetch(fetchMock)
    const res = await postKnobValue({ httpUrl: "http://x:1", token: "t" }, "QUANTA_FAST", "1")
    expect(res.ok).toBe(true)
    const call = fetchMock.mock.calls[0]
    expect(call?.[0]).toBe("http://x:1/config")
    expect(call?.[1]?.method).toBe("POST")
    expect(call?.[1]?.body).toBe(JSON.stringify({ QUANTA_FAST: "1" }))
  })

  it("returns an error result (not a throw) on rejection", async () => {
    stubFetch(vi.fn(async () => new Response("unknown_key", { status: 400 })))
    const res = await postKnobValue({ httpUrl: "http://x:1" }, "QUANTA_FAST", null)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/400/)
  })
})
