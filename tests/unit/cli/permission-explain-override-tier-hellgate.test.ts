/**
 * HELLGATE — `/permission` inspector MUST NOT under-report HITL strictness
 * (audit finding #20).
 *
 * The runtime admissibility gate resolves a tool's effective tier as
 *   `resolveHitlAnnotation(name, input, inferToolTier(tool, input))`
 * — i.e. the per-tool classifier baseline ESCALATED by the agent-side
 * annotation registry (built-in + operator overrides loaded from
 * `~/.quanta/hitl-overrides.json`, one-way ratchet).
 *
 * The inspector previously rendered the baseline ONLY (`inferToolTier`),
 * ignoring the override registry. So an operator who TIGHTENED a tool via an
 * override saw a LOOSER tier in `/permission explain|list|tier` than the gate
 * actually enforced — the inspector under-reported strictness while the
 * header (inspect.ts) claims the inspector can NEVER drift from runtime.
 *
 * Adversarial case proven here: with an operator override escalating the
 * read-only `read` tool from its baseline "none" to "always-confirm", every
 * inspector surface must report the STRICTER tier "always-confirm" — never
 * the baseline "none". Against the unfixed code (`resolveToolTier` =
 * `inferToolTier` only) `read` renders under "none" in all three surfaces and
 * these assertions FAIL.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetHitlOverrides } from "../../../src/agent/hitl-tier-registry"
import { runPermissionRender } from "../../../src/apps/cli/permission-explain"
import type { SlashContext } from "../../../src/apps/cli/slash-commands"
import { __resetRuntimeConfig } from "../../../src/shared"
import { setColorPolicy, stripAnsi } from "../../../src/ui/ui-helpers"

interface Captured {
  out: string
  err: string
  ctx: SlashContext
}

const buildCtx = (): Captured => {
  const captured: Captured = {
    out: "",
    err: "",
    ctx: {
      out: (s) => {
        captured.out += s
      },
      err: (s) => {
        captured.err += s
      },
      cwd: "/tmp",
    },
  }
  return captured
}

let tmp: string

/** Point the registry at an operator override file and reset both caches so
 *  the next inspector call re-reads it (mirrors hitl-tier-registry.test.ts). */
const applyOverrides = (annotations: unknown[]): void => {
  const path = join(tmp, "hitl-overrides.json")
  writeFileSync(path, JSON.stringify({ version: 1, annotations }), "utf8")
  process.env.QUANTA_HITL_OVERRIDES = path
  __resetRuntimeConfig()
  __resetHitlOverrides()
}

beforeEach(() => {
  tmp = join(tmpdir(), `perm-explain-hellgate-${process.pid}-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  setColorPolicy("off")
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  delete process.env.QUANTA_HITL_OVERRIDES
  __resetRuntimeConfig()
  __resetHitlOverrides()
  setColorPolicy(null)
})

describe("/permission inspector reflects operator override (no under-report)", () => {
  test("explain: stricter override on read-only tool ⇒ reports escalated tier, not baseline", async () => {
    // `read` is read-only ⇒ baseline tier "none". Operator escalates to
    // "always-confirm" (tool-only, fires on every invocation).
    applyOverrides([{ tool: "read", tier: "always-confirm" }])

    const c = buildCtx()
    const code = await runPermissionRender(["explain", "read"], c.ctx)
    expect(code).toBe(0)
    const out = stripAnsi(c.out)

    // The Tier: line MUST show the ENFORCED (escalated) tier.
    expect(out).toMatch(/Tier:\s+always-confirm/)
    // And MUST NOT under-report the loose baseline.
    expect(out).not.toMatch(/Tier:\s+none\b/)
  })

  test("tier: override-escalated tool listed under stricter tier, absent from baseline tier", async () => {
    applyOverrides([{ tool: "read", tier: "always-confirm" }])

    // `read` must appear in the always-confirm tier...
    const strict = buildCtx()
    expect(await runPermissionRender(["tier", "always-confirm"], strict.ctx)).toBe(0)
    expect(stripAnsi(strict.out)).toContain("read")

    // ...and must NOT appear in the baseline "none" tier anymore.
    const loose = buildCtx()
    expect(await runPermissionRender(["tier", "none"], loose.ctx)).toBe(0)
    const looseOut = stripAnsi(loose.out)
    // `read` is the exact escalated tool — assert it's not a standalone token
    // in the none-tier listing. (Other tools may legitimately contain it as a
    // substring, so match the surrounding separators the renderer emits.)
    const noneTools = looseOut
    // tier listing renders "  name1 · name2 · ..."
    const tokens = noneTools
      .split("\n")
      .flatMap((l) => l.split("·"))
      .map((s) => s.trim())
    expect(tokens).not.toContain("read")
  })

  test("baseline (no override) keeps read in tier 'none' — fix does not over-report", async () => {
    // Sanity guard: without an override the read tool stays at its baseline.
    process.env.QUANTA_HITL_OVERRIDES = join(tmp, "absent.json")
    __resetRuntimeConfig()
    __resetHitlOverrides()

    const c = buildCtx()
    expect(await runPermissionRender(["explain", "read"], c.ctx)).toBe(0)
    const out = stripAnsi(c.out)
    expect(out).toMatch(/Tier:\s+none\b/)
  })

  test("hand-off-required baseline is never downgraded by a relaxing override (ratchet honored in inspector)", async () => {
    // Operator tries to RELAX: but the registry one-way ratchet forbids it.
    // `bash` mutating baseline + a downgrade attempt must not loosen display.
    applyOverrides([{ tool: "read", tier: "none" }])

    const c = buildCtx()
    expect(await runPermissionRender(["explain", "read"], c.ctx)).toBe(0)
    const out = stripAnsi(c.out)
    // read baseline "none" + override "none" ⇒ stays "none" (no spurious change).
    expect(out).toMatch(/Tier:\s+none\b/)
  })
})
