/**
 * Hellgate — `/presets` command (§9.6 opusplan-style sticky model preset WIRE).
 *
 * `src/llm/model-preset.ts` is a producer-only slice with ZERO callers; this
 * command is its FIRST consumer. It does NOT reimplement presets — it renders
 * `listModelPresets()` and mutates a live `StickyPresetResolver` via `select`.
 *
 * Coverage (each a distinct behaviour, mutation-meaningful):
 *   - no-arg list ⇒ every built-in preset name + describe + its role→model
 *     bindings rendered (from the REAL registry, not a hand-rolled copy);
 *   - apply a valid preset ⇒ `select` mutates the SAME resolver the session
 *     reads, so `resolve(role, fallback)` becomes STICKY to the preset's
 *     bindings (fallback is IGNORED thereafter) — the core "sticky" proof;
 *   - the marked `*` current-selection reflects the applied preset;
 *   - unknown name ⇒ TYPED error ({ok:false} PresetError) surfaced with the
 *     list of valid names + exit 1, and the sticky selection is UNCHANGED
 *     (a bad name never clears a good selection — NO silent fallback);
 *   - absent slot ⇒ "not wired in this surface" + exit 0 (default-OFF
 *     byte-identical parity with the rest of the presence-gated commands);
 *   - registered exactly once, discoverable via the dispatcher + completer.
 *
 * The apply/sticky cases drive the command through the REAL
 * `createStickyPresetResolver` (not a fake), so reverting the `select()` call
 * in the command body flips them RED (red-on-injection proof, see the block
 * comment on the sticky test).
 */
import { describe, expect, test } from "bun:test"
import { BUILTIN_MODEL_PRESETS, createStickyPresetResolver, type StickyPresetResolver } from "@/llm"
import { presetsCmd } from "../slash/presets-cmd"
import { SESSION_SLASH_COMMANDS } from "../slash/registry-session"
import { BUILTINS, runSlashCommand, slashCompleter } from "../slash-commands"
import type { SlashContext } from "../slash-contract"

interface Harness {
  ctx: SlashContext
  readonly stdout: string
  readonly stderr: string
  readonly resolver: StickyPresetResolver
}

const buildHarness = (opts?: { readonly withPresets?: boolean }): Harness => {
  let stdout = ""
  let stderr = ""
  // REAL resolver — the same construct the composition root wires. The command
  // mutating THIS is what makes the session's role→model resolution sticky.
  const resolver = createStickyPresetResolver()
  const ctx: SlashContext = {
    out: (s) => {
      stdout += s
    },
    err: (s) => {
      stderr += s
    },
    cwd: "/tmp",
    ...((opts?.withPresets ?? true) ? { presets: resolver } : {}),
  }
  return {
    ctx,
    resolver,
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
  }
}

describe("/presets command — list (no arg)", () => {
  test("renders every built-in preset name + describe + role→model bindings", async () => {
    const h = buildHarness()
    const code = await runSlashCommand("/presets", h.ctx)
    expect(code).toBe(0)
    for (const p of BUILTIN_MODEL_PRESETS) {
      expect(h.stdout).toContain(p.name)
      expect(h.stdout).toContain(p.describe)
      expect(h.stdout).toContain(p.defaultModel)
      for (const [role, model] of Object.entries(p.roles)) {
        expect(h.stdout).toContain(role)
        expect(h.stdout).toContain(model as string)
      }
    }
    expect(h.stdout).toContain("use: /presets <name>")
  })
})

describe("/presets command — apply (sticky)", () => {
  test("applying a valid preset makes role→model resolution STICKY to it", async () => {
    const h = buildHarness()
    // Before: no selection ⇒ resolve returns the caller fallback VERBATIM.
    expect(h.resolver.resolve("plan-writer", "boot-fallback")).toBe("boot-fallback")

    const code = await runSlashCommand("/presets opusplan", h.ctx)
    expect(code).toBe(0)
    expect(h.stderr).toBe("")

    // ── RED-ON-INJECTION ANCHOR ──────────────────────────────────────────
    // These assertions read the REAL resolver the command was handed. They
    // pass ONLY because the command called `presets.select("opusplan")`. If
    // the `select` call is removed/reverted in `presets-cmd.ts`, `selected()`
    // stays undefined and `resolve` keeps returning the fallback ⇒ RED.
    const selected = h.resolver.selected()
    expect(selected?.name).toBe("opusplan")
    // Sticky: the preset binding WINS over the fallback (fallback ignored).
    expect(h.resolver.resolve("plan-writer", "boot-fallback")).toBe("claude-opus-4-8")
    expect(h.resolver.resolve("executor", "boot-fallback")).toBe("claude-sonnet-4-6")
    // An unmapped role falls to the preset's OWN default (never the fallback).
    expect(h.resolver.resolve("default", "boot-fallback")).toBe("claude-sonnet-4-6")

    // Confirmation echoed, current marked.
    expect(h.stdout).toContain("opusplan")
  })

  test("no-arg list AFTER apply marks the active preset", async () => {
    const h = buildHarness()
    await runSlashCommand("/presets opusplan", h.ctx)
    const code = await runSlashCommand("/presets", h.ctx)
    expect(code).toBe(0)
    const starLines = h.stdout.split("\n").filter((l) => l.trimStart().startsWith("*"))
    expect(starLines.length).toBe(1)
    expect(starLines[0]).toContain("opusplan")
  })
})

describe("/presets command — unknown name (typed error, NO silent fallback)", () => {
  test("unknown name ⇒ error + valid-name list + exit 1, selection UNCHANGED", async () => {
    const h = buildHarness()
    // Seed a good selection first — a bad name must NOT clear it.
    await runSlashCommand("/presets opusplan", h.ctx)
    expect(h.resolver.selected()?.name).toBe("opusplan")

    const code = await runSlashCommand("/presets not-a-real-preset", h.ctx)
    expect(code).toBe(1)
    expect(h.stderr).toContain("not-a-real-preset")
    // The typed error lists every VALID preset name — no silent default.
    for (const p of BUILTIN_MODEL_PRESETS) expect(h.stderr).toContain(p.name)
    // NO silent fallback: the prior good selection survives the bad name.
    expect(h.resolver.selected()?.name).toBe("opusplan")
    // resolve still sticky to the GOOD preset, not degraded to a default.
    expect(h.resolver.resolve("plan-writer", "boot-fallback")).toBe("claude-opus-4-8")
  })

  test("unknown name with NO prior selection ⇒ still fallback-verbatim (no default invented)", async () => {
    const h = buildHarness()
    const code = await runSlashCommand("/presets nope", h.ctx)
    expect(code).toBe(1)
    expect(h.resolver.selected()).toBeUndefined()
    expect(h.resolver.resolve("plan-writer", "boot-fallback")).toBe("boot-fallback")
  })
})

describe("/presets command — presence gate", () => {
  test("absent slot ⇒ 'not wired in this surface' + exit 0", async () => {
    const h = buildHarness({ withPresets: false })
    const code = await runSlashCommand("/presets opusplan", h.ctx)
    expect(code).toBe(0)
    expect(h.stdout).toContain("/presets: not wired in this surface")
    expect(h.stderr).toBe("")
  })

  test("too many args ⇒ exit 1 (a preset name is a single token)", async () => {
    const h = buildHarness()
    const code = await runSlashCommand("/presets opusplan extra", h.ctx)
    expect(code).toBe(1)
    expect(h.stderr).toContain("at most one")
    expect(h.resolver.selected()).toBeUndefined()
  })
})

describe("/presets slash drift-guard", () => {
  test("registered exactly once across BUILTINS", () => {
    const names = BUILTINS.map((c) => c.name)
    expect(names.filter((n) => n === "/presets").length).toBe(1)
  })

  test("lives in the SESSION layer (imports @/llm preset registry)", () => {
    expect(SESSION_SLASH_COMMANDS.some((c) => c.name === "/presets")).toBe(true)
  })

  test("carries describe + run", () => {
    expect(typeof presetsCmd.describe).toBe("string")
    expect(typeof presetsCmd.run).toBe("function")
  })

  test("discoverable via the name completer", () => {
    const [matches] = slashCompleter("/pres")
    expect(matches).toContain("/presets")
  })
})
