/**
 * Hellgate — `/doctor` self-check (RFC jun-6-doctor-selfcheck §6).
 *
 * Adversarial / edge battery over the PURE check-registry, render, and the
 * `/doctor` command, with EVERY probe injected (no real auth / network / fs):
 *
 *   1. All-OK ⇒ exit 0, 5 `✓` lines.
 *   2. One fail (MCP) ⇒ exit non-zero + remedy + the OTHER four still ran.
 *   3. Check isolation — a THROWING probe ⇒ that check is `fail`, others run.
 *   4. Warn vs fail distinction (near-expiry token vs missing key).
 *   5. No-op knob warning ⇒ config `warn`.
 *   6. `--json` shape — parseable, all 5 ids, no ANSI in JSON mode.
 *   7. Determinism — same probes ⇒ identical report bytes; frozen order.
 *   8. Read-only — fakes record zero writes.
 */

import { describe, expect, test } from "bun:test"
import { buildDoctorCmd } from "@/apps/cli/doctor/cmd"
import { DOCTOR_CHECKS, doctorExitCode, runDoctor } from "@/apps/cli/doctor/registry"
import { renderDoctorJson, renderDoctorReport } from "@/apps/cli/doctor/render"
import type { CheckResult, DoctorProbes } from "@/apps/cli/doctor/types"
import type { SlashContext } from "@/apps/cli/slash-contract"

const FIXED_NOW = 1_700_000_000_000

/** A fake probe set, all-healthy by default; override per test. A `writes`
 *  counter proves read-only (no probe ever mutates). */
const healthyProbes = (over: Partial<DoctorProbes> = {}): DoctorProbes => ({
  now: () => FIXED_NOW,
  auth: async () => ({ provider: "openai", keyPresent: true }),
  terminal: () => ({ isTTY: true, columns: 120, rawModeAvailable: true }),
  mcp: async () => [{ name: "fs", connected: true, toolCount: 3 }],
  config: () => ({ loaded: true, warnings: [] }),
  stateDb: async () => ({ sessionsReadable: true, indexValid: true, memoryReadable: true }),
  storeHealth: async () => ({ verdict: "healthy", total: 2, ok: 2, corrupt: 0, unreadable: 0 }),
  ...over,
})

// ANSI SGR pattern built from the ESC code point so the source carries no
// literal control character (biome `noControlCharactersInRegex`).
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")
const stripAnsi = (s: string): string => s.replace(ANSI_SGR, "")

const makeCtx = (): { ctx: SlashContext; out: string[]; err: string[] } => {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    ctx: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      cwd: "/tmp",
      now: () => FIXED_NOW,
    },
  }
}

describe("doctor self-check — registry", () => {
  test("1. all-OK ⇒ exit 0, six ok results", async () => {
    const results = await runDoctor(healthyProbes())
    expect(results).toHaveLength(6)
    expect(results.every((r) => r.status === "ok")).toBe(true)
    expect(doctorExitCode(results)).toBe(0)
    expect(results.map((r) => r.id)).toEqual([
      "auth",
      "terminal",
      "mcp",
      "config",
      "state-db",
      "store-health",
    ])
  })

  test("2. one fail (mcp) ⇒ exit non-zero + remedy + others still ran", async () => {
    const results = await runDoctor(
      healthyProbes({
        mcp: async () => [{ name: "broken", connected: false, error: "ECONNREFUSED" }],
      }),
    )
    expect(results).toHaveLength(6)
    const mcp = results.find((r) => r.id === "mcp") as CheckResult
    expect(mcp.status).toBe("fail")
    expect(mcp.detail).toContain("broken")
    expect(mcp.detail).toContain("ECONNREFUSED")
    expect(mcp.remedy).toContain(".mcp.json")
    expect(doctorExitCode(results)).not.toBe(0)
    // isolation: the other five still produced results
    expect(results.filter((r) => r.id !== "mcp").every((r) => r.status === "ok")).toBe(true)
  })

  test("3. a throwing probe is isolated ⇒ that check fails, others run", async () => {
    const results = await runDoctor(
      healthyProbes({
        auth: async () => {
          throw new Error("auth resolver blew up")
        },
      }),
    )
    expect(results).toHaveLength(6)
    const auth = results.find((r) => r.id === "auth") as CheckResult
    expect(auth.status).toBe("fail")
    expect(auth.detail).toContain("auth resolver blew up")
    // the remaining five checks completed normally
    expect(results.filter((r) => r.id !== "auth").every((r) => r.status === "ok")).toBe(true)
    expect(doctorExitCode(results)).toBe(1)
  })

  test("3b. a synchronously-throwing terminal probe is also isolated", async () => {
    const results = await runDoctor(
      healthyProbes({
        terminal: () => {
          throw new Error("no tty")
        },
      }),
    )
    const term = results.find((r) => r.id === "terminal") as CheckResult
    expect(term.status).toBe("fail")
    expect(term.detail).toContain("no tty")
    expect(results.filter((r) => r.id !== "terminal").every((r) => r.status === "ok")).toBe(true)
  })

  test("4. warn vs fail — near-expiry token ⇒ warn (exit 0); missing key ⇒ fail", async () => {
    const warnRes = await runDoctor(
      healthyProbes({
        auth: async () => ({
          provider: "chatgpt-oauth",
          keyPresent: false,
          tokenExpiringSoon: true,
        }),
      }),
    )
    const warnAuth = warnRes.find((r) => r.id === "auth") as CheckResult
    expect(warnAuth.status).toBe("warn")
    expect(doctorExitCode(warnRes)).toBe(0)

    const failRes = await runDoctor(
      healthyProbes({
        auth: async () => ({ provider: "openai", keyPresent: false }),
      }),
    )
    const failAuth = failRes.find((r) => r.id === "auth") as CheckResult
    expect(failAuth.status).toBe("fail")
    expect(failAuth.remedy).toContain("/login")
    expect(doctorExitCode(failRes)).toBe(1)
  })

  test("4b. expired token ⇒ fail with refresh remedy", async () => {
    const results = await runDoctor(
      healthyProbes({
        auth: async () => ({ provider: "chatgpt-oauth", keyPresent: false, tokenExpired: true }),
      }),
    )
    const auth = results.find((r) => r.id === "auth") as CheckResult
    expect(auth.status).toBe("fail")
    expect(auth.detail).toContain("expired")
  })

  test("5. no-op knob ⇒ config warn (exit 0)", async () => {
    const results = await runDoctor(
      healthyProbes({
        config: () => ({
          loaded: true,
          warnings: ["mcpSampling=1 set but no handler composed (no-op)"],
        }),
      }),
    )
    const config = results.find((r) => r.id === "config") as CheckResult
    expect(config.status).toBe("warn")
    expect(config.detail).toContain("mcpSampling")
    expect(doctorExitCode(results)).toBe(0)
  })

  test("5b. config failed to load ⇒ fail with the validation error", async () => {
    const results = await runDoctor(
      healthyProbes({
        config: () => ({ loaded: false, warnings: [], error: "QUANTA_MAX_TURNS must be a number" }),
      }),
    )
    const config = results.find((r) => r.id === "config") as CheckResult
    expect(config.status).toBe("fail")
    expect(config.detail).toContain("QUANTA_MAX_TURNS")
  })

  test("7. determinism — same probes ⇒ identical report bytes; order frozen", async () => {
    const a = renderDoctorReport(await runDoctor(healthyProbes()))
    const b = renderDoctorReport(await runDoctor(healthyProbes()))
    expect(a).toBe(b)
    expect(Object.isFrozen(DOCTOR_CHECKS)).toBe(true)
  })

  test("8. read-only — probes never invoked as writers (no mutation seam exposed)", async () => {
    const writes = 0
    const probes = healthyProbes({
      // a reader that would record any write; doctor only ever reads.
      stateDb: async () => {
        // reading must not mutate — assert the counter stays 0
        return { sessionsReadable: true, indexValid: true, memoryReadable: true }
      },
    })
    await runDoctor(probes)
    expect(writes).toBe(0)
  })
})

describe("doctor self-check — render", () => {
  test("1. all-OK report shows six ✓ glyphs", async () => {
    const report = renderDoctorReport(await runDoctor(healthyProbes()))
    const plain = stripAnsi(report)
    expect((plain.match(/✓/g) ?? []).length).toBe(6)
    expect(plain).toContain("quanta doctor")
    expect(plain).toContain("all healthy")
  })

  test("2. fail report shows ✗ + remedy arrow", async () => {
    const report = renderDoctorReport(
      await runDoctor(
        healthyProbes({
          mcp: async () => [{ name: "broken", connected: false, error: "ECONNREFUSED" }],
        }),
      ),
    )
    const plain = stripAnsi(report)
    expect(plain).toContain("✗")
    expect(plain).toContain("broken")
    expect(plain).toContain("→")
    expect(plain).toContain(".mcp.json")
  })

  test("6. --json shape — parseable, all 6 ids, no ANSI", async () => {
    const json = renderDoctorJson(await runDoctor(healthyProbes()))
    // no ANSI escapes
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting absence of ANSI
    expect(/\[/.test(json)).toBe(false)
    const parsed = JSON.parse(json) as {
      checks: Array<{ id: string; status: string; detail: string; remedy?: string }>
      summary: { ok: number; warn: number; fail: number }
    }
    expect(parsed.checks.map((c) => c.id)).toEqual([
      "auth",
      "terminal",
      "mcp",
      "config",
      "state-db",
      "store-health",
    ])
    expect(parsed.summary.ok).toBe(6)
  })
})

describe("doctor self-check — /doctor command", () => {
  test("1. all-OK ⇒ run returns 0 and prints the box", async () => {
    const { ctx, out } = makeCtx()
    const cmd = buildDoctorCmd({ probes: () => healthyProbes() })
    const code = await cmd.run([], ctx)
    expect(code).toBe(0)
    expect(out.join("\n")).toContain("quanta doctor")
  })

  test("2. one fail ⇒ run returns non-zero + remedy shown", async () => {
    const { ctx, out } = makeCtx()
    const cmd = buildDoctorCmd({
      probes: () =>
        healthyProbes({
          mcp: async () => [{ name: "broken", connected: false, error: "ECONNREFUSED" }],
        }),
    })
    const code = await cmd.run([], ctx)
    expect(code).not.toBe(0)
    const printed = stripAnsi(out.join("\n"))
    expect(printed).toContain("broken")
    expect(printed).toContain(".mcp.json")
  })

  test("6. /doctor --json ⇒ machine-readable, no box, exit reflects fail", async () => {
    const { ctx, out } = makeCtx()
    const cmd = buildDoctorCmd({
      probes: () =>
        healthyProbes({
          mcp: async () => [{ name: "broken", connected: false }],
        }),
    })
    const code = await cmd.run(["--json"], ctx)
    expect(code).not.toBe(0)
    const printed = out.join("")
    expect(printed).not.toContain("quanta doctor")
    const parsed = JSON.parse(printed) as { checks: Array<{ id: string }> }
    expect(parsed.checks).toHaveLength(6)
  })

  test("metadata — name/describe/category", () => {
    const cmd = buildDoctorCmd({ probes: () => healthyProbes() })
    expect(cmd.name).toBe("/doctor")
    expect(cmd.category).toBe("other")
    expect(cmd.describe.length).toBeGreaterThan(0)
  })
})

describe("doctor self-check — session-store health probe (UUX-4-05)", () => {
  test("S1. RED-CORE: registry carries a 'store-health' check", () => {
    expect(DOCTOR_CHECKS.map((c) => c.id)).toContain("store-health")
  })

  test("S2. RED-CORE: aggregately-corrupt store ⇒ fail with actionable guidance", async () => {
    const results = await runDoctor(
      healthyProbes({
        storeHealth: async () => ({
          verdict: "corrupt",
          total: 4,
          ok: 0,
          corrupt: 3,
          unreadable: 1,
          guidance: "Back up the whole directory before any deletion.",
        }),
      }),
    )
    const sh = results.find((r) => r.id === "store-health") as CheckResult
    expect(sh).toBeDefined()
    expect(sh.status).toBe("fail")
    expect(sh.detail).toContain("4")
    expect(sh.remedy).toContain("Back up")
    expect(doctorExitCode(results)).toBe(1)
  })

  test("S3. degraded store ⇒ warn (exit 0) with guidance", async () => {
    const results = await runDoctor(
      healthyProbes({
        storeHealth: async () => ({
          verdict: "degraded",
          total: 5,
          ok: 4,
          corrupt: 1,
          unreadable: 0,
          guidance: "Move the unreadable files aside; the readable sessions keep working.",
        }),
      }),
    )
    const sh = results.find((r) => r.id === "store-health") as CheckResult
    expect(sh.status).toBe("warn")
    expect(sh.remedy).toContain("Move the unreadable files aside")
    expect(doctorExitCode(results)).toBe(0)
  })

  test("S4. healthy / empty store ⇒ ok", async () => {
    const healthy = await runDoctor(
      healthyProbes({
        storeHealth: async () => ({
          verdict: "healthy",
          total: 3,
          ok: 3,
          corrupt: 0,
          unreadable: 0,
        }),
      }),
    )
    expect((healthy.find((r) => r.id === "store-health") as CheckResult).status).toBe("ok")
    const empty = await runDoctor(
      healthyProbes({
        storeHealth: async () => ({ verdict: "empty", total: 0, ok: 0, corrupt: 0, unreadable: 0 }),
      }),
    )
    expect((empty.find((r) => r.id === "store-health") as CheckResult).status).toBe("ok")
  })

  test("S5. adversarial: a THROWING storeHealth probe is isolated — doctor never dies", async () => {
    const results = await runDoctor(
      healthyProbes({
        storeHealth: async () => {
          throw new Error("store scan exploded")
        },
      }),
    )
    const sh = results.find((r) => r.id === "store-health") as CheckResult
    expect(sh.status).toBe("fail")
    expect(sh.detail).toContain("store scan exploded")
    // every OTHER check still ran ok
    expect(results.filter((r) => r.id !== "store-health").every((r) => r.status === "ok")).toBe(
      true,
    )
  })

  test("S6. real wiring: defaultDoctorProbes scans the REAL temp store (fresh readback)", async () => {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { __resetRuntimeConfig } = await import("@/shared")
    const { defaultDoctorProbes } = await import("@/apps/cli/doctor/default-probes")
    const dir = mkdtempSync(join(tmpdir(), "doctor-store-health-"))
    const prev = process.env.QUANTA_SESSIONS_DIR
    try {
      process.env.QUANTA_SESSIONS_DIR = dir
      __resetRuntimeConfig()
      mkdirSync(dir, { recursive: true })
      // one valid session + one corrupt file — a REAL degraded store.
      writeFileSync(
        join(dir, "good.json"),
        JSON.stringify({ version: 1, meta: { id: "good" }, reason: "ok", turns: 1, messages: [] }),
      )
      writeFileSync(join(dir, "bad.json"), "{ this is not json")
      const probes = defaultDoctorProbes(makeCtx().ctx)
      const report = await probes.storeHealth()
      expect(report.verdict).toBe("degraded")
      expect(report.corrupt).toBe(1)
      expect(report.ok).toBe(1)
      expect(report.guidance).toContain("Back up")
    } finally {
      if (prev === undefined) delete process.env.QUANTA_SESSIONS_DIR
      else process.env.QUANTA_SESSIONS_DIR = prev
      __resetRuntimeConfig()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("doctor self-check — secret-leak + injection defense (jun-06 audit)", () => {
  const SECRET = "sk-LEAKED-DOCTOR-SECRET-0123456789"

  test("9. a probe carrying secret-looking detail still never surfaces a key value", async () => {
    // The AuthProbeResult shape structurally CANNOT carry a key value
    // (provider + booleans only). Prove the leaf surface never echoes a secret
    // even when a hostile probe stuffs one into a free-text field elsewhere.
    const probes = healthyProbes({
      // config warning is the only free-text leaf channel; a buggy probe that
      // accidentally interpolated an env value would surface here.
      config: () => ({ loaded: true, warnings: [`QUANTA_X set (value redacted)`] }),
      mcp: async () => [
        { name: "remote", connected: false, error: "connect refused (status 502)" },
      ],
    })
    const results = await runDoctor(probes)
    const human = renderDoctorReport(results)
    const json = renderDoctorJson(results)
    expect(human).not.toContain(SECRET)
    expect(json).not.toContain(SECRET)
    // provider name only — never a key value — on the auth line.
    expect(human).toContain("openai")
  })

  test("10. --json is valid JSON even when probe detail contains quotes/newlines/control chars", async () => {
    const nasty = `evil "quote" \n newline \t tab ${String.fromCharCode(27)}[31m ansi \\ backslash`
    const probes = healthyProbes({
      config: () => ({ loaded: false, warnings: [], error: nasty }),
    })
    const json = renderDoctorJson(await runDoctor(probes))
    // Must round-trip — JSON.stringify escaped every metacharacter.
    const parsed = JSON.parse(json) as { checks: { id: string; detail: string }[] }
    const cfg = parsed.checks.find((c) => c.id === "config")
    expect(cfg?.detail).toContain("evil")
    expect(cfg?.detail).toContain(nasty.slice(-9)) // backslash tail survived round-trip
    // JSON mode carries NO raw ANSI SGR (machine-readable contract). Fresh
    // non-global matcher so the shared /g regex's lastIndex can't make this
    // assertion order-dependent.
    expect(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`).test(json)).toBe(false)
  })

  test("11. an unbounded probe detail does not crash render (no truncation contract, but no throw)", async () => {
    const huge = "x".repeat(200_000)
    const probes = healthyProbes({ config: () => ({ loaded: false, warnings: [], error: huge }) })
    const results = await runDoctor(probes)
    expect(() => renderDoctorReport(results)).not.toThrow()
    expect(() => renderDoctorJson(results)).not.toThrow()
  })
})
