import { describe, expect, test } from "bun:test"
import { reproRunArgv } from "./dataset"
import { buildProjectEnvUvRunArgv } from "./project-env"
import { specPipPackages } from "./repo-version-specs"

// jun-29 SOTA++ ENV FIX (RCA): the repro/test env free-resolved deps to LATEST, so
// old sphinx-doc__sphinx-8595 (3.5) got jinja2>=3.1 which dropped `environmentfilter`
// ⇒ `import sphinx` died ⇒ every repro a spurious exec_failed (an env bug that
// confounded the grounding A/B). Fix: apply the OFFICIAL `pip_packages` PINS
// (Jinja2==3.0.3) as uv `--with` — the official mechanism, no setup.py edit / build
// break (the earlier --exclude-newer approach broke the editable build).

describe("buildProjectEnvUvRunArgv — official pip_packages pins (SOTA++)", () => {
  test("sphinx 3.5 ⇒ the official Jinja2==3.0.3 pin is applied as --with", () => {
    const argv = buildProjectEnvUvRunArgv("sphinx-doc/sphinx", "3.5", ["pytest"], {})
    const i = argv.indexOf("Jinja2==3.0.3")
    expect(i).toBeGreaterThan(-1)
    expect(argv[i - 1]).toBe("--with") // applied as a --with pin
  })

  test("the pin is the SAME official ground truth specPipPackages returns", () => {
    const pins = specPipPackages("sphinx-doc/sphinx", "3.5")
    expect(pins).toContain("Jinja2==3.0.3")
    const argv = buildProjectEnvUvRunArgv("sphinx-doc/sphinx", "3.5", ["pytest"], {})
    for (const pin of pins) expect(argv).toContain(pin)
  })

  test("a repo/version with NO pip_packages ⇒ byte-identical (no extra --with)", () => {
    // unknown repo ⇒ specPipPackages returns [] ⇒ the deps set is unchanged
    const argv = buildProjectEnvUvRunArgv("nonexistent/repo", "9.9", ["pytest"], {})
    expect(specPipPackages("nonexistent/repo", "9.9")).toEqual([])
    // only the base + extraWith deps appear (pytest, setuptools); no era pins
    expect(argv).toContain("--with-editable")
    expect(argv).toContain("uv")
  })

  test("reproRunArgv inherits the pins (sphinx repro env is era-correct)", () => {
    const argv = reproRunArgv("sphinx-doc/sphinx", "3.5", "/tmp/repro.py")
    expect(argv).toContain("Jinja2==3.0.3")
    expect(argv.slice(-3)).toEqual(["python", "-s", "/tmp/repro.py"])
  })
})

describe("buildProjectEnvUvRunArgv — excludeNewer param (inert capability)", () => {
  // The --exclude-newer param is retained (default-safe) but NOT wired by any call
  // site — it broke the editable build; the pip_packages mechanism supersedes it.
  test("absent excludeNewer ⇒ no --exclude-newer flag", () => {
    expect(buildProjectEnvUvRunArgv("x/y", "1", [], {})).not.toContain("--exclude-newer")
  })
  test("explicit excludeNewer ⇒ flag present (capability preserved)", () => {
    const argv = buildProjectEnvUvRunArgv("x/y", "1", [], {}, "2020-12-27T03:07:50Z")
    expect(argv).toContain("--exclude-newer")
  })
})
