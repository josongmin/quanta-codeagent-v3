import { describe, expect, test } from "bun:test"
import { reproRunArgv } from "./dataset"
import { buildProjectEnvUvRunArgv } from "./project-env"

// jun-29 ENV-ERA PIN (RCA): sphinx-8595 (created 2020) freely resolved jinja2>=3.1
// which dropped `environmentfilter` ⇒ `import sphinx` died ⇒ every repro a spurious
// exec_failed (an env bug, not a repro-gen signal — it confounded the grounding A/B).
// Fix: thread the instance `created_at` as uv `--exclude-newer` so deps resolve to
// the instance's era. These tests pin that the flag is present/absent correctly and
// OFF is byte-identical.

const DATE = "2020-12-27T03:07:50Z"

describe("buildProjectEnvUvRunArgv — --exclude-newer era pin", () => {
  test("createdAt ⇒ `--exclude-newer <date>` after `uv run --no-project`, before `--python`", () => {
    const argv = buildProjectEnvUvRunArgv("sphinx-doc/sphinx", "3.5", ["pytest"], {}, DATE)
    const i = argv.indexOf("--exclude-newer")
    expect(i).toBeGreaterThan(-1)
    expect(argv[i + 1]).toBe(DATE)
    // positioned between `--no-project` and `--python`
    expect(argv.indexOf("--no-project")).toBeLessThan(i)
    expect(i).toBeLessThan(argv.indexOf("--python"))
    // still installs the local repo (the cutoff does NOT pin --with-editable .)
    expect(argv).toContain("--with-editable")
  })

  test("absent createdAt ⇒ NO flag (byte-identical to the pre-fix argv)", () => {
    const withDate = buildProjectEnvUvRunArgv("sphinx-doc/sphinx", "3.5", ["pytest"], {})
    expect(withDate).not.toContain("--exclude-newer")
    // exactly the legacy shape: uv run --no-project --python ...
    const u = withDate.indexOf("uv")
    expect(withDate.slice(u, u + 4)).toEqual(["uv", "run", "--no-project", "--python"])
  })

  test("empty-string createdAt ⇒ no flag (guarded)", () => {
    expect(buildProjectEnvUvRunArgv("x/y", "1", [], {}, "")).not.toContain("--exclude-newer")
  })
})

describe("reproRunArgv threads createdAt", () => {
  test("with createdAt ⇒ repro exec env is era-pinned", () => {
    const argv = reproRunArgv("sphinx-doc/sphinx", "3.5", "/tmp/repro.py", DATE)
    const i = argv.indexOf("--exclude-newer")
    expect(i).toBeGreaterThan(-1)
    expect(argv[i + 1]).toBe(DATE)
    // still ends with the script under `python -s`
    expect(argv.slice(-3)).toEqual(["python", "-s", "/tmp/repro.py"])
  })

  test("without createdAt ⇒ byte-identical legacy repro argv", () => {
    expect(reproRunArgv("sphinx-doc/sphinx", "3.5", "/tmp/repro.py")).not.toContain(
      "--exclude-newer",
    )
  })
})
