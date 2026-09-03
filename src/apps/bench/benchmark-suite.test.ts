import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { nth, present } from "../../../tests/_helpers/expect-present"
import { assertScanPopulation } from "../../../tests/unit/_shared/scan-population"
import {
  BENCHMARK_SUITES,
  isBenchmarkSuite,
  resolveBenchmarkRunConfig,
  resolveSuiteFromSubcommand,
} from "./benchmark-suite"
import { buildSubprocessFamilyEnv, serializeFamilyForSubprocess } from "./run-config"

// BFND-01 — the ONE typed suite+config resolver at the bench composition root.
// It nests the T2 typed DatasetFamily under a benchmarkSuite discriminator:
//   swe-bench  ⇒ { benchmarkSuite, datasetFamily, swe }
//   terminal-bench ⇒ { benchmarkSuite, benchmarkVersion: "2.1", terminal }
// Resolution rules (FROZEN):
//   - no-subcommand / run / grade / pool ⇒ swe-bench.
//   - `--dataset-family` accepted ONLY inside the swe-bench branch; on terminal ⇒ THROW.
//   - a terminal identity carrying datasetFamily ⇒ refused.
//   - benchmarkSuite "promax" ⇒ refused (not a suite; it is a future SWE family).
//   - explicit unknown family/suite does NOT become verified/swe-bench.
//   - ABSENT family selector ⇒ verified (byte-identical legacy default).

describe("BENCHMARK_SUITES — registration floor (non-vacuous)", () => {
  test("both suites are registered (known floor ≥ 2)", () => {
    expect(BENCHMARK_SUITES.length).toBeGreaterThanOrEqual(2)
    expect(BENCHMARK_SUITES).toContain("swe-bench")
    expect(BENCHMARK_SUITES).toContain("terminal-bench")
  })
  test("isBenchmarkSuite resolves every registered suite AND refuses non-suites", () => {
    for (const s of BENCHMARK_SUITES) expect(isBenchmarkSuite(s)).toBe(true)
    expect(isBenchmarkSuite("promax")).toBe(false) // ProMax is a SWE family, NOT a suite
    expect(isBenchmarkSuite("bogus")).toBe(false)
    expect(isBenchmarkSuite("")).toBe(false)
  })
})

describe("resolveSuiteFromSubcommand — legacy subcommands select swe-bench", () => {
  test("no-subcommand / run / grade / pool / remote ⇒ swe-bench", () => {
    for (const sub of [undefined, "run", "grade", "pool", "remote"]) {
      expect(resolveSuiteFromSubcommand(sub)).toBe("swe-bench")
    }
  })
  test("terminal subcommand ⇒ terminal-bench", () => {
    expect(resolveSuiteFromSubcommand("terminal")).toBe("terminal-bench")
  })
  test("a legacy leading flag (e.g. --swebench) ⇒ swe-bench (byte-compat)", () => {
    expect(resolveSuiteFromSubcommand("--swebench")).toBe("swe-bench")
  })
})

describe("resolveBenchmarkRunConfig — swe-bench branch nests the typed DatasetFamily", () => {
  test("no subcommand + absent selector ⇒ swe-bench/verified (byte-identical default)", () => {
    const cfg = resolveBenchmarkRunConfig({ subcommand: undefined, argvFamily: undefined, env: {} })
    expect(cfg.benchmarkSuite).toBe("swe-bench")
    if (cfg.benchmarkSuite !== "swe-bench") throw new Error("narrow")
    expect(cfg.datasetFamily).toBe("verified")
    expect(cfg.swe.datasetFamily).toBe("verified")
  })

  test("all FOUR families flow through the swe branch (no vacuous single-literal)", () => {
    for (const fam of ["verified", "live", "pro", "promax"] as const) {
      const cfg = resolveBenchmarkRunConfig({ subcommand: "run", argvFamily: fam, env: {} })
      if (cfg.benchmarkSuite !== "swe-bench") throw new Error("narrow")
      expect(cfg.datasetFamily).toBe(fam)
      expect(cfg.swe.datasetFamily).toBe(fam)
    }
  })

  test("argv family wins over env within the swe branch", () => {
    const cfg = resolveBenchmarkRunConfig({
      subcommand: "grade",
      argvFamily: "pro",
      env: { QUANTA_SWEBENCH_DATASET_FAMILY: "live" },
    })
    if (cfg.benchmarkSuite !== "swe-bench") throw new Error("narrow")
    expect(cfg.datasetFamily).toBe("pro")
  })

  // FAIL-CLOSED: explicit-unknown must NOT silently become verified.
  test("explicit-invalid family ⇒ THROW (does NOT fall back to verified)", () => {
    expect(() =>
      resolveBenchmarkRunConfig({ subcommand: "run", argvFamily: "bogus", env: {} }),
    ).toThrow()
  })
  test("explicit-blank family ⇒ THROW", () => {
    expect(() =>
      resolveBenchmarkRunConfig({ subcommand: "run", argvFamily: "", env: {} }),
    ).toThrow()
  })
  test("absent family (no argv, no env) ⇒ verified, NOT a throw", () => {
    expect(() =>
      resolveBenchmarkRunConfig({ subcommand: "run", argvFamily: undefined, env: {} }),
    ).not.toThrow()
  })
})

describe("resolveBenchmarkRunConfig — terminal-bench branch", () => {
  test("terminal subcommand ⇒ terminal-bench/2.1 with NO datasetFamily key", () => {
    const cfg = resolveBenchmarkRunConfig({
      subcommand: "terminal",
      argvFamily: undefined,
      env: {},
    })
    expect(cfg.benchmarkSuite).toBe("terminal-bench")
    if (cfg.benchmarkSuite !== "terminal-bench") throw new Error("narrow")
    expect(cfg.benchmarkVersion).toBe("2.1")
    // The terminal member has no datasetFamily key by shape.
    expect("datasetFamily" in cfg).toBe(false)
  })

  // RED-rail A: --dataset-family on the terminal subcommand is a genuine refusal.
  test("--dataset-family on terminal subcommand ⇒ THROW (family is a SWE-only axis)", () => {
    expect(() =>
      resolveBenchmarkRunConfig({ subcommand: "terminal", argvFamily: "live", env: {} }),
    ).toThrow(/dataset-family/i)
  })
  test("QUANTA_SWEBENCH_DATASET_FAMILY in env on terminal subcommand ⇒ THROW", () => {
    expect(() =>
      resolveBenchmarkRunConfig({
        subcommand: "terminal",
        argvFamily: undefined,
        env: { QUANTA_SWEBENCH_DATASET_FAMILY: "pro" },
      }),
    ).toThrow(/dataset-family|family/i)
  })
})

describe("decodeBenchRunConfig — runtime identity decoder refuses malformed identities", () => {
  // RED-rail B: a hand-built terminal identity carrying datasetFamily → refused.
  test("terminal identity carrying datasetFamily ⇒ refused", async () => {
    const { decodeBenchRunConfig } = await import("./benchmark-suite")
    expect(() =>
      decodeBenchRunConfig({
        benchmarkSuite: "terminal-bench",
        benchmarkVersion: "2.1",
        datasetFamily: "pro",
        terminal: { datasetRef: "x" },
      }),
    ).toThrow()
  })
  // RED-rail C: benchmarkSuite "promax" is refused (not in BENCHMARK_SUITES).
  test('benchmarkSuite "promax" ⇒ refused (ProMax is a SWE family, not a suite)', async () => {
    const { decodeBenchRunConfig } = await import("./benchmark-suite")
    expect(() =>
      decodeBenchRunConfig({ benchmarkSuite: "promax", datasetFamily: "pro", swe: {} }),
    ).toThrow(/promax|suite/i)
  })
  test("unknown suite identity ⇒ refused", async () => {
    const { decodeBenchRunConfig } = await import("./benchmark-suite")
    expect(() => decodeBenchRunConfig({ benchmarkSuite: "bogus" })).toThrow()
  })
  test("a well-formed swe-bench identity round-trips", async () => {
    const { decodeBenchRunConfig } = await import("./benchmark-suite")
    const cfg = decodeBenchRunConfig({
      benchmarkSuite: "swe-bench",
      datasetFamily: "live",
      swe: { datasetFamily: "live" },
    })
    if (cfg.benchmarkSuite !== "swe-bench") throw new Error("narrow")
    expect(cfg.datasetFamily).toBe("live")
  })

  // ── aug-22 re-audit R5 — the decoder must MATCH its own doc block ─────────
  // The doc block above says "a swe identity missing/invalid `datasetFamily` ⇒
  // throw" and "NO inference from other fields". The implementation was LENIENT:
  // it passed a non-string `datasetFamily` through as `argvFamily: undefined` —
  // the ABSENT-selector spelling — so a corrupt or truncated identity decoded to
  // a clean `verified`. Code and contract may not disagree; the CONTRACT wins,
  // because a decoder has no operator who could have "omitted the flag": absent
  // IS malformed here, and defaulting is the mis-grading direction (a Pro report
  // that lost its family reads back as Verified).
  describe("R5 — a swe identity with a missing/invalid datasetFamily is REFUSED", () => {
    const MALFORMED: readonly { label: string; identity: Record<string, unknown> }[] = [
      { label: "key entirely absent", identity: { benchmarkSuite: "swe-bench" } },
      { label: "undefined", identity: { benchmarkSuite: "swe-bench", datasetFamily: undefined } },
      { label: "null", identity: { benchmarkSuite: "swe-bench", datasetFamily: null } },
      { label: "number", identity: { benchmarkSuite: "swe-bench", datasetFamily: 42 } },
      { label: "boolean", identity: { benchmarkSuite: "swe-bench", datasetFamily: true } },
      { label: "object", identity: { benchmarkSuite: "swe-bench", datasetFamily: {} } },
      { label: "array", identity: { benchmarkSuite: "swe-bench", datasetFamily: ["pro"] } },
      { label: "unknown token", identity: { benchmarkSuite: "swe-bench", datasetFamily: "prow" } },
      { label: "blank token", identity: { benchmarkSuite: "swe-bench", datasetFamily: "" } },
      { label: "whitespace token", identity: { benchmarkSuite: "swe-bench", datasetFamily: "  " } },
    ]

    test("every malformed family identity THROWS (never decodes to verified)", async () => {
      const { decodeBenchRunConfig } = await import("./benchmark-suite")
      const survivors: string[] = []
      for (const c of MALFORMED) {
        let threw = false
        try {
          const decoded = decodeBenchRunConfig(c.identity)
          survivors.push(`${c.label} decoded to ${JSON.stringify(decoded)}`)
        } catch {
          threw = true
        }
        expect(threw, `${c.label} did not throw`).toBe(true)
      }
      expect(
        survivors,
        `decodeBenchRunConfig silently defaulted a malformed identity:\n${survivors.join("\n")}`,
      ).toEqual([])
    })

    test("PAIRED CONTROL — the FULL family union still round-trips, canonicalized", async () => {
      const { decodeBenchRunConfig } = await import("./benchmark-suite")
      for (const fam of ["verified", "live", "pro", "promax"] as const) {
        const cfg = decodeBenchRunConfig({ benchmarkSuite: "swe-bench", datasetFamily: fam })
        if (cfg.benchmarkSuite !== "swe-bench") throw new Error("narrow")
        expect(cfg.datasetFamily).toBe(fam)
      }
      // Padded / mixed-case tokens go through the ONE normalization owner.
      const padded = decodeBenchRunConfig({ benchmarkSuite: "swe-bench", datasetFamily: "  PRO " })
      if (padded.benchmarkSuite !== "swe-bench") throw new Error("narrow")
      expect(padded.datasetFamily).toBe("pro")
    })

    test("the refusal NAMES the offending value (an operator can act on it)", async () => {
      const { decodeBenchRunConfig } = await import("./benchmark-suite")
      expect(() =>
        decodeBenchRunConfig({ benchmarkSuite: "swe-bench", datasetFamily: 42 }),
      ).toThrow(/datasetFamily/)
      expect(() =>
        decodeBenchRunConfig({ benchmarkSuite: "swe-bench", datasetFamily: "prow" }),
      ).toThrow(/prow/)
    })
  })
})

describe("in-process family env-AUTHORITY rail (typed config is the only authority)", () => {
  // aug-22 HIGH-2 — the PREVIOUS version of this rail was a single line-regex
  // (/QUANTA_SWEBENCH_DATASET_FAMILY\s*=[^=]/) over src/apps/bench/**. It could
  // not go red for the violation it was named after: `run-main.ts` wrote the key
  // through `serializeFamilyForSubprocess(family, process.env)` — no literal
  // `KEY=` anywhere on the line — and a computed key
  // (`const k = "QUANTA_…"; process.env[k] = "pro"`) slipped through too. Only
  // the one spelling nobody would actually write went red.
  //
  // The rail is now BEHAVIORAL first: the boundary serializer REFUSES the ambient
  // env object at RUNTIME, so the helper spelling cannot compile-and-run. The
  // literal and computed spellings are caught by the composition-root rail in
  // `family-authority.test.ts` (it runs the real `runMain` and asserts
  // `process.env` is unmutated). The source scan below is a SECONDARY
  // re-introduction guard that now matches all three live spellings.

  test("BEHAVIORAL: the boundary serializer REFUSES to write into ambient process.env", () => {
    // The sanctioned shape: a fresh per-call envelope.
    const envelope: Record<string, string | undefined> = { HOME: "/home/x" }
    serializeFamilyForSubprocess("pro", envelope)
    expect(envelope.QUANTA_SWEBENCH_DATASET_FAMILY).toBe("pro")

    // The forbidden shape — directly, and through an ALIAS (so the guard is an
    // identity check, not a syntax check).
    expect(() =>
      serializeFamilyForSubprocess("pro", process.env as Record<string, string | undefined>),
    ).toThrow(/REFUSES to write into the ambient env/i)
    const aliased = process.env as unknown as Record<string, string | undefined>
    expect(() => serializeFamilyForSubprocess("live", aliased)).toThrow(
      /REFUSES to write into the ambient env/i,
    )
    // …and it really did not write.
    expect(process.env.QUANTA_SWEBENCH_DATASET_FAMILY).toBeUndefined()
  })

  /**
   * REGRESSION (sep-03): the refusal must survive a `process.env` REPLACEMENT.
   *
   * The guard compared against a MODULE-LOAD capture (`const ambientEnv =
   * process.env`). Ten test files in this repo "restore" the environment with
   * `process.env = { ...saved }` — which swaps the BINDING, not the object.
   * After any of them runs, the capture points at a dead object, `env ===
   * ambientEnv` is false forever, and the rail silently stops refusing. Measured
   * with a paired control: it then WROTE `QUANTA_SWEBENCH_DATASET_FAMILY=pro`
   * into the live ambient env — the exact in-process authority channel this
   * module exists to abolish.
   *
   * Per-file ISOLATION is what hid it. Under `--isolate` every file gets a fresh
   * global, so the capture is never stale and this can never go red; it surfaced
   * only when the full corpus ran shared. `wireRuntimePorts` learned the same
   * lesson — see the call-time default in `context-binding/base.ts`.
   */
  test("REGRESSION: the refusal survives a process.env REPLACEMENT (binding swap)", () => {
    const original = process.env
    try {
      // Verbatim what those afterEach hooks do, calling it "restore".
      ;(process as { env: NodeJS.ProcessEnv }).env = { ...original }

      expect(() =>
        serializeFamilyForSubprocess("pro", process.env as Record<string, string | undefined>),
      ).toThrow(/REFUSES to write into the ambient env/i)
      // PAIRED CONTROL for the throw: a guard that merely stopped throwing would
      // still be caught here, because the silent write is the actual damage.
      expect(process.env.QUANTA_SWEBENCH_DATASET_FAMILY).toBeUndefined()
    } finally {
      // Restore the ORIGINAL object, never a copy: a copy would leave the very
      // stale-binding hazard this test names behind for every later test here.
      ;(process as { env: NodeJS.ProcessEnv }).env = original
    }
  })

  test("BEHAVIORAL: the sanctioned envelope builder copies, never mutates the parent", () => {
    const parent: NodeJS.ProcessEnv = { HOME: "/home/x" }
    const envelope = buildSubprocessFamilyEnv(
      { datasetFamily: "live", familySelector: "explicit" },
      parent,
    )
    expect(envelope.QUANTA_SWEBENCH_DATASET_FAMILY).toBe("live")
    expect(envelope.HOME).toBe("/home/x")
    // Parent untouched — the whole point: the wire is per-call, not ambient.
    expect(parent.QUANTA_SWEBENCH_DATASET_FAMILY).toBeUndefined()
    // Full union flows through, both directions.
    for (const fam of ["verified", "live", "pro", "promax"] as const) {
      expect(
        buildSubprocessFamilyEnv({ datasetFamily: fam, familySelector: "explicit" }, parent)
          .QUANTA_SWEBENCH_DATASET_FAMILY,
      ).toBe(fam)
      // re-audit R3 — the SAME family with an ABSENT selector emits no key at all.
      expect(
        buildSubprocessFamilyEnv({ datasetFamily: fam, familySelector: "absent" }, parent)
          .QUANTA_SWEBENCH_DATASET_FAMILY,
      ).toBeUndefined()
    }
    expect(parent.QUANTA_SWEBENCH_DATASET_FAMILY).toBeUndefined()
  })

  // ── secondary source-scan re-introduction guard ───────────────────────────
  const BENCH_DIR = join(import.meta.dir)
  const FAMILY_KEY = "QUANTA_SWEBENCH_DATASET_FAMILY"
  /** run-config.ts owns the boundary serializer (the ONE sanctioned write). */
  const ALLOWED = new Set(["run-config.ts"])
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const s = statSync(p)
      if (s.isDirectory()) {
        if (name === "node_modules") continue
        out.push(...walk(p))
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        out.push(p)
      }
    }
    return out
  }

  /** Detectors for the THREE realistic spellings of an in-process ambient write. */
  const DETECTORS: readonly { readonly id: string; readonly re: RegExp }[] = [
    // 1. the bare literal assignment
    { id: "literal-assign", re: new RegExp(`${FAMILY_KEY}\\s*=[^=]`) },
    // 2. a computed / aliased key written onto ambient env. Greedy `.+` so a
    //    NESTED-bracket key (`process.env[KEYS[0]] = …`) is caught too — the
    //    lazy form silently missed those. Only applied to files that mention the
    //    family key (see `scanOffenders`), which keeps the unrelated dotenv shim
    //    in run-args.ts (a legitimate `process.env[pair[0]] = …`) out of scope.
    { id: "computed-key-on-ambient-env", re: /process\.env\s*\[.+\]\s*=[^=]/ },
    // 3. the boundary serializer (or any alias of it) aimed at ambient env
    {
      id: "serializer-into-ambient-env",
      re: /serializeFamilyForSubprocess\s*\([^;]*process\.env\s*\)/,
    },
  ]

  const scanFileOffenders = (file: string): string[] => {
    const base = file.slice(BENCH_DIR.length + 1)
    if (ALLOWED.has(base)) return []
    const text = readFileSync(file, "utf8")
    // Detector 2 (computed key) is scoped to files that NAME the family key,
    // so unrelated ambient-env writers (the dotenv shim) are not flagged while
    // the realistic injection — which necessarily names the key to build it —
    // still is. A key assembled from fragments would evade this scan; that is
    // exactly why the BEHAVIORAL rails above, not this one, are primary.
    const offenders: string[] = []
    const namesFamilyKey = text.includes(FAMILY_KEY)
    for (const [i, line] of text.split("\n").entries()) {
      // Skip prose: comment-only lines describing the forbidden pattern.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
      for (const detector of matchingDetectors(line, namesFamilyKey)) {
        offenders.push(`${base}:${i + 1} [${detector.id}] ${line.trim()}`)
      }
    }
    return offenders
  }

  const matchingDetectors = (line: string, namesFamilyKey: boolean) =>
    DETECTORS.filter(
      (detector) =>
        (detector.id !== "computed-key-on-ambient-env" || namesFamilyKey) && detector.re.test(line),
    )

  const scanOffenders = (files: readonly string[] = walk(BENCH_DIR)): string[] => {
    const offenders: string[] = []
    for (const file of files) {
      offenders.push(...scanFileOffenders(file))
    }
    return offenders
  }

  test("detectors are non-vacuous — each matches its REALISTIC live spelling", () => {
    const byId = new Map(DETECTORS.map((d) => [d.id, d.re]))
    const literal = present(byId.get("literal-assign"), "literal")
    const computed = present(byId.get("computed-key-on-ambient-env"), "computed")
    const helper = present(byId.get("serializer-into-ambient-env"), "helper")

    // spelling 1 — the bare literal nobody would actually write
    expect(literal.test(`env.${FAMILY_KEY} = family`)).toBe(true)
    expect(literal.test(`process.env.${FAMILY_KEY} = "pro"`)).toBe(true)
    // spelling 2 — computed key (the audit's probe: rail used to stay GREEN)
    expect(computed.test(`process.env[k] = "pro"`)).toBe(true)
    expect(computed.test(`process.env[FAMILY_KEY] = resolved`)).toBe(true)
    // …including a NESTED-bracket computed key
    expect(computed.test(`process.env[FAMILY_KEYS[0]] = resolved`)).toBe(true)
    // spelling 3 — helper call (the ACTUAL violation the old rail could not see)
    expect(helper.test("serializeFamilyForSubprocess(runConfig.datasetFamily, process.env)")).toBe(
      true,
    )
    expect(helper.test("  serializeFamilyForSubprocess(family, process.env)")).toBe(true)

    // …and none of them fire on READS or on the sanctioned envelope shape.
    for (const re of [literal, computed, helper]) {
      expect(re.test(`if (env.${FAMILY_KEY} === "pro")`)).toBe(false)
      expect(re.test(`env.${FAMILY_KEY} ?? "verified"`)).toBe(false)
      expect(re.test(`const v = process.env[k]`)).toBe(false)
      expect(re.test("serializeFamilyForSubprocess(family, envelope)")).toBe(false)
    }
  })

  test("KNOWN-ITEM FLOOR: the walker + literal detector really see the sanctioned owner", () => {
    const files = walk(BENCH_DIR)
    assertScanPopulation(files, BENCH_DIR, {
      id: "src/apps/bench/benchmark-suite.test.ts#BENCH",
    })
    // Floor: the bench tree is large; a walker that silently returns ~nothing
    // would make the offender scan below vacuously green.
    expect(files.length).toBeGreaterThan(40)
    const owner = files.find((f) => f.endsWith("/run-config.ts"))
    expect(owner).toBeDefined()
    const ownerText = readFileSync(present(owner, "owner"), "utf8")
    // The one sanctioned write EXISTS and IS matched by the literal detector —
    // proof the detector fires on real file bytes, not only on synthetic strings.
    const literal = nth(DETECTORS, 0, "DETECTORS").re
    expect(ownerText.split("\n").some((l) => literal.test(l))).toBe(true)
    // …and it is excluded only because run-config.ts is the allowlisted owner.
    expect(ALLOWED.has("run-config.ts")).toBe(true)
  })

  test("no bench module outside the boundary serializer writes family authority into ambient env", () => {
    expect(scanOffenders()).toEqual([])
  })
})

describe("legacy dispatch compatibility", () => {
  test("run --swebench x.jsonl --dataset-family pro still routes to swe-bench/pro", () => {
    const cfg = resolveBenchmarkRunConfig({ subcommand: "run", argvFamily: "pro", env: {} })
    expect(cfg.benchmarkSuite).toBe("swe-bench")
    if (cfg.benchmarkSuite !== "swe-bench") throw new Error("narrow")
    expect(cfg.datasetFamily).toBe("pro")
  })
})
