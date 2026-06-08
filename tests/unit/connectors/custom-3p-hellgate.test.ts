/**
 * Custom 3P Setup MVP — hellgate (ADR-0245).
 *
 * Seals 15 adversarial cases for the 5-method MVP registry:
 *
 *   1. register → list round-trip
 *   2. register → update → list round-trip
 *   3. register → remove → list round-trip
 *   4. health() returns ok for healthy spec (fake probe)
 *   5. duplicate register(id) throws typed error
 *   6. update(unknownId) throws typed error
 *   7. remove(unknownId) throws typed error
 *   8. health(unknownId) throws typed error
 *   9. jsonl persistence round-trip across two registry instances
 *   10. jsonl file mode is 0600 (dir mode is 0700)
 *   11. 4-state lifecycle exhaustive — draft → configured → healthy → failing
 *   12. in-memory vs jsonl parity — same op sequence → same list()
 *   13. ProviderSpec returned from list() is structurally frozen
 *   14. default-OFF: src/connectors/index.ts barrel does NOT export custom-3p
 *   15. 100-provider perf: register + list completes under 50ms
 *
 *  Secondary battery:
 *   16. ProviderKind 2-arm exhaustive — invalid endpoint scheme per kind throws
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as connectorsBarrel from "@/connectors"
import {
  asProviderId,
  Custom3pError,
  createHealthProbe,
  createInMemoryCustom3pRegistry,
  createJsonlCustom3pRegistry,
  type HealthProbe,
  type HealthResult,
  type ProviderSpec,
} from "@/connectors/custom-3p"

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const fakeOkProbe: HealthProbe = async (_spec): Promise<HealthResult> => ({
  verdict: "ok",
  checkedAt: 1_000,
  latencyMs: 10,
})

const fakeFailProbe: HealthProbe = async (_spec): Promise<HealthResult> => ({
  verdict: "http-fail",
  checkedAt: 2_000,
  latencyMs: 20,
})

const fakeTimeoutProbe: HealthProbe = async (_spec): Promise<HealthResult> => ({
  verdict: "timeout",
  checkedAt: 3_000,
})

const llmSpec = (id: string, overrides: Partial<ProviderSpec> = {}): ProviderSpec => ({
  id: asProviderId(id),
  displayName: `Display ${id}`,
  kind: "llm",
  endpoint: "https://example.com/v1",
  auth: "apiKey",
  ...overrides,
})

const mcpSpec = (id: string, overrides: Partial<ProviderSpec> = {}): ProviderSpec => ({
  id: asProviderId(id),
  displayName: `MCP ${id}`,
  kind: "mcp",
  endpoint: "wss://mcp.example.com",
  auth: "oauth",
  ...overrides,
})

const tmpJsonl = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-custom-3p-"))
  return join(dir, "nested", "custom-3p.jsonl")
}

// ────────────────────────────────────────────────────────────────────────────
// HELL-1 .. HELL-16
// ────────────────────────────────────────────────────────────────────────────

describe("custom-3p-hellgate", () => {
  // Wallclock perf assertions flake on loaded CI — gate behind opt-in flag.
  const PERF_STRICT = process.env.QUANTA_PERF_STRICT === "1"

  test("HELL-1: register → list round-trip", async () => {
    const reg = createInMemoryCustom3pRegistry({ healthProbe: fakeOkProbe })
    await reg.register(llmSpec("a"))
    const list = await reg.list()
    expect(list.length).toBe(1)
    expect(list[0]?.id).toBe(asProviderId("a"))
  })

  test("HELL-2: register → update → list round-trip", async () => {
    const reg = createInMemoryCustom3pRegistry({ healthProbe: fakeOkProbe })
    await reg.register(llmSpec("a"))
    await reg.update(asProviderId("a"), { displayName: "renamed" })
    const list = await reg.list()
    expect(list[0]?.displayName).toBe("renamed")
    // lifecycle advances draft → configured on update.
    expect(await reg.lifecycle(asProviderId("a"))).toBe("configured")
  })

  test("HELL-3: register → remove → list round-trip", async () => {
    const reg = createInMemoryCustom3pRegistry({ healthProbe: fakeOkProbe })
    await reg.register(llmSpec("a"))
    await reg.register(llmSpec("b"))
    await reg.remove(asProviderId("a"))
    const list = await reg.list()
    expect(list.length).toBe(1)
    expect(list[0]?.id).toBe(asProviderId("b"))
    expect(await reg.lifecycle(asProviderId("a"))).toBeUndefined()
  })

  test("HELL-4: health() returns ok for healthy spec", async () => {
    const reg = createInMemoryCustom3pRegistry({ healthProbe: fakeOkProbe })
    await reg.register(llmSpec("a"))
    const res = await reg.health(asProviderId("a"))
    expect(res.verdict).toBe("ok")
    expect(await reg.lifecycle(asProviderId("a"))).toBe("healthy")
  })

  test("HELL-5: duplicate register(id) throws Custom3pError(duplicate-id)", async () => {
    const reg = createInMemoryCustom3pRegistry({ healthProbe: fakeOkProbe })
    await reg.register(llmSpec("a"))
    let caught: unknown
    try {
      await reg.register(llmSpec("a"))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Custom3pError)
    expect((caught as Custom3pError).code).toBe("duplicate-id")
  })

  test("HELL-6: update(unknownId) throws Custom3pError(unknown-id)", async () => {
    const reg = createInMemoryCustom3pRegistry({ healthProbe: fakeOkProbe })
    let caught: unknown
    try {
      await reg.update(asProviderId("ghost"), { displayName: "x" })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Custom3pError)
    expect((caught as Custom3pError).code).toBe("unknown-id")
  })

  test("HELL-7: remove(unknownId) throws Custom3pError(unknown-id)", async () => {
    const reg = createInMemoryCustom3pRegistry({ healthProbe: fakeOkProbe })
    let caught: unknown
    try {
      await reg.remove(asProviderId("ghost"))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Custom3pError)
    expect((caught as Custom3pError).code).toBe("unknown-id")
  })

  test("HELL-8: health(unknownId) throws Custom3pError(unknown-id)", async () => {
    const reg = createInMemoryCustom3pRegistry({ healthProbe: fakeOkProbe })
    let caught: unknown
    try {
      await reg.health(asProviderId("ghost"))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Custom3pError)
    expect((caught as Custom3pError).code).toBe("unknown-id")
  })

  test("HELL-9: jsonl persistence round-trip across instances", async () => {
    const path = tmpJsonl()
    const a = createJsonlCustom3pRegistry({ path, healthProbe: fakeOkProbe })
    await a.register(llmSpec("p1"))
    await a.register(mcpSpec("p2"))
    await a.update(asProviderId("p1"), { displayName: "after-restart" })
    await a.health(asProviderId("p2"))

    const b = createJsonlCustom3pRegistry({ path, healthProbe: fakeOkProbe })
    const list = await b.list()
    expect(list.length).toBe(2)
    expect(list.find((s) => s.id === asProviderId("p1"))?.displayName).toBe("after-restart")
    // lifecycle is persisted too.
    expect(await b.lifecycle(asProviderId("p1"))).toBe("configured")
    expect(await b.lifecycle(asProviderId("p2"))).toBe("healthy")
  })

  test("HELL-10: jsonl file mode is 0600 + dir mode is 0700", async () => {
    const path = tmpJsonl()
    const reg = createJsonlCustom3pRegistry({ path, healthProbe: fakeOkProbe })
    await reg.register(llmSpec("a"))
    const fileMode = statSync(path).mode & 0o777
    const dirMode = statSync(join(path, "..")).mode & 0o777
    expect(fileMode).toBe(0o600)
    expect(dirMode).toBe(0o700)
  })

  test("HELL-11: 4-state lifecycle exhaustive — draft → configured → healthy → failing", async () => {
    const reg = createInMemoryCustom3pRegistry({ healthProbe: fakeOkProbe })
    const id = asProviderId("life")
    await reg.register(llmSpec("life"))
    expect(await reg.lifecycle(id)).toBe("draft")

    await reg.update(id, { displayName: "x" })
    expect(await reg.lifecycle(id)).toBe("configured")

    await reg.health(id)
    expect(await reg.lifecycle(id)).toBe("healthy")

    // Swap the probe to a failing one — health() advances to "failing".
    const reg2 = createInMemoryCustom3pRegistry({ healthProbe: fakeFailProbe })
    await reg2.register(llmSpec("life2"))
    await reg2.health(asProviderId("life2"))
    expect(await reg2.lifecycle(asProviderId("life2"))).toBe("failing")

    // And timeout also lands at failing (closed-arm coverage).
    const reg3 = createInMemoryCustom3pRegistry({ healthProbe: fakeTimeoutProbe })
    await reg3.register(llmSpec("life3"))
    await reg3.health(asProviderId("life3"))
    expect(await reg3.lifecycle(asProviderId("life3"))).toBe("failing")
  })

  test("HELL-12: in-memory vs jsonl parity — same op sequence → same list", async () => {
    const ops = async (reg: ReturnType<typeof createInMemoryCustom3pRegistry>): Promise<void> => {
      await reg.register(llmSpec("x"))
      await reg.register(mcpSpec("y"))
      await reg.register(llmSpec("z"))
      await reg.update(asProviderId("y"), { displayName: "y-new" })
      await reg.remove(asProviderId("x"))
    }

    const mem = createInMemoryCustom3pRegistry({ healthProbe: fakeOkProbe })
    await ops(mem)
    const memList = await mem.list()

    const path = tmpJsonl()
    const jsonl = createJsonlCustom3pRegistry({ path, healthProbe: fakeOkProbe })
    await jsonl.register(llmSpec("x"))
    await jsonl.register(mcpSpec("y"))
    await jsonl.register(llmSpec("z"))
    await jsonl.update(asProviderId("y"), { displayName: "y-new" })
    await jsonl.remove(asProviderId("x"))
    const jsonlList = await jsonl.list()

    // Compare structurally — both should be the same row order + content.
    expect(jsonlList.map((s) => s.id)).toEqual(memList.map((s) => s.id))
    expect(jsonlList.map((s) => s.displayName)).toEqual(memList.map((s) => s.displayName))
  })

  test("HELL-13: ProviderSpec returned from list() is structurally frozen", async () => {
    const reg = createInMemoryCustom3pRegistry({ healthProbe: fakeOkProbe })
    await reg.register(llmSpec("a", { tags: ["tag-1", "tag-2"] }))
    const list = await reg.list()
    const first = list[0]
    if (first === undefined) throw new Error("missing row")
    expect(Object.isFrozen(first)).toBe(true)
    if (first.tags !== undefined) expect(Object.isFrozen(first.tags)).toBe(true)
    // Mutating the returned array does not leak back into the registry.
    expect(() => {
      ;(list as ProviderSpec[]).push(llmSpec("leak"))
    }).toThrow()
    const reList = await reg.list()
    expect(reList.length).toBe(1)
  })

  test("HELL-14: default-OFF — src/connectors barrel does NOT export custom-3p", () => {
    const exported = Object.keys(connectorsBarrel)
    // The custom-3p factories must NOT be reachable via @/connectors.
    expect(exported).not.toContain("createInMemoryCustom3pRegistry")
    expect(exported).not.toContain("createJsonlCustom3pRegistry")
    expect(exported).not.toContain("createHeadlessCustom3pRegistry")
    expect(exported).not.toContain("Custom3pError")
  })

  test("HELL-15: 100-provider perf — register + list under 50ms", async () => {
    const reg = createInMemoryCustom3pRegistry({ healthProbe: fakeOkProbe })
    const t0 = performance.now()
    for (let i = 0; i < 100; i++) await reg.register(llmSpec(`p-${i}`))
    const list = await reg.list()
    const elapsed = performance.now() - t0
    expect(list.length).toBe(100)
    if (PERF_STRICT) expect(elapsed).toBeLessThan(50)
  })

  test("HELL-16: ProviderKind 2-arm exhaustive — invalid endpoint per kind throws", async () => {
    const reg = createInMemoryCustom3pRegistry({ healthProbe: fakeOkProbe })

    // llm with a ws:// endpoint → invalid-endpoint
    let caught1: unknown
    try {
      await reg.register(llmSpec("bad-llm", { endpoint: "wss://oops.example" }))
    } catch (err) {
      caught1 = err
    }
    expect(caught1).toBeInstanceOf(Custom3pError)
    expect((caught1 as Custom3pError).code).toBe("invalid-endpoint")

    // mcp with an https:// endpoint → invalid-endpoint
    let caught2: unknown
    try {
      await reg.register(mcpSpec("bad-mcp", { endpoint: "https://oops.example" }))
    } catch (err) {
      caught2 = err
    }
    expect(caught2).toBeInstanceOf(Custom3pError)
    expect((caught2 as Custom3pError).code).toBe("invalid-endpoint")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Bonus: pure health-probe sanity (closed verdict ladder).
// ────────────────────────────────────────────────────────────────────────────

describe("custom-3p-health-probe", () => {
  test("stdio: mcp endpoint → ok without any I/O", async () => {
    const probe = createHealthProbe({
      fetchPort: async () => {
        throw new Error("should not fetch")
      },
      dnsPort: { resolve: async () => [] },
      clockPort: { now: () => 100 },
    })
    const res = await probe(mcpSpec("stdio-1", { endpoint: "stdio:/usr/local/bin/some-mcp" }))
    expect(res.verdict).toBe("ok")
  })

  test("dns empty → dns-fail (no HTTP attempted)", async () => {
    let httpCalls = 0
    const probe = createHealthProbe({
      fetchPort: async () => {
        httpCalls += 1
        return { status: 200, ok: true, text: async () => "" }
      },
      dnsPort: { resolve: async () => [] },
      clockPort: { now: () => 100 },
    })
    const res = await probe(llmSpec("dns-fail"))
    expect(res.verdict).toBe("dns-fail")
    expect(httpCalls).toBe(0)
  })

  test("HTTP 401 → auth-fail", async () => {
    const probe = createHealthProbe({
      fetchPort: async () => ({ status: 401, ok: false, text: async () => "" }),
      dnsPort: { resolve: async () => ["1.2.3.4"] },
      clockPort: { now: () => 100 },
    })
    const res = await probe(llmSpec("auth-fail"))
    expect(res.verdict).toBe("auth-fail")
  })

  test("file contents are JSONL (one row per line, trailing newline)", async () => {
    const path = tmpJsonl()
    const reg = createJsonlCustom3pRegistry({ path, healthProbe: fakeOkProbe })
    await reg.register(llmSpec("r1"))
    await reg.register(llmSpec("r2"))
    const raw = readFileSync(path, "utf-8")
    expect(raw.endsWith("\n")).toBe(true)
    const lines = raw.split("\n").filter((l) => l.length > 0)
    expect(lines.length).toBe(2)
    for (const line of lines) {
      const parsed = JSON.parse(line) as { spec: { id: string }; state: string }
      expect(typeof parsed.spec.id).toBe("string")
      expect(["draft", "configured", "healthy", "failing"]).toContain(parsed.state)
    }
  })
})
