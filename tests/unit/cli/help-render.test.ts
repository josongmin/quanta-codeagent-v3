/** `/help` unified menu — slash inventory + keybinds + ENV knobs.
 *
 *  Tests pin the renderer's three contracts: (a) every BUILTINS entry shows
 *  up automatically (no hand-maintained allowlist), (b) keybind + ENV
 *  sections are always present, (c) color policy is honored end-to-end —
 *  `setColorPolicy("off")` ⇒ plain ASCII, `setColorPolicy("on")` ⇒ ANSI
 *  with stripAnsi-equivalent payload. Detail mode (`/help <name>`) covers
 *  the bonus per-command lookup.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { renderHelp, renderHelpDetail, runHelpRender } from "../../../src/apps/cli/help-render"
import { BUILTINS, runSlashCommand, type SlashContext } from "../../../src/apps/cli/slash-commands"
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

beforeEach(() => {
  setColorPolicy("off")
})

afterEach(() => {
  setColorPolicy(null)
})

describe("renderHelp — slash inventory (dynamic from BUILTINS)", () => {
  test("includes every registered BUILTINS command name", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    for (const c of BUILTINS) {
      expect(out).toContain(c.name)
      // describe also rendered so users see what each command does
      expect(out).toContain(c.describe)
    }
  })

  test("/help references itself (self-inclusion via dynamic iteration)", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    expect(out).toContain("/help")
    expect(out).toContain("Show all slash commands, keybinds, and ENV knobs")
  })

  test("includes virtual /exit and /quit commands", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    expect(out).toContain("/exit")
    expect(out).toContain("/quit")
  })
})

describe("renderHelp — keybinds + ENV knobs sections", () => {
  test("keybinds section present with raw-line-reader bindings", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    expect(out).toContain("keybinds (raw-line-reader)")
    expect(out).toContain("Tab")
    expect(out).toContain("Ctrl+C")
    expect(out).toContain("Ctrl+D")
  })

  test("ENV knobs section present with SSOT-routed QUANTA_* prefixes", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    // The env-var table is now auto-derived from the runtimeConfig() SSOT
    // (src/shared/runtime-config.ts). Surface-level vars not routed through
    // the SSOT (QUANTA_MODEL, QUANTA_PROVIDER, ~120 others) live in docs/
    // and are intentionally not enumerated here.
    expect(out).toContain("Environment variables")
    expect(out).toContain("QUANTA_LOG_LEVEL")
    expect(out).toContain("QUANTA_FS_JAIL")
    expect(out).toContain("QUANTA_MAX_TURNS")
    expect(out).toContain("QUANTA_HOME")
  })
})

describe("renderHelp — color policy integration", () => {
  test("color OFF ⇒ no ANSI escape bytes", () => {
    setColorPolicy("off")
    const out = renderHelp(BUILTINS)
    expect(out).not.toContain("\x1b[")
  })

  test("color ON ⇒ ANSI escapes present, stripAnsi recovers plain text", () => {
    setColorPolicy("on")
    const colored = renderHelp(BUILTINS)
    expect(colored).toContain("\x1b[")
    setColorPolicy("off")
    const plain = renderHelp(BUILTINS)
    // After stripping, the colored render equals the plain render byte-for-byte.
    expect(stripAnsi(colored)).toBe(plain)
  })
})

describe("renderHelpDetail — `/help <name>` per-command lookup", () => {
  test("known name (with leading /) ⇒ detail box", () => {
    const out = renderHelpDetail(BUILTINS, "/skills")
    expect(out).toBeDefined()
    expect(stripAnsi(out as string)).toContain("/skills")
    expect(stripAnsi(out as string)).toContain("describe:")
  })

  test("known name (no leading /) ⇒ detail box (auto-prefix)", () => {
    const out = renderHelpDetail(BUILTINS, "status")
    expect(out).toBeDefined()
    expect(stripAnsi(out as string)).toContain("/status")
  })

  test("unknown name ⇒ undefined (caller prints error)", () => {
    expect(renderHelpDetail(BUILTINS, "/nope-zzz")).toBeUndefined()
  })
})

describe("runHelpRender — SlashCommand callback", () => {
  test("zero args ⇒ exit 0 + full menu on ctx.out", async () => {
    const c = buildCtx()
    const code = await runHelpRender(BUILTINS, [], c.ctx)
    expect(code).toBe(0)
    expect(c.out).toContain("/help")
    expect(c.out).toContain("/context")
    expect(c.err).toBe("")
  })

  test("one known arg ⇒ exit 0 + detail on ctx.out", async () => {
    const c = buildCtx()
    const code = await runHelpRender(BUILTINS, ["color"], c.ctx)
    expect(code).toBe(0)
    expect(c.out).toContain("/color")
    expect(c.err).toBe("")
  })

  test("one unknown arg ⇒ exit 1 + error on ctx.err", async () => {
    const c = buildCtx()
    const code = await runHelpRender(BUILTINS, ["zzz-bogus"], c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("unknown command")
  })

  test("two args ⇒ exit 1 + error", async () => {
    const c = buildCtx()
    const code = await runHelpRender(BUILTINS, ["a", "b"], c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("expected at most one argument")
  })
})

describe("/help — end-to-end via runSlashCommand", () => {
  test("`/help` dispatch ⇒ exit 0 + menu painted", async () => {
    const c = buildCtx()
    const code = await runSlashCommand("/help", c.ctx)
    expect(code).toBe(0)
    expect(c.out).toContain("/help")
    expect(c.out).toContain("/context")
    expect(c.out).toContain("Tab")
    // Env table is now SSOT-routed (QUANTA_LOG_LEVEL is the canary).
    expect(c.out).toContain("QUANTA_LOG_LEVEL")
  })
})
