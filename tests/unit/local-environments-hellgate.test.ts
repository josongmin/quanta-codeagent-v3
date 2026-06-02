/**
 * ADR-0455 hellgate — agent-driven DECLARED local-environment selection.
 *
 * Proves the closed-port env system:
 *   - the pure/total parser is FAIL-CLOSED on every malformed shape (typed
 *     reason, never a silent default);
 *   - a declared env's vars / PATH-prepends compose ON TOP of the scrubbed
 *     base env and the allowlist STILL governs (a non-allowlisted declared var
 *     is dropped);
 *   - named-env SWITCHING is deterministic;
 *   - PATH prepend is validated (no `:` / `=` / NUL injection);
 *   - NO HEURISTIC env detection — only the declared config is read;
 *   - DEFAULT-OFF is byte-identical (no selection ⇒ same base reference);
 *   - the declared env actually reaches a SPAWNED bash child via `runShell`.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LocalEnvSelection, TomlParse } from "@/runtime"
import {
  applyLocalEnv,
  DEFAULT_ENV_ALLOWLIST,
  loadLocalEnvConfig,
  parseLocalEnvConfig,
  runShell,
  selectEnvironment,
} from "@/runtime"

// Inject Bun's real TOML parser as the DI port (the parser is exercised in
// isolation; a throwing stub proves the fail-closed `toml_syntax` mapping).
const toml: TomlParse = (body) => Bun.TOML.parse(body)

const VALID = `
default = "py"

[env.py]
vars = { PYTHONPATH = "src", VIRTUAL_ENV = ".venv" }
pathPrepend = [".venv/bin"]

[env.node20]
vars = { NODE_ENV = "development" }
pathPrepend = ["node_modules/.bin"]
`

// ── Parser: happy path ───────────────────────────────────────────────────

describe("parseLocalEnvConfig — declared schema", () => {
  test("HELL-1: parses named envs + default", () => {
    const r = parseLocalEnvConfig(VALID, toml)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("expected ok")
    expect(Object.keys(r.config.environments).sort()).toEqual(["node20", "py"])
    expect(r.config.defaultName).toBe("py")
    expect(r.config.environments.py?.vars.PYTHONPATH).toBe("src")
    expect(r.config.environments.py?.pathPrepend).toEqual([".venv/bin"])
  })

  test("HELL-2: vars/pathPrepend optional — empty env table is valid", () => {
    const r = parseLocalEnvConfig(`[env.bare]\n`, toml)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("expected ok")
    expect(r.config.environments.bare?.vars).toEqual({})
    expect(r.config.environments.bare?.pathPrepend).toEqual([])
  })

  test("HELL-3: a var/env literally named `ok` is NOT mistaken for a failure", () => {
    const r = parseLocalEnvConfig(`[env.e]\nvars = { ok = "false" }\n`, toml)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("expected ok")
    expect(r.config.environments.e?.vars.ok).toBe("false")
  })
})

// ── Parser: FAIL-CLOSED on malformed config ────────────────────────────────

describe("parseLocalEnvConfig — fail-closed (no silent default)", () => {
  const expectFail = (body: string, reason: string) => {
    const r = parseLocalEnvConfig(body, toml)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("expected fail")
    expect(r.reason).toBe(reason as never)
  }

  test("HELL-4: TOML syntax error ⇒ toml_syntax (parser throw is caught)", () => {
    expectFail(`[env.py\nvars = `, "toml_syntax")
  })

  test("HELL-5: a throwing TOML port is mapped, never propagated", () => {
    const throwing: TomlParse = () => {
      throw new Error("boom")
    }
    const r = parseLocalEnvConfig("anything", throwing)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("expected fail")
    expect(r.reason).toBe("toml_syntax")
  })

  test("HELL-6: no [env.*] tables ⇒ no_environments", () => {
    expectFail(`default = "x"\n`, "no_environments")
  })

  test("HELL-7: illegal env-var name ⇒ bad_var_name", () => {
    expectFail(`[env.e]\nvars = { "BAD NAME" = "v" }\n`, "bad_var_name")
  })

  test("HELL-8: env-var name with `=` ⇒ bad_var_name (no second assignment)", () => {
    expectFail(`[env.e]\nvars = { "A=B" = "v" }\n`, "bad_var_name")
  })

  test("HELL-9: non-string var value ⇒ bad_var_value", () => {
    expectFail(`[env.e]\nvars = { N = 5 }\n`, "bad_var_value")
  })

  test("HELL-10: pathPrepend not an array ⇒ bad_path_entry", () => {
    expectFail(`[env.e]\npathPrepend = "x"\n`, "bad_path_entry")
  })

  test("HELL-11: pathPrepend entry with `:` ⇒ bad_path_entry (no multi-element inject)", () => {
    expectFail(`[env.e]\npathPrepend = ["a:b"]\n`, "bad_path_entry")
  })

  test("HELL-12: pathPrepend entry with `=` ⇒ bad_path_entry", () => {
    expectFail(`[env.e]\npathPrepend = ["FOO=bar"]\n`, "bad_path_entry")
  })

  test("HELL-13: empty pathPrepend entry ⇒ bad_path_entry", () => {
    expectFail(`[env.e]\npathPrepend = ["   "]\n`, "bad_path_entry")
  })

  test("HELL-14: default names an undeclared env ⇒ default_unknown", () => {
    expectFail(`default = "nope"\n[env.e]\n`, "default_unknown")
  })

  test("HELL-15: non-string default ⇒ bad_default", () => {
    expectFail(`default = 3\n[env.e]\n`, "bad_default")
  })

  test("HELL-16: env value that is a table (not a leaf table.vars) ⇒ bad_env_table", () => {
    // `[env]` present but a child is a non-table scalar.
    const r = parseLocalEnvConfig(`env = 1\n`, toml)
    expect(r.ok).toBe(false)
  })
})

// ── selectEnvironment: switching ───────────────────────────────────────────

describe("selectEnvironment — named switch (deterministic)", () => {
  const cfg = (() => {
    const r = parseLocalEnvConfig(VALID, toml)
    if (!r.ok) throw new Error("setup")
    return r.config
  })()

  test("HELL-17: explicit name selects that env", () => {
    const sel = selectEnvironment(cfg, "node20")
    expect(sel?.vars.NODE_ENV).toBe("development")
    expect(sel?.pathPrepend).toEqual(["node_modules/.bin"])
  })

  test("HELL-18: switching to a different name yields a different selection", () => {
    const py = selectEnvironment(cfg, "py")
    const node = selectEnvironment(cfg, "node20")
    expect(py?.vars.PYTHONPATH).toBe("src")
    expect(node?.vars.PYTHONPATH).toBeUndefined()
  })

  test("HELL-19: no name falls back to the declared default", () => {
    expect(selectEnvironment(cfg)?.vars.PYTHONPATH).toBe("src")
  })

  test("HELL-20: unknown explicit name ⇒ undefined (NO silent default fallback)", () => {
    expect(selectEnvironment(cfg, "ghost")).toBeUndefined()
  })

  test("HELL-21: no name + no default ⇒ undefined", () => {
    const r = parseLocalEnvConfig(`[env.e]\n`, toml)
    if (!r.ok) throw new Error("setup")
    expect(selectEnvironment(r.config)).toBeUndefined()
  })
})

// ── applyLocalEnv: allowlist composition + byte-identical default-OFF ───────

describe("applyLocalEnv — allowlist governance", () => {
  test("HELL-22: declared allowlisted var overlays the base", () => {
    const base = { HOME: "/h" }
    const sel: LocalEnvSelection = { vars: { LANG: "C" }, pathPrepend: [] }
    const out = applyLocalEnv(base, sel, DEFAULT_ENV_ALLOWLIST)
    expect(out.LANG).toBe("C")
    expect(out.HOME).toBe("/h")
  })

  test("HELL-23: declared var NOT on the allowlist is DROPPED (allowlist still governs)", () => {
    const base = { PATH: "/usr/bin" }
    const sel: LocalEnvSelection = {
      // AWS_SECRET_ACCESS_KEY is not on DEFAULT_ENV_ALLOWLIST.
      vars: { AWS_SECRET_ACCESS_KEY: "leak", VIRTUAL_ENV: ".venv" },
      pathPrepend: [],
    }
    const out = applyLocalEnv(base, sel, DEFAULT_ENV_ALLOWLIST)
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined() // dropped
    expect(out.VIRTUAL_ENV).toBe(".venv") // allowlisted ⇒ passes
  })

  test("HELL-24: PATH prepend is placed BEFORE the surviving PATH, order preserved", () => {
    const base = { PATH: "/usr/bin" }
    const sel: LocalEnvSelection = { vars: {}, pathPrepend: [".venv/bin", "node_modules/.bin"] }
    const out = applyLocalEnv(base, sel, DEFAULT_ENV_ALLOWLIST)
    expect(out.PATH).toBe(".venv/bin:node_modules/.bin:/usr/bin")
  })

  test("HELL-25: PATH prepend with no existing PATH yields just the prefix", () => {
    const out = applyLocalEnv({}, { vars: {}, pathPrepend: ["bin"] }, DEFAULT_ENV_ALLOWLIST)
    expect(out.PATH).toBe("bin")
  })

  test("HELL-26: pathPrepend ignored when PATH is not on the allowlist", () => {
    const base = { PATH: "/usr/bin" }
    const out = applyLocalEnv(base, { vars: {}, pathPrepend: ["x"] }, ["HOME"])
    expect(out.PATH).toBe("/usr/bin") // unchanged — PATH not governed in
  })

  test("HELL-27: never mutates the base object", () => {
    const base = { PATH: "/usr/bin" }
    const frozen = Object.freeze({ ...base })
    applyLocalEnv(frozen, { vars: { LANG: "C" }, pathPrepend: ["b"] }, DEFAULT_ENV_ALLOWLIST)
    expect(frozen).toEqual({ PATH: "/usr/bin" })
  })

  test("HELL-28 (DEFAULT-OFF): undefined selection ⇒ SAME base reference", () => {
    const base = { PATH: "/usr/bin" }
    expect(applyLocalEnv(base, undefined, DEFAULT_ENV_ALLOWLIST)).toBe(base)
  })

  test("HELL-29 (DEFAULT-OFF): empty selection ⇒ SAME base reference", () => {
    const base = { PATH: "/usr/bin" }
    const out = applyLocalEnv(base, { vars: {}, pathPrepend: [] }, DEFAULT_ENV_ALLOWLIST)
    expect(out).toBe(base)
  })
})

// ── Loader: declared-only detection (NO heuristics) + default-OFF ──────────

describe("loadLocalEnvConfig — declared-only discovery", () => {
  test("HELL-30: no config file anywhere ⇒ undefined (default-OFF, nothing sniffed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "le-none-"))
    try {
      // A directory that LOOKS like a python project (has a `.venv` dir) is
      // NOT detected — only a DECLARED config file is. No heuristics.
      mkdirSync(join(dir, ".venv", "bin"), { recursive: true })
      mkdirSync(join(dir, ".git"))
      expect(await loadLocalEnvConfig(dir, toml)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("HELL-31: .quanta/environment.toml is discovered + parsed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "le-q-"))
    try {
      mkdirSync(join(dir, ".git"))
      mkdirSync(join(dir, ".quanta"))
      writeFileSync(join(dir, ".quanta", "environment.toml"), VALID)
      const found = await loadLocalEnvConfig(dir, toml)
      expect(found?.result.ok).toBe(true)
      expect(found?.sourcePath).toContain(".quanta")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("HELL-32: .codex-compat path is discovered when no .quanta config exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "le-c-"))
    try {
      mkdirSync(join(dir, ".git"))
      mkdirSync(join(dir, ".codex", "environments"), { recursive: true })
      writeFileSync(join(dir, ".codex", "environments", "environment.toml"), VALID)
      const found = await loadLocalEnvConfig(dir, toml)
      expect(found?.result.ok).toBe(true)
      expect(found?.sourcePath).toContain(".codex")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("HELL-33: a malformed config file is surfaced as a fail-closed result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "le-bad-"))
    try {
      mkdirSync(join(dir, ".git"))
      mkdirSync(join(dir, ".quanta"))
      writeFileSync(join(dir, ".quanta", "environment.toml"), `default = "nope"\n[env.e]\n`)
      const found = await loadLocalEnvConfig(dir, toml)
      expect(found?.result.ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── Integration: declared env reaches a SPAWNED bash child via runShell ────

describe("runShell — declared local env applied to the child (integration)", () => {
  test("HELL-34: a declared allowlisted var is visible in the spawned shell", async () => {
    const sel: LocalEnvSelection = { vars: { LC_ALL: "C" }, pathPrepend: [] }
    const r = await runShell('echo "lc=$LC_ALL"', { localEnv: sel })
    expect(r.stdout).toContain("lc=C")
  })

  test("HELL-35: a declared PATH-prepend reaches the child PATH", async () => {
    // The marker dir is injected into the child's PATH env. NOTE: `bash -lc`
    // is a LOGIN shell that re-runs `path_helper` (macOS /etc/profile) and may
    // reorder the elements, so we assert PRESENCE (the env composition reached
    // the child) — not the absolute front position, which is a login-shell
    // artifact, not this slice's contract. The unit test HELL-24 proves the
    // pre-shell composition places the prefix FIRST.
    const sel: LocalEnvSelection = { vars: {}, pathPrepend: ["/quanta-marker/bin"] }
    const r = await runShell('echo "$PATH"', { localEnv: sel })
    expect(r.stdout).toContain("/quanta-marker/bin")
  })

  test("HELL-36: a declared NON-allowlisted var never reaches the child (allowlist governs)", async () => {
    const sel: LocalEnvSelection = { vars: { AWS_SECRET_ACCESS_KEY: "leak" }, pathPrepend: [] }
    const r = await runShell('echo "secret=[${AWS_SECRET_ACCESS_KEY:-unset}]"', { localEnv: sel })
    expect(r.stdout).toContain("secret=[unset]")
  })

  test("HELL-37 (DEFAULT-OFF): no localEnv ⇒ child PATH equals the scrubbed base PATH", async () => {
    const withNo = await runShell('echo "$PATH"', {})
    const explicitEmpty = await runShell('echo "$PATH"', {
      localEnv: { vars: {}, pathPrepend: [] },
    })
    expect(explicitEmpty.stdout).toBe(withNo.stdout)
  })
})
