/**
 * `/permission` slash-command renderer — pins the 4 sub-commands
 * (no-args summary, `explain <tool>`, `list`, `tier <tier>`) plus error
 * handling. Color is forced OFF so byte-checks are stable; an ON pair
 * confirms ANSI escapes appear when colors are enabled.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { permissionCmd, runPermissionRender } from "../../../src/apps/cli/permission-explain"
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

describe("/permission — registry wiring", () => {
  test("permissionCmd appears in BUILTINS", () => {
    const names = BUILTINS.map((c) => c.name)
    expect(names).toContain("/permission")
  })

  test("permissionCmd describe is non-empty + mentions sub-commands", () => {
    expect(permissionCmd.describe.length).toBeGreaterThan(0)
    expect(permissionCmd.describe).toContain("explain")
  })
})

describe("/permission — no args ⇒ summary", () => {
  test("zero args ⇒ exit 0 + summary on ctx.out", async () => {
    const c = buildCtx()
    const code = await runPermissionRender([], c.ctx)
    expect(code).toBe(0)
    const out = stripAnsi(c.out)
    expect(out).toContain("Mode:")
    expect(out).toContain("HARD_DENY")
    expect(out).toContain("5-axis")
    expect(out).toContain("/permission explain")
    expect(c.err).toBe("")
  })
})

describe("/permission explain <tool>", () => {
  test("`explain bash` ⇒ 5-axis pipeline + mode matrix", async () => {
    const c = buildCtx()
    const code = await runPermissionRender(["explain", "bash"], c.ctx)
    expect(code).toBe(0)
    const out = stripAnsi(c.out)
    // The 5 axes appear in the pipeline trace.
    expect(out).toContain("read-only-bypass")
    expect(out).toContain("hard-deny")
    expect(out).toContain("hitl-tier")
    expect(out).toContain("mode-policy")
    expect(out).toContain("global-default")
    // Mode matrix lists every mode.
    expect(out).toContain("default")
    expect(out).toContain("acceptEdits")
    expect(out).toContain("bypass")
    expect(out).toContain("auto")
  })

  test("`explain read` ⇒ shows the read-only short-circuit", async () => {
    const c = buildCtx()
    const code = await runPermissionRender(["explain", "read"], c.ctx)
    expect(code).toBe(0)
    const out = stripAnsi(c.out)
    expect(out).toContain("read-only-bypass")
    // A read-only tool should show 'yes' on the read-only row.
    expect(out).toMatch(/Read-only:\s+yes/)
  })

  test("`explain <unknown-tool>` ⇒ unmapped notice", async () => {
    const c = buildCtx()
    const code = await runPermissionRender(["explain", "no-such-tool-zzz"], c.ctx)
    expect(code).toBe(0)
    const out = stripAnsi(c.out)
    expect(out).toContain("unmapped")
  })

  test("`explain` with no tool name ⇒ exit 1 + error", async () => {
    const c = buildCtx()
    const code = await runPermissionRender(["explain"], c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("expected exactly one tool name")
  })
})

describe("/permission list", () => {
  test("`list` ⇒ tool table grouped by tier", async () => {
    const c = buildCtx()
    const code = await runPermissionRender(["list"], c.ctx)
    expect(code).toBe(0)
    const out = stripAnsi(c.out)
    expect(out).toContain("Tool / Tier Registry")
    // At least one default tool exists in some tier section.
    expect(out).toMatch(/always-confirm|pre-approval-ok|none/)
  })

  test("`list extra` ⇒ exit 1 (no args expected)", async () => {
    const c = buildCtx()
    const code = await runPermissionRender(["list", "extra"], c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("takes no arguments")
  })
})

describe("/permission tier <tier>", () => {
  test("`tier always-confirm` ⇒ tool list for that tier", async () => {
    const c = buildCtx()
    const code = await runPermissionRender(["tier", "always-confirm"], c.ctx)
    expect(code).toBe(0)
    const out = stripAnsi(c.out)
    expect(out).toContain("always-confirm")
  })

  test("`tier none` ⇒ tool list for that tier (read-only set)", async () => {
    const c = buildCtx()
    const code = await runPermissionRender(["tier", "none"], c.ctx)
    expect(code).toBe(0)
    const out = stripAnsi(c.out)
    expect(out).toContain("HITL Tier")
    expect(out).toContain("none")
  })

  test("`tier bogus` ⇒ exit 1 + valid-tier hint", async () => {
    const c = buildCtx()
    const code = await runPermissionRender(["tier", "bogus"], c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("invalid tier")
  })
})

describe("/permission — unknown sub-command", () => {
  test("`/permission frobnicate` ⇒ exit 1 + hint", async () => {
    const c = buildCtx()
    const code = await runPermissionRender(["frobnicate"], c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("unknown sub-command")
  })
})

describe("/permission — color policy honored", () => {
  test("color OFF ⇒ no ANSI escapes in output", async () => {
    setColorPolicy("off")
    const c = buildCtx()
    await runPermissionRender([], c.ctx)
    expect(c.out).not.toContain("\x1b[")
  })

  test("color ON ⇒ ANSI escapes present; stripAnsi yields same plain text as OFF", async () => {
    setColorPolicy("on")
    const cOn = buildCtx()
    await runPermissionRender([], cOn.ctx)
    expect(cOn.out).toContain("\x1b[")

    setColorPolicy("off")
    const cOff = buildCtx()
    await runPermissionRender([], cOff.ctx)
    expect(stripAnsi(cOn.out)).toBe(cOff.out)
  })
})

describe("/permission — end-to-end via runSlashCommand", () => {
  test("`/permission` dispatch ⇒ exit 0 + summary", async () => {
    const c = buildCtx()
    const code = await runSlashCommand("/permission", c.ctx)
    expect(code).toBe(0)
    const out = stripAnsi(c.out)
    expect(out).toContain("Permission Policy")
  })

  test("`/permission explain bash` end-to-end", async () => {
    const c = buildCtx()
    const code = await runSlashCommand("/permission explain bash", c.ctx)
    expect(code).toBe(0)
    const out = stripAnsi(c.out)
    expect(out).toContain("Permission · bash")
  })
})

describe("/permission — security: HARD_DENY descriptions only", () => {
  test("summary never includes a raw regex literal (no leading slash + flag)", async () => {
    const c = buildCtx()
    await runPermissionRender([], c.ctx)
    const out = stripAnsi(c.out)
    // Conservative: a raw `RegExp.toString()` always starts with `/` and
    // ends with `/` + flags. Our summary mentions counts only.
    expect(out).not.toMatch(/\/.*\/[gimsuy]*\s*$/m)
  })
})
