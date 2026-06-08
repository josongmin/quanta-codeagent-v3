import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REPO_MAP_TRUNCATION_MARKER, type RepoMapShell } from "@/runner/assemble/repo-map-scan"
import { stripAnsi } from "@/ui"
import {
  buildInitCmd,
  detectCommands,
  INIT_AUTO_END,
  INIT_AUTO_START,
  scaffoldClaudeMd,
} from "../../../src/apps/cli/init-scaffold"
import { BUILTINS } from "../../../src/apps/cli/slash-commands"
import type { SlashContext } from "../../../src/apps/cli/slash-contract"

/**
 * LANE SLASH / Ticket 16 — `/init` CLAUDE.md scaffold.
 *
 * Coverage:
 *   - `scaffoldClaudeMd` is a deterministic golden (section order, no clock/fs
 *     leak, repoMap-with-marker rides verbatim).
 *   - `detectCommands` is CONSERVATIVE (per-command undefined; Makefile/Justfile
 *     fallback; all-undefined empty).
 *   - `/init` write/refuse/force/dry-run flows + write-failure NO-THROW.
 *   - DEFAULT-OFF byte-identity: with `QUANTA_INIT_SLASH` unset, `/init` is
 *     absent from the registered BUILTINS.
 */

// ── shell mock (RepoMapShell duck type) ───────────────────────────────────────
const cannedShell = (stdout: string, exitCode = 0): RepoMapShell => {
  return async () => ({ stdout, exitCode, timedOut: false })
}

interface Captured {
  out: string
  err: string
  ctx: SlashContext
}
const buildCtx = (cwd: string): Captured => {
  const c: Captured = {
    out: "",
    err: "",
    ctx: {
      out: (s) => {
        c.out += s
      },
      err: (s) => {
        c.err += s
      },
      cwd,
    },
  }
  return c
}

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "init-scaffold-"))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// ── scaffoldClaudeMd — deterministic golden ───────────────────────────────────
describe("scaffoldClaudeMd (pure golden)", () => {
  test("fixed section order, no clock/fs leak — byte-stable across two calls", () => {
    const a = scaffoldClaudeMd("/work/my-proj", {
      repoMap: "src/\n  index.ts",
      buildCmd: "bun run build",
      testCmd: "bun test",
      typecheckCmd: "bun run typecheck",
      lintCmd: "bun run lint",
    })
    const b = scaffoldClaudeMd("/work/my-proj", {
      repoMap: "src/\n  index.ts",
      buildCmd: "bun run build",
      testCmd: "bun test",
      typecheckCmd: "bun run typecheck",
      lintCmd: "bun run lint",
    })
    // No clock/fs leak ⇒ identical bytes on repeat.
    expect(a).toBe(b)
    // Title is the cwd basename.
    expect(a.startsWith("# my-proj\n")).toBe(true)
    // Section order is fixed: Quick Start < Directory < Key Files < Conventions.
    const iQuick = a.indexOf("## Quick Start")
    const iDir = a.indexOf("## Directory")
    const iKey = a.indexOf("## Key Files")
    const iConv = a.indexOf("## Conventions")
    expect(iQuick).toBeGreaterThan(-1)
    expect(iQuick).toBeLessThan(iDir)
    expect(iDir).toBeLessThan(iKey)
    expect(iKey).toBeLessThan(iConv)
    // Commands rendered into Quick Start.
    expect(a).toContain("- Build: `bun run build`")
    expect(a).toContain("- Test: `bun test`")
    // Surgical sentinels bracket the auto block.
    const iStart = a.indexOf(INIT_AUTO_START)
    const iEnd = a.indexOf(INIT_AUTO_END)
    expect(iStart).toBeGreaterThan(-1)
    expect(iEnd).toBeGreaterThan(iStart)
    // Trailing newline.
    expect(a.endsWith("\n")).toBe(true)
  })

  test("repoMap-with-truncation-marker rides verbatim inside ## Directory", () => {
    const map = `src/\n  a.ts\n${REPO_MAP_TRUNCATION_MARKER}`
    const out = scaffoldClaudeMd("/r/proj", { repoMap: map })
    // The already-truncated map (incl. the marker) is embedded byte-for-byte.
    expect(out).toContain(map)
    expect(out).toContain(REPO_MAP_TRUNCATION_MARKER)
  })

  test("undefined commands degrade to a 'not detected' placeholder (never invented)", () => {
    const out = scaffoldClaudeMd("/r/proj", {})
    expect(out).toContain("- Build: _(not detected — fill in)_")
    // No phantom command was fabricated: no backtick-wrapped command bullet
    // (the ``` fences around the Directory map are not command bullets).
    expect(out).not.toMatch(/- (?:Build|Test|Typecheck|Lint): `[^`]+`/)
  })

  test("empty cwd basename falls back to 'project' (no crash)", () => {
    const out = scaffoldClaudeMd("/", {})
    expect(out.startsWith("# project\n")).toBe(true)
  })
})

// ── detectCommands — conservative ─────────────────────────────────────────────
describe("detectCommands (conservative — never invents)", () => {
  test("package.json: maps present scripts to '<pm> run <key>'; absent ⇒ undefined", async () => {
    // bun.lock ⇒ pm = bun. Only `test` + `lint` scripts present.
    writeFileSync(join(tmp, "bun.lock"), "")
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { test: "bun test", lint: "biome check" } }),
    )
    const cmds = await detectCommands(tmp)
    expect(cmds.test).toBe("bun run test")
    expect(cmds.lint).toBe("bun run lint")
    // build / typecheck not in scripts ⇒ undefined (never invented).
    expect(cmds.build).toBeUndefined()
    expect(cmds.typecheck).toBeUndefined()
  })

  test("package manager derives from lockfile (pnpm)", async () => {
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "")
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }))
    const cmds = await detectCommands(tmp)
    expect(cmds.build).toBe("pnpm run build")
  })

  test("no package.json → Makefile fallback (make <target>)", async () => {
    writeFileSync(join(tmp, "Makefile"), "build:\n\tgo build ./...\ntest:\n\tgo test ./...\n")
    const cmds = await detectCommands(tmp)
    expect(cmds.build).toBe("make build")
    expect(cmds.test).toBe("make test")
    // lint target absent ⇒ undefined.
    expect(cmds.lint).toBeUndefined()
  })

  test("no package.json / no Makefile → Justfile fallback (just <recipe>)", async () => {
    writeFileSync(join(tmp, "Justfile"), "test:\n    cargo test\nlint args:\n    cargo clippy\n")
    const cmds = await detectCommands(tmp)
    expect(cmds.test).toBe("just test")
    // recipe with params still matches.
    expect(cmds.lint).toBe("just lint")
    expect(cmds.build).toBeUndefined()
  })

  test("nothing recognized ⇒ all fields undefined", async () => {
    const cmds = await detectCommands(tmp)
    expect(cmds.build).toBeUndefined()
    expect(cmds.test).toBeUndefined()
    expect(cmds.typecheck).toBeUndefined()
    expect(cmds.lint).toBeUndefined()
  })

  test("malformed package.json ⇒ NO-THROW, falls back to all-undefined", async () => {
    writeFileSync(join(tmp, "package.json"), "{ not json")
    const cmds = await detectCommands(tmp)
    expect(cmds).toEqual({})
  })
})

// ── /init command flows ───────────────────────────────────────────────────────
describe("/init slash flows", () => {
  test("fresh repo (no rules file) → writes CLAUDE.md + 3-bullet summary, exit 0", async () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
    writeFileSync(join(tmp, "bun.lock"), "")
    const cmd = buildInitCmd({ shell: cannedShell("src/index.ts\nsrc/util.ts\n") })
    const c = buildCtx(tmp)
    const code = await cmd.run([], c.ctx)
    expect(code).toBe(0)
    // File was actually written (OBSERVE the effect, not a claim).
    const written = readFileSync(join(tmp, "CLAUDE.md"), "utf8")
    expect(written).toContain("# ")
    expect(written).toContain("- Test: `bun run test`")
    expect(written).toContain(INIT_AUTO_START)
    // Success line + 3-bullet summary.
    expect(stripAnsi(c.out)).toContain("✓ wrote")
    expect(c.out).toContain("repo-rules")
    expect(c.out).toContain("quanta:auto")
    expect(c.out).toContain("refresh CLAUDE.md")
  })

  test("--dry-run writes NOTHING, prints scaffold + dry-run notice, exit 0", async () => {
    const cmd = buildInitCmd({ shell: cannedShell("a.ts\n") })
    const c = buildCtx(tmp)
    const code = await cmd.run(["--dry-run"], c.ctx)
    expect(code).toBe(0)
    // No file on disk.
    expect(() => readFileSync(join(tmp, "CLAUDE.md"), "utf8")).toThrow()
    expect(() => readFileSync(join(tmp, "AGENTS.md"), "utf8")).toThrow()
    // Scaffold was printed.
    expect(c.out).toContain("## Quick Start")
    expect(stripAnsi(c.out)).toContain("dry-run — nothing written")
  })

  test("existing file + no --force ⇒ refuse, exit 1, BYTES UNCHANGED", async () => {
    const before = "# hand-written\n\n## Conventions\n- do not touch\n"
    writeFileSync(join(tmp, "CLAUDE.md"), before)
    const cmd = buildInitCmd({ shell: cannedShell("a.ts\n") })
    const c = buildCtx(tmp)
    const code = await cmd.run([], c.ctx)
    expect(code).toBe(1)
    // The refusal is helpful: size + section count + exact re-run cmd + skill pointer.
    expect(c.err).toContain("CLAUDE.md exists")
    expect(c.err).toContain("section")
    expect(c.err).toContain("/init --force")
    expect(c.err).toContain("/init --dry-run")
    expect(c.err).toContain("refresh CLAUDE.md")
    // The existing file's bytes are UNCHANGED.
    expect(readFileSync(join(tmp, "CLAUDE.md"), "utf8")).toBe(before)
  })

  test("--force overwrites the existing file, exit 0", async () => {
    const before = "# hand-written\n"
    writeFileSync(join(tmp, "CLAUDE.md"), before)
    const cmd = buildInitCmd({ shell: cannedShell("a.ts\n") })
    const c = buildCtx(tmp)
    const code = await cmd.run(["--force"], c.ctx)
    expect(code).toBe(0)
    const after = readFileSync(join(tmp, "CLAUDE.md"), "utf8")
    expect(after).not.toBe(before)
    expect(after).toContain("## Quick Start")
  })

  test("prefers EXISTING AGENTS.md as the target (multi-vendor SSOT)", async () => {
    writeFileSync(join(tmp, "AGENTS.md"), "# rules\n")
    const cmd = buildInitCmd({ shell: cannedShell("a.ts\n") })
    const c = buildCtx(tmp)
    // exists + no force ⇒ refusal mentions AGENTS.md (not CLAUDE.md).
    const code = await cmd.run([], c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("AGENTS.md exists")
  })

  test("write failure ⇒ NO-THROW, exit 1, friendly error", async () => {
    const cmd = buildInitCmd({
      shell: cannedShell("a.ts\n"),
      write: async () => {
        throw new Error("EACCES: permission denied")
      },
    })
    const c = buildCtx(tmp)
    let code: number | undefined
    // The public surface MUST NOT throw — assert no exception escapes `run`.
    await expect(
      (async () => {
        code = await cmd.run([], c.ctx)
      })(),
    ).resolves.toBeUndefined()
    expect(code).toBe(1)
    expect(c.err).toContain("failed to write")
    expect(c.err).toContain("EACCES")
    // And no file leaked to disk (the injected writer threw before any real write).
    expect(() => readFileSync(join(tmp, "CLAUDE.md"), "utf8")).toThrow()
  })

  test("unknown flag ⇒ exit 1 with usage hint, writes nothing", async () => {
    const cmd = buildInitCmd({ shell: cannedShell("a.ts\n") })
    const c = buildCtx(tmp)
    const code = await cmd.run(["--nope"], c.ctx)
    expect(code).toBe(1)
    expect(c.err).toContain("unknown argument")
    expect(() => readFileSync(join(tmp, "CLAUDE.md"), "utf8")).toThrow()
  })
})

// ── DEFAULT-OFF byte-identity ─────────────────────────────────────────────────
describe("default-OFF byte-identity (QUANTA_INIT_SLASH)", () => {
  test("gate unset ⇒ /init absent from registered BUILTINS", () => {
    // The unit-test environment leaves QUANTA_INIT_SLASH unset, so the surface
    // registry must NOT contain /init (byte-identical to before the ticket).
    expect(process.env.QUANTA_INIT_SLASH).toBeUndefined()
    expect(BUILTINS.map((cmd) => cmd.name)).not.toContain("/init")
  })

  test("red-on-injection: if /init were unconditionally registered, this guard fails", () => {
    // This is the inverse invariant — the BUILTINS sweep in slash-commands.test.ts
    // asserts the EXACT list; adding /init there without the gate would make this
    // pass AND that sweep fail. Keeping them split proves the gate is load-bearing.
    const names = BUILTINS.map((cmd) => cmd.name)
    expect(names.filter((n) => n === "/init")).toHaveLength(0)
  })
})
