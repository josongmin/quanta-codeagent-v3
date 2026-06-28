import { describe, expect, test } from "bun:test"
import { reproRunArgv } from "./dataset"
import { buildProjectEnvUvRunArgv, specEraPins } from "./project-env"
import { specPipPackages } from "./repo-version-specs"

// jun-29 SOTA++ ENV FIX (RCA): the repro/test env free-resolved deps to LATEST, so
// old sphinx 3.x got jinja2>=3.1 (dropped `environmentfilter`) AND sphinxcontrib 2.x
// (raises VersionRequirementError in `Sphinx()`) ⇒ every repro a spurious
// exec_failed (an env bug that confounded the grounding A/B). Fix: apply the
// OFFICIAL era pins — `pip_packages` (Jinja2==3.0.3) MERGED with the pre_install
// dep-caps (sphinxcontrib-*<=…, markupsafe<=2.0.1, alabaster<0.7.12) — as uv
// `--with`. Skipped when the python was floored off-era (era pins unbuildable).

describe("specEraPins — official pip_packages + pre_install dep-caps (SOTA++)", () => {
  test("sphinx 3.5 ⇒ Jinja2==3.0.3 + the sphinxcontrib/markupsafe/alabaster caps", () => {
    const pins = specEraPins("sphinx-doc/sphinx", "3.5")
    expect(pins).toContain("Jinja2==3.0.3") // pip_packages
    expect(pins).toContain("sphinxcontrib-applehelp<=1.0.7") // pre_install cap (the GAP fix)
    expect(pins).toContain("markupsafe<=2.0.1")
    expect(pins).toContain("alabaster>=0.7,<0.7.12")
  })

  test("jinja2 dedup — the pip_packages ==3.0.3 WINS over the pre_install Jinja2<3.0", () => {
    const pins = specEraPins("sphinx-doc/sphinx", "3.5")
    expect(pins).toContain("Jinja2==3.0.3")
    expect(pins).not.toContain("Jinja2<3.0") // would CONFLICT with ==3.0.3
  })

  test("FLOORED python ⇒ [] (era pins unbuildable; free-resolve instead, no regression)", () => {
    // astropy 1.3 + scikit-learn 0.20 are floored (truth py3.6 → UV_FLOOR 3.9);
    // their numpy==1.16/scipy==1.5 era pins have no cp39 wheel ⇒ source-build fails.
    expect(specEraPins("astropy/astropy", "1.3")).toEqual([])
    expect(specEraPins("scikit-learn/scikit-learn", "0.20")).toEqual([])
    // sanity: those repos DO have pip_packages (so the [] is the floor gate, not absence)
    expect(specPipPackages("astropy/astropy", "1.3").length).toBeGreaterThan(0)
  })

  test("unknown repo/version ⇒ [] (byte-identical, no pins)", () => {
    expect(specEraPins("nonexistent/repo", "9.9")).toEqual([])
  })
})

describe("buildProjectEnvUvRunArgv — era pins folded into --with", () => {
  test("sphinx 3.5 argv carries the era pins as --with entries", () => {
    const argv = buildProjectEnvUvRunArgv("sphinx-doc/sphinx", "3.5", ["pytest"], {})
    for (const pin of ["Jinja2==3.0.3", "sphinxcontrib-applehelp<=1.0.7", "markupsafe<=2.0.1"]) {
      const i = argv.indexOf(pin)
      expect(i).toBeGreaterThan(-1)
      expect(argv[i - 1]).toBe("--with")
    }
  })

  test("floored repo ⇒ no era pins in the argv (free-resolve)", () => {
    const argv = buildProjectEnvUvRunArgv("astropy/astropy", "1.3", ["pytest"], {})
    expect(argv).not.toContain("numpy==1.16.0")
    expect(argv).toContain("--with-editable") // still installs the repo
  })

  test("reproRunArgv inherits the era pins (sphinx repro env is era-correct)", () => {
    const argv = reproRunArgv("sphinx-doc/sphinx", "3.5", "/tmp/repro.py")
    expect(argv).toContain("Jinja2==3.0.3")
    expect(argv).toContain("sphinxcontrib-applehelp<=1.0.7")
    expect(argv.slice(-3)).toEqual(["python", "-s", "/tmp/repro.py"])
  })
})
