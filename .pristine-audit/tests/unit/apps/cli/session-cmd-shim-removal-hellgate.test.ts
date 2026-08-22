import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SessionCommandDeps } from "@/runner/session-ops"
import { __resetRuntimeConfig } from "@/shared"
import {
  createCliImportHandler,
  createCliImportHandlerWithRoot,
} from "../../../../src/apps/cli/session-import-handler"
import { resolveCliSessionListEnv } from "../../../../src/apps/cli/session-list-env"

/**
 * CLI-05 (ADR-0305) — hellgate suite for the `session-commands.ts` shim
 * removal. Every adversarial path is enumerated; the suite FAILS if anyone
 * re-introduces the shim, re-imports its dead path, or wires the runner
 * call site without the two surface adapters.
 *
 * Structural cases (source-grep) lock in the slice geometry; functional
 * cases (factory + resolver) verify that the two extracted helpers retain
 * the prior shim's byte-identical behavior for the two CLI-specific
 * concerns (migration handler injection + list-env defaulting).
 */

const REPO_ROOT = resolve(__dirname, "../../../..")

const SKIP_DIRS = new Set(["node_modules", "dist", "build"])

const safeReaddir = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

const safeStat = (p: string): ReturnType<typeof statSync> | undefined => {
  try {
    return statSync(p)
  } catch {
    return undefined
  }
}

const isTsLike = (p: string): boolean => p.endsWith(".ts") || p.endsWith(".tsx")

interface WalkVisit {
  readonly tsFiles: readonly string[]
  readonly subdirs: readonly string[]
}

const visitDir = (dir: string): WalkVisit => {
  const tsFiles: string[] = []
  const subdirs: string[] = []
  for (const name of safeReaddir(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = safeStat(p)
    if (st === undefined) continue
    if (st.isDirectory()) subdirs.push(p)
    else if (st.isFile() && isTsLike(p)) tsFiles.push(p)
  }
  return { tsFiles, subdirs }
}

/** Recursively collect `*.ts` / `*.tsx` files under `root` (skipping
 *  node_modules / dist / build). Returns absolute paths. Used for the
 *  "no src file imports the dead path" structural cases — cheap
 *  pure-node walker so the test has no extra dependencies. */
const walkTs = (root: string): string[] => {
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) break
    const { tsFiles, subdirs } = visitDir(dir)
    for (const f of tsFiles) out.push(f)
    for (const d of subdirs) stack.push(d)
  }
  return out
}

// =============================================================================
// STRUCTURAL — file existence + import path deadness
// =============================================================================

describe("CLI-05: structural — shim is gone", () => {
  test("HELL-01: src/apps/cli/session-commands.ts does NOT exist", () => {
    const p = join(REPO_ROOT, "src/apps/cli/session-commands.ts")
    expect(existsSync(p)).toBe(false)
  })

  test("HELL-02: replacement file session-import-handler.ts exists", () => {
    const p = join(REPO_ROOT, "src/apps/cli/session-import-handler.ts")
    expect(existsSync(p)).toBe(true)
  })

  test("HELL-03: replacement file session-list-env.ts exists", () => {
    const p = join(REPO_ROOT, "src/apps/cli/session-list-env.ts")
    expect(existsSync(p)).toBe(true)
  })

  test("HELL-04: no src/** TS file imports ./session-commands or @/apps/cli/session-commands", () => {
    const srcRoot = join(REPO_ROOT, "src")
    const files = walkTs(srcRoot)
    const offenders: string[] = []
    // Match the exact dead import-path forms. Doc comments referring to the
    // historic filename are allowed (the audit rule below catches verbatim
    // `from "..."` imports only). The runner slice retains two such comment
    // mentions which are intentional historical context, not imports.
    const re = /\bfrom\s+["'](?:\.\/session-commands|@\/apps\/cli\/session-commands)["']/
    for (const f of files) {
      const text = readFileSync(f, "utf8")
      if (re.test(text)) offenders.push(f.replace(`${REPO_ROOT}/`, ""))
    }
    expect(offenders).toEqual([])
  })

  test("HELL-05: src/apps/cli/repl.ts imports runSessionCommand as runSessionCommandInner from @/runner/session-ops", () => {
    const text = readFileSync(join(REPO_ROOT, "src/apps/cli/repl.ts"), "utf8")
    expect(text).toContain(
      'runSessionCommand as runSessionCommandInner } from "@/runner/session-ops"',
    )
  })

  test("HELL-06: src/apps/cli/repl.ts calls runSessionCommandInner (not the dead shim alias)", () => {
    const text = readFileSync(join(REPO_ROOT, "src/apps/cli/repl.ts"), "utf8")
    expect(text).toContain("runSessionCommandInner(process.argv.slice(3)")
  })

  test("HELL-07: src/apps/cli/repl.ts imports createCliImportHandler from ./session-import-handler", () => {
    const text = readFileSync(join(REPO_ROOT, "src/apps/cli/repl.ts"), "utf8")
    expect(text).toContain('import { createCliImportHandler } from "./session-import-handler"')
  })

  test("HELL-08: src/apps/cli/repl.ts imports resolveCliSessionListEnv from ./session-list-env", () => {
    const text = readFileSync(join(REPO_ROOT, "src/apps/cli/repl.ts"), "utf8")
    expect(text).toContain('import { resolveCliSessionListEnv } from "./session-list-env"')
  })

  test("HELL-09: runSessionMain wires importHandler + listEnv into deps", () => {
    const text = readFileSync(join(REPO_ROOT, "src/apps/cli/repl.ts"), "utf8")
    expect(text).toContain("importHandler: createCliImportHandler()")
    expect(text).toContain("resolveCliSessionListEnv()")
  })
})

// =============================================================================
// FUNCTIONAL — createCliImportHandler factory
// =============================================================================

describe("CLI-05: functional — createCliImportHandler()", () => {
  test("HELL-10: factory returns a callable function", () => {
    const fn = createCliImportHandler()
    expect(typeof fn).toBe("function")
  })

  test("HELL-11: handler with no args returns exit 1 and writes a missing-provider error", async () => {
    const fn = createCliImportHandler()
    let outBuf = ""
    let errBuf = ""
    const deps: SessionCommandDeps = {
      out: (s) => {
        outBuf += s
      },
      err: (s) => {
        errBuf += s
      },
      confirm: async () => false,
    }
    const rc = await fn([], deps)
    expect(rc).toBe(1)
    expect(errBuf).toContain("session import:")
    expect(errBuf).toContain("missing <provider>")
    expect(outBuf).toBe("")
  })

  test("HELL-12: handler rejects unknown provider with exit 1", async () => {
    const fn = createCliImportHandler()
    let errBuf = ""
    const deps: SessionCommandDeps = {
      out: () => undefined,
      err: (s) => {
        errBuf += s
      },
      confirm: async () => false,
    }
    const rc = await fn(["bogus_provider"], deps)
    expect(rc).toBe(1)
    expect(errBuf).toContain("unknown provider: bogus_provider")
  })

  test.each([
    "cursor",
    "aider",
  ])("HELL-12a: unsupported stub provider %s is rejected before import or persistence", async (provider) => {
    const fn = createCliImportHandler()
    let outBuf = ""
    let errBuf = ""
    const deps: SessionCommandDeps = {
      out: (s) => {
        outBuf += s
      },
      err: (s) => {
        errBuf += s
      },
      confirm: async () => false,
    }

    const rc = await fn([provider], deps)

    expect(rc).toBe(1)
    expect(errBuf).toContain(`unknown provider: ${provider}`)
    expect(errBuf).toContain("expected claude_code")
    expect(outBuf).toBe("")
  })

  test("HELL-13: handler with extra positional rejects with exit 1", async () => {
    const fn = createCliImportHandler()
    let errBuf = ""
    const deps: SessionCommandDeps = {
      out: () => undefined,
      err: (s) => {
        errBuf += s
      },
      confirm: async () => false,
    }
    const rc = await fn(["claude_code", "extra"], deps)
    expect(rc).toBe(1)
    expect(errBuf).toContain("unexpected argument: extra")
  })

  test("HELL-14: handler persists translated sessions on success (ADR-0430)", async () => {
    __resetRuntimeConfig()
    const home = mkdtempSync(join(tmpdir(), "cli-05-import-home-"))
    // ADR-0430: persistence is now real, so inject a tmp sessions root to keep
    // the test off the real `~/.quanta/sessions`.
    const sessionsDir = mkdtempSync(join(tmpdir(), "cli-05-import-sessions-"))
    try {
      await mkdir(join(home, ".claude/projects/proj-x"), { recursive: true })
      await mkdir(join(home, ".claude/skills"), { recursive: true })
      await writeFile(join(home, ".claude/auth.json"), JSON.stringify({ token: "t" }), "utf8")
      await writeFile(
        join(home, ".claude/projects/proj-x/session-a.jsonl"),
        `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "x" }] } })}\n`,
        "utf8",
      )
      await writeFile(join(home, ".claude/skills/q.md"), "skill body", "utf8")

      const fn = createCliImportHandlerWithRoot(sessionsDir)
      let outBuf = ""
      let errBuf = ""
      const deps: SessionCommandDeps = {
        out: (s) => {
          outBuf += s
        },
        err: (s) => {
          errBuf += s
        },
        confirm: async () => false,
        homeDir: home,
      }
      const rc = await fn(["claude_code"], deps)
      expect(rc).toBe(0)
      expect(outBuf).toContain("imported claude_code")
      expect(outBuf).toContain("1 session(s) persisted")
      expect(outBuf).toContain("1 skill file(s)")
      expect(errBuf).toBe("")
      // The session file actually landed under the injected root.
      expect(readdirSync(sessionsDir).some((f) => f.endsWith(".json"))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  test("HELL-15: --no-skills flag is accepted (no `unexpected argument` error)", async () => {
    __resetRuntimeConfig()
    const home = mkdtempSync(join(tmpdir(), "cli-05-noskills-"))
    try {
      // Empty home: detector finds nothing, but the FLAG itself must parse.
      const fn = createCliImportHandler()
      let outBuf = ""
      let errBuf = ""
      const deps: SessionCommandDeps = {
        out: (s) => {
          outBuf += s
        },
        err: (s) => {
          errBuf += s
        },
        confirm: async () => false,
        homeDir: home,
      }
      const rc = await fn(["claude_code", "--no-skills"], deps)
      // No `unexpected argument` error — that's the key assertion here.
      expect(errBuf).not.toContain("unexpected argument")
      // Exit code can be 0 or 1 depending on detector behavior with an
      // empty home; what matters is the flag is consumed by the parser.
      expect([0, 1]).toContain(rc)
      expect(outBuf + errBuf).not.toContain("--no-skills")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// =============================================================================
// FUNCTIONAL — resolveCliSessionListEnv
// =============================================================================

describe("CLI-05: functional — resolveCliSessionListEnv()", () => {
  // The resolver reads runtimeConfig (which snapshots process.env on first
  // call) + process.stdout.isTTY. Tests patch BOTH at the boundaries so the
  // function is exercised end-to-end without restructuring the under-test.

  const withEnv = async <T>(
    patch: Record<string, string | undefined>,
    fn: () => T | Promise<T>,
  ): Promise<T> => {
    const snapshot = { ...process.env }
    try {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      __resetRuntimeConfig()
      return await fn()
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in snapshot)) delete process.env[k]
      }
      Object.assign(process.env, snapshot)
      __resetRuntimeConfig()
    }
  }

  const withTty = async <T>(isTTY: boolean, fn: () => T | Promise<T>): Promise<T> => {
    const prior = process.stdout.isTTY
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true })
      return await fn()
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: prior, configurable: true })
    }
  }

  test("HELL-16: returns { defaultFormat: 'rich' } when stdout is TTY and no env override", async () => {
    await withEnv(
      { QUANTA_SESSION_LIST_FORMAT: undefined, QUANTA_SESSION_LIST_MAX: undefined },
      async () => {
        await withTty(true, () => {
          const got = resolveCliSessionListEnv()
          expect(got).toEqual({ defaultFormat: "rich" })
        })
      },
    )
  })

  test("HELL-17: returns { defaultFormat: 'plain' } when stdout is not a TTY (pipeline/test)", async () => {
    await withEnv(
      { QUANTA_SESSION_LIST_FORMAT: undefined, QUANTA_SESSION_LIST_MAX: undefined },
      async () => {
        await withTty(false, () => {
          const got = resolveCliSessionListEnv()
          expect(got).toEqual({ defaultFormat: "plain" })
        })
      },
    )
  })

  test("HELL-18: env override QUANTA_SESSION_LIST_FORMAT=plain wins over TTY=true (power-user pin)", async () => {
    await withEnv({ QUANTA_SESSION_LIST_FORMAT: "plain" }, async () => {
      await withTty(true, () => {
        const got = resolveCliSessionListEnv()
        expect(got).toEqual({ defaultFormat: "plain" })
      })
    })
  })

  test("HELL-19: env override QUANTA_SESSION_LIST_FORMAT=rich wins over TTY=false", async () => {
    await withEnv({ QUANTA_SESSION_LIST_FORMAT: "rich" }, async () => {
      await withTty(false, () => {
        const got = resolveCliSessionListEnv()
        expect(got).toEqual({ defaultFormat: "rich" })
      })
    })
  })

  test("HELL-20: QUANTA_SESSION_LIST_MAX is propagated into defaultMaxN when set", async () => {
    await withEnv(
      { QUANTA_SESSION_LIST_FORMAT: undefined, QUANTA_SESSION_LIST_MAX: "25" },
      async () => {
        await withTty(true, () => {
          const got = resolveCliSessionListEnv()
          expect(got).toEqual({ defaultFormat: "rich", defaultMaxN: 25 })
        })
      },
    )
  })

  test("HELL-21: omits defaultMaxN entirely when QUANTA_SESSION_LIST_MAX is absent (exactOptionalPropertyTypes contract)", async () => {
    await withEnv(
      { QUANTA_SESSION_LIST_FORMAT: undefined, QUANTA_SESSION_LIST_MAX: undefined },
      async () => {
        await withTty(false, () => {
          const got = resolveCliSessionListEnv()
          // Strict key set — no `defaultMaxN: undefined` leakage.
          expect(got).not.toBeUndefined()
          expect(Object.keys(got ?? {}).sort()).toEqual(["defaultFormat"])
        })
      },
    )
  })

  test("HELL-22: runtimeConfig is the single source of truth — direct process.env writes after first read are ignored (snapshot contract)", async () => {
    // Documents the existing snapshot semantics: resolveCliSessionListEnv
    // reads `runtimeConfig()` which caches its first parse. The test pins
    // that behavior so we notice if anyone changes it.
    await withEnv({ QUANTA_SESSION_LIST_FORMAT: "rich" }, async () => {
      await withTty(false, () => {
        // First call snapshots env.
        const first = resolveCliSessionListEnv()
        expect(first).toEqual({ defaultFormat: "rich" })
        // Mutate env AFTER snapshot — should not affect subsequent calls
        // because runtimeConfig caches.
        process.env.QUANTA_SESSION_LIST_FORMAT = "plain"
        const second = resolveCliSessionListEnv()
        expect(second).toEqual({ defaultFormat: "rich" })
      })
    })
  })
})
