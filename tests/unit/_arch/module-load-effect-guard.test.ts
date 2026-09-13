/**
 * ★ ARCH GUARD — no ordinary test file may perform an EXTERNAL EFFECT at module
 * load (TVH-11).
 *
 * ## The defect this closes
 *
 * Discovering the suite was not free. Importing one ordinary test file spawned
 * Chrome and bound a `Bun.serve` port; another walked four Python interpreters
 * serially at 5,000ms each; another ran `git init` into a temp tree; another
 * started a nested `bun test`. None of it was declared, several had no timeout,
 * and one carried a comment claiming an env gate that did not exist.
 *
 * ## Why the guard is STRUCTURAL and not a grep
 *
 * The distinguishing fact is POSITIONAL. `Bun.spawn(...)` inside `test()` or
 * `beforeAll()` is where it belongs; the identical text at module top level is
 * the defect. A regex sees the same characters in both. So the detector walks
 * the TypeScript AST and tracks module-evaluation reachability, including three
 * traps a naive "am I inside a function" walk gets wrong — `describe` callbacks
 * (eager under bun:test), a top-level `const X = probe()` whose spawn is one hop
 * inside a local helper, and IIFEs. Every one of those shapes is a PAIRED
 * CONTROL below: the same call, moved, must flip the verdict.
 *
 * ## Anti-vacuum floors
 *
 * A corpus guard that silently stops seeing files passes forever. This asserts
 * the corpus size, that zero files failed to parse, that the named real files
 * are actually in it, and — the part a floor alone cannot give — that the
 * detector still FIRES on a real top-level spawn written to disk inside the
 * scanned tree (red-on-injection).
 */

import { beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  capabilityCallProblems,
  capabilityCalls,
  capabilityCallsites,
  scanCapabilityCallsites,
} from "../../../tools/dev/capability-callsites"
import { campaignCapabilityIds } from "../../../tools/dev/capability-probe-producer"
import {
  CAPABILITY_VERDICTS,
  type CapabilityVerdict,
} from "../../../tools/dev/capability-receipt-consumer"
import {
  enforceModuleLoadEffects,
  expandAllowlist,
  type GuardResult,
  type ModuleLoadAllowlistFile,
  parseAllowlist,
  readCorpusInputs,
  readCorpusInputsUnder,
  testCorpusFiles,
  validateAllowEntry,
} from "../../../tools/dev/module-load-effect-guard"
import {
  detectModuleLoadEffects,
  MODULE_LOAD_EFFECT_KINDS,
  type ModuleLoadEffect,
  type ModuleLoadEffectKind,
  scanModuleLoadEffects,
} from "../../../tools/dev/module-load-effects"
import { CAPABILITY_GROUPS } from "../../../tools/dev/test-capability-manifest"
import {
  type CapabilityOutcome,
  type CapabilityResult,
  reportCapability,
} from "../../_helpers/capability-lane"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const ALLOWLIST_PATH = join(REPO_ROOT, "tools", "dev", "module-load-effect-allowlist.json")

/**
 * The fourteen files TVH-11 made inert. Used three ways below — as a corpus
 * membership assertion, as a regression lock, and as an honesty lock ("fixed"
 * must not mean "exempted") — so the list lives once.
 */
const TVH11_FIXED_FILES = [
  "tests/integration/browser-agent-loop-e2e.test.ts",
  "tests/integration/browser-real-chrome-e2e.test.ts",
  "tests/contract/lance-real-wire.test.ts",
  "tests/contract/lsp-typescript.test.ts",
  "tests/contract/lsp-pyright.test.ts",
  "tests/meta/preload-runtime-closure-hellgate.test.ts",
  "tests/unit/tool/glob-gitignore-mtime-hellgate.test.ts",
  "tests/unit/tool/debug/debugpy-real-e2e.test.ts",
  "tests/unit/sphinx-ra-shim.test.ts",
  "tests/unit/ast-grep-bugs-hellgate.test.ts",
  "tests/unit/ast-grep-scenarios.test.ts",
  "tests/unit/ast-grep-e2e-hellgate.test.ts",
  "tests/unit/project-env-snapshot-wiring-hellgate.test.ts",
  "tests/unit/cha-multisite-hellgate.test.ts",
] as const

const kindsOf = (effects: readonly ModuleLoadEffect[]): readonly ModuleLoadEffectKind[] =>
  effects.map((e) => e.kind)

const scan = (text: string, path = "tests/unit/fixture.test.ts"): readonly ModuleLoadEffect[] =>
  detectModuleLoadEffects({ path, text })

// ════════════════════════════════════════════════════════════════════════════
// SCOPE DISCRIMINATION — the property a grep cannot have
// ════════════════════════════════════════════════════════════════════════════

describe("module-load effect detector — position decides, not text", () => {
  const SPAWN = `Bun.spawn(["git", "status"])`

  test("PAIRED CONTROL: a spawn at module top level is an effect", () => {
    expect(kindsOf(scan(`import { test } from "bun:test"\n${SPAWN}\n`))).toEqual(["spawn"])
  })

  test("PAIRED CONTROL: the SAME spawn inside a test() body is not", () => {
    // Red-on-injection: delete the DEFERRED_CALLBACK_HEADS branch in the walker
    // and this flips to one finding — the guard would then condemn every
    // legitimate spawn in the corpus and be turned off within a day.
    expect(scan(`import { test } from "bun:test"\ntest("t", () => { ${SPAWN} })\n`)).toEqual([])
  })

  test("PAIRED CONTROL: the SAME spawn inside beforeAll()/afterAll() is not", () => {
    expect(scan(`import { beforeAll } from "bun:test"\nbeforeAll(() => { ${SPAWN} })\n`)).toEqual(
      [],
    )
    expect(
      scan(`import { afterAll } from "bun:test"\nafterAll(async () => { ${SPAWN} })\n`),
    ).toEqual([])
  })

  test("🔴 a spawn in a describe() BODY is an effect — bun:test collects eagerly", () => {
    // The trap that hid the nested `bun test` in the preload hellgate for good:
    // `describe("x", () => { const loaded = probe() })` looks deferred and runs
    // at import. Red-on-injection: move `describe` into the deferred set and
    // this returns [].
    expect(
      kindsOf(scan(`import { describe } from "bun:test"\ndescribe("d", () => { ${SPAWN} })\n`)),
    ).toEqual(["spawn"])
  })

  test("🔴 a top-level call into a LOCAL helper that spawns is an effect, with the chain", () => {
    // Every real defect in this repo had this shape: `const PROBE = await
    // spawnProbe()`, `const LLDB = lldbDapPath()`, `const python = await
    // resolvePython()`. The text at top level is innocent.
    const effects = scan(
      [
        `import { test } from "bun:test"`,
        `const probeChrome = () => Bun.spawn(["chrome", "--version"])`,
        `const CHROME = probeChrome()`,
        ``,
      ].join("\n"),
    )
    expect(kindsOf(effects)).toEqual(["spawn"])
    expect(effects[0]?.callsite).toBe("probeChrome>Bun.spawn")
  })

  test("PAIRED CONTROL: the same helper DEFINED but never called is not an effect", () => {
    // The other half of the rule. A guard that flagged every helper containing a
    // spawn would be condemning definitions, which is not what costs anything.
    expect(
      scan(
        [
          `import { test } from "bun:test"`,
          `const probeChrome = () => Bun.spawn(["chrome", "--version"])`,
          `test("t", () => { probeChrome() })`,
          ``,
        ].join("\n"),
      ),
    ).toEqual([])
  })

  test("🔴 an IIFE at module scope is module scope", () => {
    const effects = scan(
      `import { test } from "bun:test"\nconst X = await (async () => { ${SPAWN} })()\n`,
    )
    expect(kindsOf(effects)).toEqual(["spawn"])
    expect(effects[0]?.callsite).toBe("(iife)>Bun.spawn")
  })

  test("a mutually recursive helper pair terminates instead of hanging the guard", () => {
    // A cycle in the local-resolution walk is a hang, not a wrong answer, and a
    // hung guard in CI reads as infrastructure flake rather than as a bug here.
    const effects = scan(
      [
        `import { test } from "bun:test"`,
        `const a = (): unknown => b()`,
        `const b = (): unknown => a()`,
        `const X = a()`,
        ``,
      ].join("\n"),
    )
    expect(effects).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// EFFECT VOCABULARY — every kind the ticket names is actually detected
// ════════════════════════════════════════════════════════════════════════════

describe("module-load effect detector — the whole declared vocabulary fires", () => {
  const CASES: Record<ModuleLoadEffectKind, string> = {
    spawn: `import { spawnSync } from "node:child_process"\nspawnSync("python3", ["--version"])\n`,
    "install-or-build": `Bun.spawnSync(["bun", "test", "probe.test.ts"])\n`,
    "git-init": `import { execFileSync } from "node:child_process"\nexecFileSync("git", ["init", "-q"])\n`,
    serve: `Bun.serve({ port: 0, fetch: () => new Response("x") })\n`,
    network: `const r = await fetch("https://example.com")\n`,
    "temp-dir": `import { mkdtempSync } from "node:fs"\nconst d = mkdtempSync("/tmp/x-")\n`,
  }

  for (const kind of MODULE_LOAD_EFFECT_KINDS) {
    test(`detects "${kind}" at module scope`, () => {
      expect(kindsOf(scan(CASES[kind]))).toContain(kind)
    })

    test(`does NOT detect "${kind}" when the same code is inside a test body`, () => {
      // Red-on-injection for the whole vocabulary at once: any kind that is
      // classified by TEXT rather than by POSITION fails here.
      const body = CASES[kind]
      const imports = body
        .split("\n")
        .filter((l) => l.startsWith("import "))
        .join("\n")
      const rest = body
        .split("\n")
        .filter((l) => !l.startsWith("import ") && l.trim().length > 0)
        .join("\n")
      expect(
        scan(`import { test } from "bun:test"\n${imports}\ntest("t", async () => {\n${rest}\n})\n`),
      ).toEqual([])
    })
  }

  test("an unimported local named `exec` is NOT mistaken for child_process.exec", () => {
    // Import-binding awareness. Without it the guard fires on any file that
    // happens to name a helper `exec` or `fork`, which is how guards earn their
    // reputation for noise.
    expect(scan(`const exec = (s: string): string => s\nconst y = exec("ls")\n`)).toEqual([])
  })

  test("a shell tagged template at module scope is a spawn", () => {
    expect(kindsOf(scan('import { $ } from "bun"\nawait $`git status`\n'))).toEqual(["spawn"])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ALLOWLIST SEMANTICS
// ════════════════════════════════════════════════════════════════════════════

describe("module-load allowlist — an exemption must be accountable", () => {
  const EFFECTFUL = { path: "tests/unit/x.test.ts", text: `Bun.spawn(["git", "status"])\n` }
  const ENTRY = {
    file: "tests/unit/x.test.ts",
    kind: "spawn" as const,
    callsite: "Bun.spawn",
    owner: "someone",
    expiresAt: "2099-01-01",
    reason: "a reason long enough to actually be a reason",
  }
  const file = (entries: (typeof ENTRY)[]): ModuleLoadAllowlistFile => ({
    schema: "quanta.module-load-effect-allowlist.v1",
    baseline: {
      owner: "o",
      expiresAt: "2099-01-01",
      maxEffects: 0,
      reason: "a reason long enough to actually be a reason",
      effects: [],
    },
    entries,
  })

  test("an effect with a matching entry is allowed; without one it is a violation", () => {
    expect(enforceModuleLoadEffects({ inputs: [EFFECTFUL], allowlist: file([ENTRY]) }).ok).toBe(
      true,
    )
    const bare = enforceModuleLoadEffects({ inputs: [EFFECTFUL], allowlist: file([]) })
    expect(bare.ok).toBe(false)
    expect(bare.violations[0]?.reason).toContain("no allowlist entry")
  })

  test("🔴 an EXPIRED entry fails even though it matches", () => {
    // Without this, "temporary" is a word in a JSON file. Red-on-injection:
    // drop the expiry comparison and this passes.
    const expired = enforceModuleLoadEffects({
      inputs: [EFFECTFUL],
      allowlist: file([{ ...ENTRY, expiresAt: "2020-01-01" }]),
      now: new Date("2026-09-12T00:00:00Z"),
    })
    expect(expired.ok).toBe(false)
    expect(expired.violations.some((v) => v.reason.includes("expired 2020-01-01"))).toBe(true)
  })

  test("🔴 an entry that matches NOTHING fails — the baseline can only shrink", () => {
    // This is what makes the frozen baseline a RATCHET rather than a floor: a
    // file that gets fixed cannot leave its exemption behind for the next
    // regression to slip into.
    const stale = enforceModuleLoadEffects({
      inputs: [{ path: "tests/unit/x.test.ts", text: "export const clean = 1\n" }],
      allowlist: file([ENTRY]),
    })
    expect(stale.ok).toBe(false)
    expect(stale.violations.some((v) => v.reason.includes("matches nothing (stale)"))).toBe(true)
  })

  test("an entry is keyed on file+kind+callsite, NOT on a line number", () => {
    // A line-keyed allowlist stops covering what it named on the next edit above
    // it, and then silently covers something else.
    const padded = { path: EFFECTFUL.path, text: `${"\n".repeat(40)}${EFFECTFUL.text}` }
    expect(enforceModuleLoadEffects({ inputs: [padded], allowlist: file([ENTRY]) }).ok).toBe(true)
  })

  test("every required field is validated, and a degenerate value is refused", () => {
    expect(validateAllowEntry(ENTRY)).toBeNull()
    for (const field of ["file", "callsite", "owner", "expiresAt", "reason"] as const) {
      expect(validateAllowEntry({ ...ENTRY, [field]: "" })).not.toBeNull()
      expect(validateAllowEntry({ ...ENTRY, [field]: undefined })).not.toBeNull()
    }
    expect(validateAllowEntry({ ...ENTRY, kind: "nonsense" })).not.toBeNull()
    expect(validateAllowEntry({ ...ENTRY, expiresAt: "soon" })).not.toBeNull()
    expect(validateAllowEntry({ ...ENTRY, reason: "because" })).not.toBeNull()
    expect(validateAllowEntry(null)).not.toBeNull()
  })

  test("🔴 the on-disk baseline sits EXACTLY on its ceiling — no slack to grow into", () => {
    // `<=` would leave room a new regression could occupy without tripping
    // anything: the file would still be "under the ceiling" while silently
    // holding more debt than it did yesterday. `--write-baseline` walks the
    // ceiling DOWN with the inventory, so equality is the invariant.
    const parsed = parseAllowlist(readFileSync(ALLOWLIST_PATH, "utf8"))
    expect(parsed.baseline.effects.length).toBeGreaterThan(0)
    expect(parsed.baseline.maxEffects).toBe(parsed.baseline.effects.length)
    // Every expanded entry carries the five accountability fields.
    for (const entry of expandAllowlist(parsed)) expect(validateAllowEntry(entry)).toBeNull()
  })

  test("a baseline larger than its ceiling is refused at parse time", () => {
    const doc = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as {
      baseline: { maxEffects: number }
    }
    doc.baseline.maxEffects = 0
    expect(() => parseAllowlist(JSON.stringify(doc))).toThrow(/ceiling/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// THE REAL CORPUS — green, non-vacuous, and red on a real injected spawn
// ════════════════════════════════════════════════════════════════════════════

describe("module-load effect guard over the real tests/ corpus", () => {
  let corpus: readonly string[]
  let result: GuardResult
  let allowlist: ModuleLoadAllowlistFile

  beforeAll(() => {
    // Read in a hook, not at module load: this file is subject to its own guard.
    allowlist = parseAllowlist(readFileSync(ALLOWLIST_PATH, "utf8"))
    corpus = testCorpusFiles(REPO_ROOT)
    result = enforceModuleLoadEffects({
      inputs: readCorpusInputs(REPO_ROOT, corpus),
      allowlist,
      now: new Date("2026-09-12T00:00:00Z"),
    })
  }, 120_000)

  test("ANTI-VACUUM: the guard parsed everything it listed, and choked on nothing", () => {
    // Both numbers come from the SAME snapshot taken in `beforeAll`. Re-listing
    // here and comparing would be a race, not an invariant: other lanes add test
    // files while this one runs, and a guard that goes red because a sibling
    // landed a file is a guard people learn to re-run until it passes.
    expect(result.filesParsed).toBe(corpus.length)
    expect(result.parseFailures).toEqual([])
  })

  test("🔴 the guard's corpus IS the shared SSOT — asserted where nothing can move", () => {
    // The invariant the race above cannot carry: this guard, the determinism
    // ratchet and the wall-clock inventory must all mean the same thing by
    // "ordinary test source". If one grows a private walk, the first symptom is
    // a file that three guards each believe another one covers.
    //
    // Proven on a FIXED scratch tree, where the answer is deterministic, and
    // built to include the two exclusions that actually differ between a naive
    // walk and the SSOT: a non-test file and a nested directory.
    const scratch = mkdtempSync(join(tmpdir(), "module-load-corpus-ssot-"))
    try {
      mkdirSync(join(scratch, "tests", "unit", "deep"), { recursive: true })
      mkdirSync(join(scratch, "src", "thing"), { recursive: true })
      mkdirSync(join(scratch, "tests", "smoke", "fixtures"), { recursive: true })
      writeFileSync(join(scratch, "tests", "unit", "a.test.ts"), "export const a = 1\n")
      writeFileSync(join(scratch, "tests", "unit", "deep", "b.test.ts"), "export const b = 1\n")
      // A non-test file, and a deliberately-broken FIXTURE that is input to a
      // runner test rather than a test: the two things the SSOT excludes and a
      // naive `**/*.test.ts` walk would not.
      writeFileSync(join(scratch, "tests", "unit", "helper.ts"), "export const h = 1\n")
      writeFileSync(
        join(scratch, "tests", "smoke", "fixtures", "broken.test.ts"),
        "syntax( error\n",
      )
      writeFileSync(join(scratch, "src", "thing", "c.test.ts"), "export const c = 1\n")
      // `listTestSources` enumerates through git, so the fixture tree needs to be
      // one. A spawn inside a test body is exactly where a spawn belongs.
      execFileSync("git", ["init", "-q"], { cwd: scratch })
      expect(testCorpusFiles(scratch)).toEqual([
        "src/thing/c.test.ts",
        "tests/unit/a.test.ts",
        "tests/unit/deep/b.test.ts",
      ])
      expect(readCorpusInputs(scratch).map((input) => input.path)).toEqual([
        ...testCorpusFiles(scratch),
      ])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test("ANTI-VACUUM: every tier the ticket touches is represented, and so is every fixed file", () => {
    // Agreement with the SSOT above is worth nothing if the SSOT itself went
    // empty or collapsed to one directory. Instead of a magic floor, assert the
    // STRUCTURE the corpus must have: the files this ticket is about, and at
    // least one member from each tier the runner schedules separately.
    for (const file of TVH11_FIXED_FILES) {
      expect(corpus, `${file} is not in the scanned corpus`).toContain(file)
    }
    for (const prefix of [
      "tests/unit/",
      "tests/integration/",
      "tests/contract/",
      "tests/meta/",
      "tests/e2e-pty/",
      "src/",
    ]) {
      expect(
        corpus.some((file) => file.startsWith(prefix)),
        `the corpus has no file under ${prefix} — a tier stopped being scanned`,
      ).toBe(true)
    }
  })

  test("ANTI-VACUUM: the guard still SEES effects, and every exemption still matches", () => {
    // The pair to the two invariants above: a detector that had quietly stopped
    // detecting would report zero effects over a corpus of thousands, and every
    // baseline entry would then fail as stale. Both halves are asserted, and
    // every allowlisted file must be IN the corpus — an exemption for a file
    // nobody scans is an exemption that hides nothing and proves nothing.
    expect(result.effectsFound).toBeGreaterThan(0)
    expect(result.unusedAllowEntries).toEqual([])
    const outside = expandAllowlist(allowlist)
      .map((entry) => entry.file)
      .filter((file) => !corpus.includes(file))
    expect(outside, "allowlist entries naming files outside the scanned corpus").toEqual([])
  })

  test("🟢 GREEN: the real corpus has no unaccounted module-load external effect", () => {
    expect(
      result.violations.map((v) => v.reason),
      result.violations.length === 0 ? "" : "unaccounted module-load external effects",
    ).toEqual([])
    expect(result.ok).toBe(true)
  })

  test("🔴 RED ON INJECTION: a real top-level spawn in a scratch fixture tree is caught", () => {
    // The floors above prove the guard LOOKED. This proves it BITES, through the
    // WHOLE pipeline and not just the pure detector: a genuine `.test.ts` with a
    // genuine top-level `Bun.spawn`, written to disk, DISCOVERED by the same
    // `testCorpusFiles` walk, READ by the same `readCorpusInputs`, and judged by
    // the same `enforceModuleLoadEffects` against the SAME on-disk allowlist.
    //
    // The scratch tree is a temp directory rather than a hole punched in
    // `tests/`: an untracked `.test.ts` inside the real tree is a file a
    // concurrent authoritative shard can observe (dirty checkout) or even
    // execute. The fixture proves the same thing without that.
    const scratch = mkdtempSync(join(tmpdir(), "module-load-guard-injection-"))
    try {
      const dir = join(scratch, "tests", "unit", "nested")
      mkdirSync(dir, { recursive: true })
      const relative = "tests/unit/nested/injected.test.ts"
      writeFileSync(
        join(scratch, relative),
        [
          `import { test } from "bun:test"`,
          `const probe = Bun.spawnSync(["git", "--version"])`,
          `test("t", () => { void probe })`,
          ``,
        ].join("\n"),
      )
      const discovered = readCorpusInputsUnder(scratch)
      expect(
        discovered.map((input) => input.path),
        "the corpus walk did not pick the injected file up",
      ).toEqual([relative])
      const red = enforceModuleLoadEffects({
        inputs: discovered,
        allowlist,
        now: new Date("2026-09-12T00:00:00Z"),
      })
      expect(red.ok).toBe(false)
      const reasons = red.violations.map((v) => v.reason).join("\n")
      expect(reasons).toContain(relative)
      expect(reasons).toContain("starts a child process during module evaluation")
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test("🔴 the fourteen files TVH-11 fixed are clean, and none of them is allowlisted", () => {
    // A regression lock AND an honesty lock: "fixed" must not mean "exempted".
    const found = scanModuleLoadEffects(readCorpusInputs(REPO_ROOT, [...TVH11_FIXED_FILES]))
    expect(found.effects.map((e) => `${e.file} ${e.kind} ${e.callsite}`)).toEqual([])
    expect(found.filesParsed).toBe(TVH11_FIXED_FILES.length)
    const allowlisted = expandAllowlist(allowlist).filter((e) =>
      (TVH11_FIXED_FILES as readonly string[]).includes(e.file),
    )
    expect(allowlisted.map((e) => e.file)).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// CAPABILITY RECEIPT ↔ CORPUS ↔ CAPABILITY LANE — three-way drift guard
// ════════════════════════════════════════════════════════════════════════════

/**
 * Compile-time exact equality between the two unions.
 *
 * `tests/_helpers/capability-lane.ts` (TVH-03) owns how a capability lane
 * REPORTS an outcome; `tools/dev/capability-receipt-consumer.ts` (TVH-11) owns
 * how a test LEARNS whether the capability is present. A third vocabulary would
 * mean a decision from one half cannot be reported by the other. `Exact` is
 * `false` the moment either union gains, loses or renames a member, and
 * assigning `true` to `false` is a typecheck failure — which `bun run
 * typecheck:all` is a gate for. `bun test` does NOT typecheck, so the runtime
 * wiring proof below carries the other half.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const VERDICT_UNIONS_ARE_ONE: Exact<CapabilityVerdict, CapabilityOutcome> = true

describe("capability vocabulary and ids do not drift", () => {
  test("🔴 WIRING PROOF: every receipt verdict is directly reportable as a lane outcome", () => {
    // Not a restatement of the type: this CONSTRUCTS the artifact the required
    // aggregator consumes out of each verdict this module can produce, and hands
    // one to the real `reportCapability`. If TVH-03 renames an outcome, the
    // construction stops compiling; if they add a validation this violates, the
    // call throws. Either way a divergence is loud instead of becoming a second
    // dialect nobody counts.
    expect(VERDICT_UNIONS_ARE_ONE).toBe(true)
    const group = CAPABILITY_GROUPS[0]?.id
    expect(group, "the capability manifest declares no groups at all").toBeDefined()
    const results: CapabilityResult[] = CAPABILITY_VERDICTS.map((verdict) => ({
      group: group as string,
      file: "tests/unit/_arch/module-load-effect-guard.test.ts",
      outcome: verdict,
      detail: `drift guard: ${verdict} is a shared outcome`,
    }))
    expect(results.map((r) => r.outcome)).toEqual([...CAPABILITY_VERDICTS])
    const echoed = reportCapability(results[0] as CapabilityResult)
    expect(echoed.outcome).toBe("executed")
  })

  test("🔴 every capability the corpus ASKS for is one the producer PROBES", () => {
    // The silent-failure shape this closes: `capability("lldb_dap")` — a typo,
    // or an id the catalogue dropped — is not a compile error. It returns
    // `blocked-missing`, which is a VISIBLE SKIP, so the suite stays green and
    // the cases quietly stop running. Structural, not grep: a call expression
    // whose callee is the identifier imported from the consumer module.
    // Read from the producer's own list of what a CAMPAIGN receipt carries,
    // rather than rebuilt here with a hardcoded chrome exception. That exception
    // is why this guard stayed green for the whole life of the defect it exists
    // to catch: `chrome-cdp` was in NO receipt any production path could mint,
    // so all 17 gated browser tests answered `blocked-missing` and skipped
    // green, and the guard whitelisted the one id that was actually broken.
    const known = new Set(campaignCapabilityIds({}))
    const callsites = scanCapabilityCallsites(readCorpusInputs(REPO_ROOT))
    expect(callsites.length, "no file consumes the capability receipt at all").toBeGreaterThan(0)
    const unknown = callsites.filter((site) => !known.has(site.capabilityId))
    expect(
      unknown.map((site) => `${site.file}:${site.line} capability("${site.capabilityId}")`),
      "capability ids nothing probes — these silently become blocked-missing skips",
    ).toEqual([])
  })

  test("🔴 capability-lane GROUP ids and receipt capability ids never share a name", () => {
    // Both are read from ONE switch, QUANTA_REQUIRE_CAPABILITIES. A group named
    // after a capability (`cargo`, `node`) would make the whole group required
    // wherever the capability is armed — the runner and the lane wrapper arm
    // every definite receipt id automatically.
    const receiptIds = new Set(campaignCapabilityIds({}))
    const groupIds = CAPABILITY_GROUPS.map((group) => group.id)
    // ANTI-VACUITY: both namespaces are non-trivial.
    expect(receiptIds.size).toBeGreaterThan(8)
    expect(groupIds.length).toBeGreaterThan(8)
    expect(groupIds.filter((id) => receiptIds.has(id))).toEqual([])
  })

  test("🔴 every capability the producer PROBES is one some file ASKS for", () => {
    // The other direction. A catalogue entry nobody consumes is a probe the
    // tier pays for on every run, forever, for nothing — and it reads as
    // coverage in the receipt.
    const asked = new Set(
      scanCapabilityCallsites(readCorpusInputs(REPO_ROOT)).map((site) => site.capabilityId),
    )
    const orphaned = [...campaignCapabilityIds({})].filter((id) => !asked.has(id))
    expect(orphaned, "capabilities probed every tier that no test consumes").toEqual([])
  })

  test("🔴 RED ON INJECTION: an unprobed capability id is reported, not skipped past", () => {
    // Teeth for the two drift guards above, driven on a synthetic corpus so the
    // real one stays untouched: the SAME `known` set and the SAME scanner must
    // name a file that asks for something nothing probes.
    const known = new Set(campaignCapabilityIds({}))
    const injected = scanCapabilityCallsites([
      {
        path: "tests/unit/injected.test.ts",
        text: [
          `import { capability } from "../../tools/dev/capability-receipt-consumer"`,
          `const ok = capability("git")`,
          `const typo = capability("lldb_dap")`,
          ``,
        ].join("\n"),
      },
    ])
    expect(injected.map((site) => site.capabilityId)).toEqual(["git", "lldb_dap"])
    const unknown = injected.filter((site) => !known.has(site.capabilityId))
    expect(unknown.map((site) => site.capabilityId)).toEqual(["lldb_dap"])
  })

  test("PAIRED CONTROL: the callsite scanner is import-aware, not text-matching", () => {
    // A grep for `capability("x")` matches this very test file's own string
    // literals and any local helper of the same name. The scanner must key on
    // the IMPORT, so an identically-named local function is not a callsite and
    // an aliased import still is.
    const local = capabilityCallsites({
      path: "tests/unit/fake.test.ts",
      text: [
        `const capability = (id: string): string => id`,
        `const x = capability("not-a-receipt-call")`,
        ``,
      ].join("\n"),
    })
    expect(local).toEqual([])

    const aliased = capabilityCallsites({
      path: "tests/unit/fake.test.ts",
      text: [
        `import { capability as cap } from "../../tools/dev/capability-receipt-consumer"`,
        `const x = cap("git")`,
        ``,
      ].join("\n"),
    })
    expect(aliased.map((site) => site.capabilityId)).toEqual(["git"])
  })

  test("🔴 every ambient capability call names its id statically and asks at module scope", () => {
    // The two drift guards above read only the ids the scanner can SEE. It used
    // to see one shape — a bare imported name, one string literal — and skipped
    // every other call without a word, so `capability(REAL_CHROME_CAPABILITY)`
    // was a consumer neither guard had ever compared to the catalogue.
    const corpus = readCorpusInputs(REPO_ROOT)
    expect(capabilityCallProblems(corpus)).toEqual([])
    // SENTINEL from the real corpus: the constant-bound call is now resolved.
    // Without it the line above would also pass for a scanner that sees nothing.
    const sites = scanCapabilityCallsites(corpus)
    expect(sites).toContainEqual(
      expect.objectContaining({
        file: "tests/integration/browser-real-chrome-e2e.test.ts",
        capabilityId: "chrome-cdp",
      }),
    )
  })

  test("🔴 RED ON INJECTION: every call shape the drift guard cannot vouch for is named", () => {
    const text = [
      `import { test } from "bun:test"`,
      `import { capability } from "../../tools/dev/capability-receipt-consumer"`,
      `import * as consumer from "../../tools/dev/capability-receipt-consumer"`,
      `let mutable = "git"`,
      `const ids = { chrome: "chrome-cdp" }`,
      `const a = capability(mutable)`,
      `const b = capability(ids.chrome)`,
      `const c = consumer.capability(mutable)`,
      `test("asks too late", () => { capability("git") })`,
      `const helper = (id: string) => capability(id)`,
      ``,
    ].join("\n")
    expect(capabilityCallProblems([{ path: "tests/unit/injected.test.ts", text }])).toEqual([
      "tests/unit/injected.test.ts:10 ambient-call-inside-a-function",
      "tests/unit/injected.test.ts:10 unresolved-id",
      "tests/unit/injected.test.ts:6 unresolved-id",
      "tests/unit/injected.test.ts:7 unresolved-id",
      "tests/unit/injected.test.ts:8 unresolved-id",
      "tests/unit/injected.test.ts:9 ambient-call-inside-a-function",
    ])
  })

  test("🔴 RED ON INJECTION: aliases, dynamic imports, branches and a process.env argument are named", () => {
    // A second audit ran each of these through the scanner and got `calls=[]`
    // or no problem: the drift guard could not see them at all.
    const lines = [
      `import { capability } from "../../tools/dev/capability-receipt-consumer"`,
      `import * as consumer from "../../tools/dev/capability-receipt-consumer"`,
      `const ask = capability`,
      `const viaCall = capability.call(undefined, "git")`,
      `const viaIndex = consumer["capability"]("git")`,
      `const parenthesised = (capability)("git")`,
      `const lazy = await import("../../tools/dev/capability-receipt-consumer")`,
      `const required = require("../../tools/dev/capability-receipt-consumer")`,
      `const gated = process.env.X ? capability("git") : undefined`,
      `if (process.env.Y) { capability("git") }`,
      `const typo = capability("lldb_dap", process.env)`,
      ``,
    ]
    const at = (fragment: string): number => lines.findIndex((line) => line.includes(fragment)) + 1
    const input = { path: "tests/unit/injected-shapes.test.ts", text: lines.join("\n") }
    const problems = capabilityCallProblems([input])
    const expected = [
      `${input.path}:${at("const ask")} indirect-use`,
      `${input.path}:${at("viaCall")} indirect-use`,
      `${input.path}:${at("viaIndex")} indirect-use`,
      `${input.path}:${at("parenthesised")} indirect-use`,
      `${input.path}:${at("lazy")} indirect-use`,
      `${input.path}:${at("required")} indirect-use`,
      `${input.path}:${at("gated")} conditional-call`,
      `${input.path}:${at("if (process")} conditional-call`,
    ]
    for (const line of expected) expect(problems).toContain(line)
    // `process.env` as the second argument reads the campaign receipt, so the
    // typo is a CONSUMED id the drift guard now compares to the catalogue.
    expect(capabilityCallsites(input).map((site) => site.capabilityId)).toContain("lldb_dap")
  })

  test("PAIRED CONTROL: a constant id, an explicit env and a stranger's function are fine", () => {
    const text = [
      `import { test } from "bun:test"`,
      `import * as consumer from "../../tools/dev/capability-receipt-consumer"`,
      `import { capability as cap } from "../../tools/dev/capability-receipt-consumer"`,
      `const ID = "lancedb"`,
      `const a = cap(ID)`,
      `const b = consumer.capability("git")`,
      // The mechanism's own tests pass an env; that is not the campaign receipt.
      `test("drives the mechanism", () => { cap("git", {}) })`,
      `const other = { capability: (id: string) => id }`,
      `const c = other.capability(ID + "x")`,
      ``,
    ].join("\n")
    const input = { path: "tests/unit/control.test.ts", text }
    expect(capabilityCallProblems([input])).toEqual([])
    expect(capabilityCallsites(input).map((site) => site.capabilityId)).toEqual(["lancedb", "git"])
    // The explicit-env call is SEEN, just not counted as a campaign consumer.
    expect(capabilityCalls(input).filter((call) => !call.ambient)).toHaveLength(1)
  })

  test("🔴 RED ON INJECTION: an env the scan cannot prove inert reads the campaign receipt", () => {
    // A third audit ran each of these and got no problem and no callsite: only a
    // literal `process.env` argument counted as ambient. Each carries the same
    // receipt at runtime (`Bun.env === process.env` is true).
    const lines = [
      `import { capability } from "../../tools/dev/capability-receipt-consumer"`,
      `const alias = process.env`,
      `let reused = {}`,
      `const reused2 = {}`,
      `const viaBun = capability("id-bun", Bun.env)`,
      `const viaAlias = capability("id-alias", alias)`,
      `const viaSpread = capability("id-spread", { ...process.env })`,
      `const viaValue = capability("id-value", { QUANTA_CAPABILITY_RECEIPT: process.env.QUANTA_CAPABILITY_RECEIPT })`,
      `const PATH = "x"`,
      `const viaShorthand = capability("id-shorthand", { PATH })`,
      `const viaLet = capability("id-let", reused)`,
      `const viaCast = capability("id-cast", (globalThis.process.env as Record<string, string>))`,
      `test("inside", () => { capability("id-inside", Bun.env) })`,
      ``,
    ]
    const input = { path: "tests/unit/ambient-shapes.test.ts", text: lines.join("\n") }
    expect(capabilityCallsites(input).map((site) => site.capabilityId)).toEqual([
      "id-bun",
      "id-alias",
      "id-spread",
      "id-value",
      "id-shorthand",
      "id-let",
      "id-cast",
      "id-inside",
    ])
    const at = lines.findIndex((line) => line.includes("id-inside")) + 1
    expect(capabilityCallProblems([input])).toEqual([
      `${input.path}:${at} ambient-call-inside-a-function`,
    ])
    // PAIRED CONTROL: a name bound twice, once inert and once not, is not trusted;
    // bound once to an inert literal, it is injected.
    const control = [
      `import { capability } from "../../tools/dev/capability-receipt-consumer"`,
      `const KEY = "QUANTA_CAPABILITY_RECEIPT"`,
      `const EMPTY: Readonly<Record<string, string>> = {}`,
      `test("inert", () => {`,
      `  const produced: Record<string, string> = {}`,
      `  capability("git", EMPTY)`,
      `  capability("git", { A: "1" })`,
      `  capability("git", { [KEY]: produced[KEY] } satisfies Record<string, string | undefined>)`,
      `})`,
      ``,
    ].join("\n")
    const controlInput = { path: "tests/unit/inert-shapes.test.ts", text: control }
    expect(capabilityCalls(controlInput).map((call) => call.ambient)).toEqual([false, false, false])
    expect(capabilityCallProblems([controlInput])).toEqual([])
  })

  test("🔴 conditional means a BRANCH position, and a type or a declaration is not a use", () => {
    // The standard selector put the call in a ternary's CONDITION, which always
    // runs, and the scan called it conditional; an interface field named
    // `capability` was an indirect use. Both were red on ordinary code.
    const clean = [
      `import { capability } from "../../tools/dev/capability-receipt-consumer"`,
      `import * as consumer from "../../tools/dev/capability-receipt-consumer"`,
      `const D = canExecute(capability("git")) ? describe : describe.skip`,
      `const a = capability("git") ?? undefined`,
      `const b = capability("git") && other`,
      `if (capability("git").verdict === "executed") { run() }`,
      `switch (capability("git").verdict) { default: }`,
      `for (const row of [capability("git")]) { use(row) }`,
      `const typed: consumer.CapabilityDecision = consumer.capability("git")`,
      `type Asker = typeof capability`,
      `type Decision = ReturnType<typeof consumer.capability>`,
      `interface Row { readonly capability: string }`,
      `const literal: { capability: string } = { capability: "x" }`,
      `function named(capability: string) { return capability }`,
      `const { capability: renamed } = { capability: 1 }`,
      // Type-only: `implements` is erased, so naming the binding there is not a use.
      `class Impl implements consumer.capability {}`,
      ``,
    ].join("\n")
    expect(capabilityCallProblems([{ path: "tests/unit/clean.test.ts", text: clean }])).toEqual([])

    const lines = [
      `import { capability } from "../../tools/dev/capability-receipt-consumer"`,
      `import * as consumer from "../../tools/dev/capability-receipt-consumer"`,
      `const r1 = gate ?? capability("git")`,
      `const r2 = gate && capability("git")`,
      `const r3 = maybe?.wrap(capability("git"))`,
      `const { r4 = capability("git") } = options`,
      `while (again()) capability("git")`,
      `for (let i = 0; i < 2; i++) capability("git")`,
      `try { load() } catch { capability("git") }`,
      `switch (mode) { case "a": capability("git") }`,
      `gate ||= capability("git")`,
      `const r5 = { alias: capability }`,
      // Runtime: a class `extends` clause evaluates its expression.
      `class Sub extends consumer.capability {}`,
      ``,
    ]
    const input = { path: "tests/unit/branches.test.ts", text: lines.join("\n") }
    const problems = capabilityCallProblems([input])
    const line = (fragment: string): number => lines.findIndex((one) => one.includes(fragment)) + 1
    const expected = [
      ...["r1", "r2", "r3", "r4", "while", "for (let", "catch", "case", "||="].map(
        (fragment) => `${input.path}:${line(fragment)} conditional-call`,
      ),
      `${input.path}:${line("r5")} indirect-use`,
      `${input.path}:${line("Sub")} indirect-use`,
    ].sort()
    expect(problems).toEqual(expected)
  })
})
