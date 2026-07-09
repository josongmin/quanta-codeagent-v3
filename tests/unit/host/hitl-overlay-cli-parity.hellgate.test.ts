/**
 * ★ HELLGATE — D-1 (jul-10 uiux structural, UUX-1-03 Crit): the CLI/web
 *   `hitl.enabled` split.
 *
 * Pinned bug: the web daemon seeds `hitl: { enabled: true }` on its base
 * config (runtime-factory) so always-confirm tools ask EVEN under
 * bypass/acceptEdits. The CLI never set `hitl` anywhere — the gate's
 * `config.hitl?.enabled !== true` fallthrough let `acceptEdits` auto-allow
 * NON-floor always-confirm tools that the web would have prompted for. Same
 * user, same machine, different policy depending on the surface.
 *
 * D-1 decision: the CLI seeds `hitl: { enabled: true }` whenever a live
 * operator can actually answer (stdin is a TTY). Non-TTY (piped/headless CLI)
 * keeps the legacy fallthrough — enabling there would HANG a pipeline on a
 * prompt nobody can see.
 *
 * Contract under test:
 *   1. `RuntimeBootstrapOverlay.hitl` threads onto the runtime base config
 *      (the seam the CLI composition rides).
 *   2. The CLI overlay builder seeds `hitl.enabled` from its TTY-gated input.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("HELLGATE D-1 — overlay.hitl threads to the runtime base", () => {
  // Same wiring-pin convention as named-agent-resolver-interactive-batch-wire:
  // the lift is a one-line whenDefined spread; pin it at the source so a
  // refactor that drops the slot goes RED (a full boot fake is not the repo's
  // pattern for these lifts).
  test("host overlay → base lift exists (RuntimeBootstrapOverlay.hitl)", () => {
    const base = readFileSync(
      join(import.meta.dir, "../../../src/host/runtime/internal/context-binding/base.ts"),
      "utf8",
    )
    expect(/whenDefined\("hitl",\s*args\.overlay\?\.hitl\)/.test(base)).toBe(true)
  })

  test("the overlay type declares the hitl slot (AgentConfig-typed)", () => {
    const types = readFileSync(
      join(import.meta.dir, "../../../src/host/runtime/internal/context-binding/types.ts"),
      "utf8",
    )
    expect(/readonly hitl\?: AgentConfig\["hitl"\]/.test(types)).toBe(true)
  })
})

describe("HELLGATE D-1 — the CLI composition seeds hitl (TTY-gated)", () => {
  test("runtime-context-compose overlays hitl.enabled behind the interactive-TTY gate", () => {
    // Wiring pin (the compose root needs a full boot to execute): the overlay
    // literal must seed `hitl` with the TTY gate — the exact split UUX-1-03
    // pinned is the ABSENCE of any `hitl` seed in the CLI composition.
    const src = readFileSync(
      join(import.meta.dir, "../../../src/apps/cli/repl/runtime-context-compose.ts"),
      "utf8",
    )
    expect(src).toContain("hitl: { enabled: true }")
    expect(/isTTY === true[\s\S]{0,120}hitl: \{ enabled: true \}/.test(src)).toBe(true)
  })
})
