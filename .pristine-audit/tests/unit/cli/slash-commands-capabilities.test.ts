/**
 * `/capabilities` (alias `/caps`) slash command — operator-facing read-only
 * surface over the cross-surface capability layer (`@/capability`, ADR-0503 P3).
 *
 * The command DISPLAYS only — no mutation. Tests cover:
 *   - `list` (default): renders every declared capability + per-surface
 *     exposure grid + each gate's current on/off state;
 *   - master-gate banner (QUANTA_CAPABILITY_LAYER on/off, with the probe-only
 *     note when off);
 *   - `find <q>`: filters by id / describe / gate envKey;
 *   - resolveExposure reflected: arming a capability's gate flips its declared
 *     surface cell from ✗ to ✓;
 *   - unknown subcommand ⇒ stderr + exit 1;
 *   - completion for subcommands.
 *
 * Env is restored after every test so gate reads never leak across cases.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { allCapabilities } from "@/capability"
import { capabilitiesCmd } from "../../../src/apps/cli/slash-commands-capabilities"
import type { SlashContext } from "../../../src/apps/cli/slash-contract"

interface Harness {
  readonly ctx: SlashContext
  readonly stdout: () => string
  readonly stderr: () => string
}

const buildHarness = (): Harness => {
  let stdout = ""
  let stderr = ""
  const ctx: SlashContext = {
    out: (s) => {
      stdout += s
    },
    err: (s) => {
      stderr += s
    },
    cwd: process.cwd(),
  }
  return { ctx, stdout: () => stdout, stderr: () => stderr }
}

// Snapshot the env keys we mutate so each test starts clean.
const TOUCHED = ["QUANTA_CAPABILITY_LAYER", ...allCapabilities().map((c) => c.gate.envKey)]
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = {}
  for (const k of TOUCHED) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe("/capabilities", () => {
  test("default (list) renders every capability with id, describe, and gate envKey", async () => {
    const h = buildHarness()
    const code = await capabilitiesCmd.run([], h.ctx)
    expect(code).toBe(0)
    const out = h.stdout()
    for (const cap of allCapabilities()) {
      expect(out).toContain(cap.id)
      expect(out).toContain(cap.describe)
      expect(out).toContain(cap.gate.envKey)
    }
  })

  test("list shows the per-surface exposure grid header", async () => {
    const h = buildHarness()
    await capabilitiesCmd.run(["list"], h.ctx)
    const out = h.stdout()
    for (const s of ["llmTool", "slash", "skill", "hook", "thinClient"]) {
      expect(out).toContain(s)
    }
  })

  test("master gate OFF ⇒ probe-only banner", async () => {
    const h = buildHarness()
    await capabilitiesCmd.run(["list"], h.ctx)
    const out = h.stdout()
    expect(out).toContain("QUANTA_CAPABILITY_LAYER")
    expect(out).toContain("off")
    expect(out).toContain("probe-only")
  })

  test("master gate ON ⇒ banner reflects on, no probe-only note", async () => {
    process.env.QUANTA_CAPABILITY_LAYER = "1"
    const h = buildHarness()
    await capabilitiesCmd.run(["list"], h.ctx)
    const out = h.stdout()
    expect(out).toContain("QUANTA_CAPABILITY_LAYER")
    expect(out).toContain("on")
    expect(out).not.toContain("probe-only")
  })

  test("gate OFF ⇒ a declared surface shows ✗ (off), not ✓", async () => {
    const h = buildHarness()
    await capabilitiesCmd.run(["list"], h.ctx)
    const out = h.stdout()
    // The legend line contains ✓ as a glyph; assert no DATA row exposes one by
    // dropping the legend/banner lines and checking the rest.
    const dataLines = out
      .split("\n")
      .filter((l) => !l.includes("exposed ·") && !l.startsWith("master gate"))
      .join("\n")
    // With every gate off, no declared surface resolves to exposed.
    expect(dataLines).not.toContain("✓")
    // …but declared-but-off cells (✗) must be present.
    expect(dataLines).toContain("✗")
  })

  test("resolveExposure reflected: arming a cap's gate flips its declared surface to ✓", async () => {
    const cap = allCapabilities()[0]
    expect(cap).toBeDefined()
    if (cap === undefined) return
    process.env[cap.gate.envKey] = "1"
    const h = buildHarness()
    await capabilitiesCmd.run(["list"], h.ctx)
    // Inspect the DATA rows only (drop the legend line which always has ✓).
    const dataLines = h
      .stdout()
      .split("\n")
      .filter((l) => !l.includes("exposed ·") && !l.startsWith("master gate"))
      .join("\n")
    // The armed capability now exposes (at least) one ✓ on its declared surface.
    expect(dataLines).toContain("✓")
  })

  test("undeclared surfaces render the not-declared dash", async () => {
    const h = buildHarness()
    await capabilitiesCmd.run(["list"], h.ctx)
    const out = h.stdout()
    // Every seed capability is llmTool-only ⇒ slash/skill/hook/thinClient are
    // not declared ⇒ the en-dash marker must appear.
    expect(out).toContain("–")
  })

  test("find filters by id substring", async () => {
    const target = allCapabilities()[0]
    expect(target).toBeDefined()
    if (target === undefined) return
    const h = buildHarness()
    const code = await capabilitiesCmd.run(["find", target.id], h.ctx)
    expect(code).toBe(0)
    const out = h.stdout()
    expect(out).toContain(target.id)
  })

  test("find filters by gate envKey", async () => {
    const target = allCapabilities()[0]
    expect(target).toBeDefined()
    if (target === undefined) return
    const h = buildHarness()
    await capabilitiesCmd.run(["find", target.gate.envKey], h.ctx)
    expect(h.stdout()).toContain(target.id)
  })

  test("find with no matches prints a friendly no-match line, exit 0", async () => {
    const h = buildHarness()
    const code = await capabilitiesCmd.run(["find", "zzz-no-such-capability-xyz"], h.ctx)
    expect(code).toBe(0)
    expect(h.stdout().toLowerCase()).toContain("no capability")
  })

  test("find with empty query ⇒ stderr + exit 1", async () => {
    const h = buildHarness()
    const code = await capabilitiesCmd.run(["find"], h.ctx)
    expect(code).toBe(1)
    expect(h.stderr()).toContain("find")
  })

  test("unknown subcommand ⇒ stderr + exit 1", async () => {
    const h = buildHarness()
    const code = await capabilitiesCmd.run(["bogus"], h.ctx)
    expect(code).toBe(1)
    expect(h.stderr()).toContain("bogus")
  })

  test("completion offers subcommands at slot 0", () => {
    const h = buildHarness()
    expect(capabilitiesCmd.complete).toBeDefined()
    const hints = capabilitiesCmd.complete?.([], "", h.ctx) ?? []
    const values = hints.map((x) => x.value)
    expect(values).toContain("list")
    expect(values).toContain("find")
  })

  test("completion narrows by partial", () => {
    const h = buildHarness()
    const hints = capabilitiesCmd.complete?.([], "fi", h.ctx) ?? []
    expect(hints.map((x) => x.value)).toEqual(["find"])
  })

  test("the command is named /capabilities and is read-only (config category)", () => {
    expect(capabilitiesCmd.name).toBe("/capabilities")
    expect(capabilitiesCmd.category).toBe("config")
  })
})
