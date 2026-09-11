/**
 * TEST FIXTURES MUST CLEAN UP UNDER THE RUNNER THAT ACTUALLY RUNS THEM.
 *
 * Nine test files registered their temp-dir cleanup with
 * `process.on("exit", …)`. Bun's test runner does not fire an exit hook for a
 * test file, so none of it ever ran. MEASURED: 790 `promax-gate-ids-*`
 * directories on this machine from one file alone, and the failure mode is not
 * disk — it is that `ls /tmp` gets slow enough to time OTHER tests out, which
 * reds the suite somewhere with no connection to the leak.
 *
 * The pattern reads as cleanup, so nothing about the file looks wrong. This
 * guard is what makes the next copy of it visible: `afterAll` runs, an exit
 * hook does not.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { awaitedSleeps, awaitedSleepTotalMs } from "../../tools/dev/awaited-sleep-budget"
import { nestedSuiteTargets } from "../../tools/dev/nested-suite-targets"
import { isLeak, type TempSite, tempSites } from "../../tools/dev/temp-lifecycle"
import { SPLIT_FIXTURES } from "../_helpers/split-universe"
import { assertScanPopulation } from "./_shared/scan-population"
import { stripComments } from "./_shared/strip-comments"

/**
 * Anchored on THIS file. The roots were bare `"src"` / `"tests"` / `"tools"`,
 * resolved against the ambient cwd — found by the paired control in
 * `tools/dev/cwd-parity-check.ts`: 3 pass at the repo root, 1 pass / 2 fail from
 * a foreign working directory.
 *
 * The walk goes over ABSOLUTE paths and stores REPO-RELATIVE ones, because
 * `isTestAdjacent` and the two `toContain` assertions below are written against
 * repo-relative paths and would silently stop matching if the list turned
 * absolute — trading a cwd bug for a quieter one.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..")
const ROOTS = ["src", "tests", "tools"] as const

/** This file carries the pattern in string literals, on purpose, to prove the
 *  detector fires. It is the ONLY exemption, and it is named rather than
 *  pattern-matched so a second one cannot slip in behind it. */
const SELF = "tests/unit/test-fixtures-do-not-leak-tmp.test.ts"

/** Under `tests/`, or a test file / `__tests__` module anywhere else. */
const isTestAdjacent = (full: string): boolean =>
  full.startsWith("tests/") || full.endsWith(".test.ts") || full.includes("/__tests__/")

const testFiles = (dir: string, into: string[] = []): string[] => {
  for (const entry of readdirSync(join(REPO_ROOT, dir))) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(join(REPO_ROOT, full)).isDirectory()) testFiles(full, into)
    // NOT just `*.test.ts`: the helper modules beside the tests are where the
    // temp dirs are actually created — `_bootstrap-exec-harness.ts` owns every
    // sandbox in the promax suite — and an exit hook planted there leaked 34
    // directories with this guard green.
    //
    // But PRODUCTION code is out of scope: a real Node process does fire its
    // exit hooks, so `src/apps/cli/**` using one is correct. Test-adjacent means
    // anything under `tests/`, plus `*.test.ts` and `__tests__/**` elsewhere.
    else if (full.endsWith(".ts") && isTestAdjacent(full)) into.push(full)
  }
  return into
}

/** Raw corpus for the test-adjacent predicate above. The reach assertion must
 * prove this walk, rather than incorrectly treating the predicate's subset as
 * the entire src/ or tools/ tree. */
const allTsFiles = (dir: string, into: string[] = []): string[] => {
  for (const entry of readdirSync(join(REPO_ROOT, dir))) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(join(REPO_ROOT, full)).isDirectory()) allTsFiles(full, into)
    else if (full.endsWith(".ts")) into.push(full)
  }
  return into
}

/**
 * Comments are not code. Every file converted away from the exit hook explains
 * WHY in a comment that names it, and this very file discusses it in prose — a
 * raw text scan flagged all ten of them.
 */
/**
 * Strip comments WITHOUT eating string literals. The naive form — two regexes
 * over the raw text — treated `"/*"` inside a string as a comment opener and
 * deleted everything up to the next `*` + `/`, which silently removed real code
 * from the scan. A tiny scanner is the honest way; regex cannot see quoting.
 */

/**
 * Every way to register the hook, not just the spelling we happened to use.
 * `process.once("exit")` has identical never-fires semantics, and so do
 * `addListener` / `prependListener`; an audit planted each and the guard stayed
 * green.
 */
const EXIT_HOOK =
  /process\s*(\.\s*[A-Za-z]*[lL]istener|\.\s*(on|once)|\[\s*["'`][A-Za-z]+["'`]\s*\])\s*\(\s*["`']exit["`']/

// The guards below share one immutable inventory and one source read per
// test-adjacent file. Synthetic detector tests operate on strings and do not
// mutate this snapshot.
const TEST_FILES = Object.freeze(ROOTS.flatMap((root) => testFiles(root)))
const ALL_TS_BY_ROOT = new Map(
  ROOTS.map((root) => [root, Object.freeze(allTsFiles(root))] as const),
)
const TEST_SOURCE = new Map(
  TEST_FILES.map((file) => [file, stripComments(readFileSync(join(REPO_ROOT, file), "utf8"))]),
)

describe("temp-dir cleanup is registered with the test runner", () => {
  test('no test file relies on `process.on("exit")`, which bun test never fires', () => {
    const offenders = TEST_FILES.filter((f) => f !== SELF).filter((f) =>
      EXIT_HOOK.test(TEST_SOURCE.get(f) ?? ""),
    )
    expect(
      offenders,
      "these files register cleanup bun test will never run — use `afterAll` instead",
    ).toEqual([])
  })

  test("ANTI-VACUITY: the scan reaches a real, populated set of test files", () => {
    // without this the guard passes just as well when the walk finds nothing
    const all = TEST_FILES
    for (const root of ROOTS) {
      const raw = (ALL_TS_BY_ROOT.get(root) ?? []).map((file) => join(REPO_ROOT, file))
      assertScanPopulation(raw, join(REPO_ROOT, root), {
        id: `tests/unit/test-fixtures-do-not-leak-tmp.test.ts#${root.toUpperCase()}`,
        collectable: (name) => name.endsWith(".ts"),
      })
    }
    expect(all.length).toBeGreaterThan(500)
    // the helper modules are in scope too — that is where the temp dirs live
    expect(all).toContain("tests/unit/apps/bench/promax/_bootstrap-exec-harness.ts")
    expect(all).toContain(SELF)
  })

  test("ANTI-VACUITY: the detector fires on the shape it is looking for", () => {
    const detect = (src: string) => EXIT_HOOK.test(stripComments(src))
    expect(detect('process.on("exit", () => rmSync(d))')).toBe(true)
    expect(detect("process.on('exit', cleanup)")).toBe(true)
    expect(detect('process.once("exit", cleanup)')).toBe(true)
    expect(detect('process.addListener("exit", cleanup)')).toBe(true)
    expect(detect('process["on"]("exit", cleanup)')).toBe(true)
    // every bracket spelling, not the three we happened to think of
    expect(detect('process["prependListener"]("exit", cleanup)')).toBe(true)
    expect(detect('process["prependOnceListener"]("exit", cleanup)')).toBe(true)
    expect(detect("process[`on`]('exit', cleanup)")).toBe(true)
    expect(detect('process.prependListener("exit", cleanup)')).toBe(true)
    expect(detect("afterAll(() => rmSync(d))")).toBe(false)
    // …and the comment-stripping does not become a blanket amnesty: a line that
    // merely FOLLOWS a comment is still code.
    expect(detect('// use afterAll, not process.on("exit")')).toBe(false)
    expect(detect('/* not process.on("exit") */\nprocess.on("exit", cleanup)')).toBe(true)
    // …and a string literal containing comment punctuation is NOT a comment
    expect(stripComments('const pattern = "/*"\nconst other = "*/"\n')).toContain("pattern")
    // a REGEX CLASS holding comment punctuation is not a comment either
    expect(stripComments("const re = /[/*]/\nconst keep = 1\nconst re2 = /[*/]/\n")).toContain(
      "keep",
    )
    // A REGEX inside a template SUBSTITUTION — this repo's own shell-quote
    // idiom. Reading only quotes there made the `'` in `/'/g` open a string
    // that never closed, so the balancing `}` was never found and the rest of
    // the file came back verbatim, comments and all. MEASURED: 84,260
    // characters across 53 files, and a live import forgery through the
    // reachability tool.
    const sq = [
      "const q = (s) => `'$",
      "{s.replace(/'/g, 'x')}'`",
      "\n// gone\nconst kept = 1\n",
    ].join("")
    expect(stripComments(sq)).not.toContain("gone")
    expect(stripComments(sq)).toContain("kept")
  })
})

/**
 * A TEST FILE MAY NOT DISARM THE FENCES FOR EVERY FILE AFTER IT.
 *
 * bun runs every test file in ONE process — measured, same `process.pid` across
 * files — so `delete process.env.X` in an `afterAll` leaves X undefined for
 * every file bun schedules afterwards. `tests/setup.ts` installs
 * `QUANTA_BENCH_RESULTS_DIR` as the fence against writing the operator's live
 * results corpus (the aug-22 incident). Deleting it does not tidy up: it turns
 * the fence off for the rest of the run, and the file that then writes a report
 * is somewhere else entirely.
 *
 * MEASURED before the fix: a sibling's hooks saw both `QUANTA_BENCH_RESULTS_DIR`
 * and `QUANTA_BENCH_HOME` undefined for its entire run.
 */
describe("no test file deletes a shared environment fence", () => {
  const FENCED = ["QUANTA_BENCH_RESULTS_DIR", "QUANTA_BENCH_HOME", "QUANTA_HOME"] as const

  /**
   * A delete the file never UNDOES.
   *
   * Two shapes are legitimate and must not be flagged, because flagging them
   * teaches the next reader to ignore this guard:
   *
   *  · `if (prior === undefined) delete process.env.X` — the correct restore,
   *    putting back exactly what was there, including nothing;
   *  · an unconditional delete during SETUP, paired with a saved value the
   *    file restores in a hook. Six files use the first, one uses the second.
   *
   * What is left is a file that removes a shared fence and walks away — and bun
   * runs every file in one process, so that fence stays off.
   */
  const deletes = (src: string, name: string): boolean =>
    src
      .split("\n")
      .some(
        (line) =>
          new RegExp(
            `delete\\s+process\\.env(?:\\.${name}\\b|\\[\\s*["'\`]${name}["'\`]\\s*\\])`,
          ).test(line) && !/\bif\s*\(|\?\?|:\s*delete\b/.test(line),
      ) &&
    // …and the file never RESTORES it — assigning a saved value back, as
    // opposed to merely setting it to a fresh sandbox path during setup. The
    // difference is the identifier: a restore reads from a `prior`/`saved`
    // binding, a setup assignment does not. A looser check ("any assignment
    // exists") marked the real defect as fine, because the file assigns the
    // variable in every test.
    !new RegExp(
      `process\\.env\\.${name}\\s*=\\s*\\w*(?:prior|saved|orig|before|previous)\\w*`,
      "i",
    ).test(src)

  test("🔴 a fenced variable is RESTORED, never deleted outright", () => {
    const offenders = TEST_FILES.filter((f) => f !== SELF).flatMap((f) => {
      const src = TEST_SOURCE.get(f) ?? ""
      return FENCED.filter((name) => deletes(src, name)).map((name) => `${f} → ${name}`)
    })
    expect(
      offenders,
      "restore the prior value instead — bun shares one process across every test file",
    ).toEqual([])
  })

  test("ANTI-VACUITY: the detector fires on both spellings", () => {
    expect(deletes("delete process.env.QUANTA_BENCH_HOME", "QUANTA_BENCH_HOME")).toBe(true)
    expect(deletes('delete process.env["QUANTA_BENCH_HOME"]', "QUANTA_BENCH_HOME")).toBe(true)
    // the CONDITIONAL form is a correct restore, not a finding
    expect(
      deletes("if (prior === undefined) delete process.env.QUANTA_BENCH_HOME", "QUANTA_BENCH_HOME"),
    ).toBe(false)
    // an unconditional delete during setup is fine when the file restores later
    expect(
      deletes("delete process.env.QUANTA_HOME\nprocess.env.QUANTA_HOME = savedHome", "QUANTA_HOME"),
    ).toBe(false)
    // …but not when nothing puts it back
    expect(deletes("delete process.env.QUANTA_HOME\nconst x = 1", "QUANTA_HOME")).toBe(true)
    // restoring is what we want, and must not be flagged
    expect(deletes("process.env.QUANTA_BENCH_HOME = prior", "QUANTA_BENCH_HOME")).toBe(false)
  })
})

/**
 * EVERY TEMP ROOT HAS AN OWNER THAT REMOVES IT, AND THE REMOVAL RUNS WHEN THE
 * TEST FAILS.
 *
 * The guard above reads only one half of the pair: it finds a cleanup HOOK and
 * complains about the hook's kind. It is structurally unable to see the two
 * commonest shapes of the same incident, because neither has a hook:
 *
 *   1. no cleanup at all. MEASURED on this corpus: running the nine files this
 *      ticket touched left **32 directories** behind in a single `bun test`
 *      invocation, and the exit-hook guard was green on every one of them;
 *   2. cleanup written at the END of the test body. It runs on the happy path
 *      and is skipped by the first failing `expect` — so the runs that leak are
 *      exactly the runs that were already going badly.
 *
 * `tools/dev/temp-lifecycle.ts` answers the SCOPE question instead: it resolves
 * the binding that owns each `mkdtemp` result (through `await`, through a local
 * factory like `const makeRepo = async () => mkdtemp(...)`, through an escrow
 * array a hook sweeps) and asks whether a disposal naming that binding sits in a
 * `finally` / `afterEach` / `afterAll` / `onTestFinished`.
 *
 * A grep cannot do this. `rmSync(dir)` inside a `finally` and `rmSync(dir)` as
 * the last statement of a test body are the same text.
 *
 * ## One-directional
 *
 * The baseline in `tools/dev/temp-lifecycle-burndown.json` records what was
 * already there. A count may fall, a file may leave, and neither a new file nor
 * a higher count is accepted. It is a burndown list, not permission.
 */
describe("mkdtemp is paired with a disposal that runs on failure", () => {
  const BURNDOWN = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools/dev/temp-lifecycle-burndown.json"), "utf8"),
  ) as { leaks: Record<string, number>; moduleScope: Record<string, number> }

  /** The module that IMPLEMENTS ownership. Its own `mkdtemp` is inside the
   *  `withTempDir` whose `finally` every other file borrows, and its escrow is
   *  swept by `disposeAll`, which is a method rather than a hook. Named, not
   *  pattern-matched, so a second exemption cannot appear quietly. */
  const OWNER_MODULE = "tests/_helpers/temp-dir.ts"

  const sitesFor = (rel: string): readonly TempSite[] =>
    tempSites({ path: rel, text: readFileSync(join(REPO_ROOT, rel), "utf8") })

  const CORPUS = TEST_FILES.filter((file) => file !== OWNER_MODULE)
  const FINDINGS = new Map(CORPUS.map((file) => [file, sitesFor(file)] as const))

  const leakCount = (file: string): number =>
    (FINDINGS.get(file) ?? []).filter((site) => isLeak(site)).length
  const moduleScopeCount = (file: string): number =>
    (FINDINGS.get(file) ?? []).filter((site) => site.moduleScope).length

  test("ANTI-VACUITY: the analyzer reaches the corpus and finds real temp roots", () => {
    // A parse that returned nothing would report "no leaks" exactly as loudly.
    const withSites = CORPUS.filter((file) => (FINDINGS.get(file) ?? []).length > 0)
    expect(CORPUS.length, "the walk read no test files").toBeGreaterThan(3000)
    expect(
      withSites.length,
      "no file in the corpus appears to create a temp dir — the analyzer is reading nothing",
    ).toBeGreaterThan(200)
    const cleaned = CORPUS.flatMap((file) => FINDINGS.get(file) ?? []).filter(
      (site) => site.disposition === "cleaned",
    )
    // …and it must be able to say YES, or "leak" is the only answer it has.
    expect(cleaned.length, "the analyzer never classifies anything as clean").toBeGreaterThan(500)
  })

  test("🔴 the analyzer separates a guarded disposal from an unguarded one", () => {
    const one = (text: string) => tempSites({ path: "probe.test.ts", text })
    const body = (inner: string) => `import { test } from "bun:test"\n${inner}\n`

    // no cleanup at all
    expect(
      one(
        body('test("x", () => {\n const d = mkdtempSync("/tmp/a-")\n expect(d).toBeTruthy()\n})'),
      ).map((s) => s.disposition),
    ).toEqual(["leaked"])
    // cleanup on the success path only — the defect this guard exists for
    expect(
      one(
        body(
          'test("x", () => {\n const d = mkdtempSync("/tmp/a-")\n expect(d).toBeTruthy()\n rmSync(d, { recursive: true })\n})',
        ),
      ).map((s) => s.disposition),
    ).toEqual(["unguarded"])
    // the same two lines with a `finally` around them is correct
    expect(
      one(
        body(
          'test("x", () => {\n const d = mkdtempSync("/tmp/a-")\n try {\n expect(d).toBeTruthy()\n } finally {\n rmSync(d, { recursive: true })\n }\n})',
        ),
      ).map((s) => s.disposition),
    ).toEqual(["cleaned"])
    // a hook is correct too
    expect(
      one(
        body(
          'let d = ""\nbeforeEach(() => { d = mkdtempSync("/tmp/a-") })\nafterEach(() => { rmSync(d, { recursive: true }) })\ntest("x", () => { expect(d).toBeTruthy() })',
        ),
      ).map((s) => s.disposition),
    ).toEqual(["cleaned"])
    // an escrow array a hook sweeps is correct — the disposal never names `d`
    expect(
      one(
        body(
          'const made: string[] = []\nafterAll(() => { for (const p of made) rmSync(p, { recursive: true }) })\ntest("x", () => { const d = mkdtempSync("/tmp/a-"); made.push(d); expect(d).toBeTruthy() })',
        ),
      ).map((s) => s.disposition),
    ).toEqual(["cleaned"])
    // a LOCAL FACTORY transfers ownership; its callers are the sites
    expect(
      one(
        body(
          'const makeRepo = async () => mkdtemp("/tmp/a-")\ntest("x", async () => { const repo = await makeRepo()\n expect(repo).toBeTruthy() })',
        ),
      ).map((s) => s.disposition),
    ).toEqual(["transferred", "leaked"])
    // …and the same factory with a `finally` at the call site is clean
    expect(
      one(
        body(
          'const makeRepo = async () => mkdtemp("/tmp/a-")\ntest("x", async () => { const repo = await makeRepo()\n try { expect(repo).toBeTruthy() } finally { await rm(repo, { recursive: true }) } })',
        ),
      ).map((s) => s.disposition),
    ).toEqual(["transferred", "cleaned"])
    // an object-literal property IS a name a disposal could use
    // (`rmSync(opts.cwd)`), so the absence of one is a leak rather than an
    // unnameable root…
    expect(
      one(body('test("x", () => {\n Bun.spawn({ cwd: mkdtempSync("/tmp/a-") })\n})')).map(
        (s) => s.disposition,
      ),
    ).toEqual(["leaked"])
    expect(
      one(
        body(
          'test("x", () => {\n const o = { cwd: mkdtempSync("/tmp/a-") }\n try { expect(o).toBeTruthy() } finally { rmSync(o.cwd, { recursive: true }) }\n})',
        ),
      ).map((s) => s.disposition),
    ).toEqual(["cleaned"])
    // …and a bare expression statement really has no name at all
    expect(
      one(body('test("x", () => {\n mkdtempSync("/tmp/a-")\n})')).map((s) => s.disposition),
    ).toEqual(["unowned"])
  })

  test("no NEW file leaks a temp root, and no burndown count rises", () => {
    const offenders: string[] = []
    for (const file of CORPUS) {
      const found = leakCount(file)
      if (found === 0) continue
      const allowed = BURNDOWN.leaks[file]
      const sites = (FINDINGS.get(file) ?? [])
        .filter((site) => isLeak(site))
        .map((site) => `${site.line} (${site.disposition}: ${site.reason})`)
        .join(", ")
      if (allowed === undefined) offenders.push(`${file}: ${found} new — lines ${sites}`)
      else if (found > allowed) offenders.push(`${file}: ${found} > ${allowed} — lines ${sites}`)
    }
    expect(
      offenders.sort(),
      offenders.length === 0
        ? ""
        : "a temp root with no disposal, or a disposal the first failing assertion skips. " +
            "Use `withTempDir`/`makeTempDirOwner` from tests/_helpers/temp-dir.ts, or move the " +
            "`rm` into a `finally`/`afterEach`:\n  " +
            offenders.join("\n  "),
    ).toEqual([])
  })

  test("no burndown entry is stale — a fixed file must leave the list", () => {
    const stale = Object.entries(BURNDOWN.leaks)
      .filter(([file, n]) => {
        if (!FINDINGS.has(file)) return true // deleted or renamed
        return leakCount(file) < n
      })
      .map(([file]) => file)
      .sort()
    expect(
      stale,
      stale.length === 0
        ? ""
        : `these improved — lower or remove their entry:\n  ${stale.join("\n  ")}`,
    ).toEqual([])
  })

  test("no NEW file creates a temp root at MODULE SCOPE", () => {
    // A module-scope `mkdtemp` runs on IMPORT: during discovery, and during any
    // `-t`-filtered run that executes no case in the file. No `afterAll` can
    // remove it, because it happened before any hook was registered.
    const offenders: string[] = []
    for (const file of CORPUS) {
      const found = moduleScopeCount(file)
      if (found === 0) continue
      const allowed = BURNDOWN.moduleScope[file]
      if (allowed === undefined) offenders.push(`${file}: ${found} new module-scope temp root(s)`)
      else if (found > allowed) offenders.push(`${file}: ${found} > ${allowed}`)
    }
    expect(
      offenders.sort(),
      offenders.length === 0
        ? ""
        : "move the fixture into `beforeAll` and remove it in `afterAll` — importing a test " +
            "file must not create directories:\n  " +
            offenders.join("\n  "),
    ).toEqual([])
  })

  test("no module-scope burndown entry is stale", () => {
    const stale = Object.entries(BURNDOWN.moduleScope)
      .filter(([file, n]) => !FINDINGS.has(file) || moduleScopeCount(file) < n)
      .map(([file]) => file)
      .sort()
    expect(
      stale,
      stale.length === 0
        ? ""
        : `these improved — lower or remove their entry:\n  ${stale.join("\n  ")}`,
    ).toEqual([])
  })
})

/**
 * A TEST FILE MAY NOT SPAWN `bun test` ON A FILE THE TIER ALREADY RUNS.
 *
 * `bench-results-fence-hellgate` proved the bench-results fence behaviourally by
 * running a child `bun test` — which is right; a preload cannot be observed any
 * other way. Its target was the whole five-case sibling suite
 * `tests/unit/bench-write-artifacts.test.ts`, run twice, and that suite is in
 * ordinary membership too. A cold full run executed those five cases THREE
 * times, and four of the five say nothing about the fence.
 *
 * The cost is invisible at the call site: `["bun", "test", victim]` reads as one
 * operation and schedules however many cases the target contains today.
 *
 * The rule is about the TARGET, not the child. Generate a minimal probe — into
 * the OS temp dir, so no other walk discovers it — and spawn THAT.
 *
 * This lives beside the temp-root guards because it is the same question asked
 * of a different resource: what does importing or running this file cost the
 * rest of the run, beyond its own assertions? It also shares their one walk and
 * their already-pinned reach floor.
 */
describe("a test file does not re-run a suite the tier already runs", () => {
  /**
   * Allowlist. A key is `<file>:<target>` and the value is the REASON, which is
   * the whole point: an entry with no reason is indistinguishable from an entry
   * added to make a red go away. Empty today, and it may only gain entries that
   * carry a justification.
   */
  const ALLOWED: Readonly<Record<string, string>> = {}

  const findings = TEST_FILES.flatMap((file) =>
    nestedSuiteTargets({
      path: file,
      text: readFileSync(join(REPO_ROOT, file), "utf8"),
      repoRoot: REPO_ROOT,
    }),
  )

  test("🔴 the detector sees a spawned repo target, and not a generated one", () => {
    const one = (text: string) =>
      nestedSuiteTargets({ path: "probe.test.ts", text, repoRoot: REPO_ROOT })
    const real = "tests/unit/bench-write-artifacts.test.ts"
    // direct literal
    expect(one(`Bun.spawnSync(["bun", "test", ${JSON.stringify(real)}])`)).toHaveLength(1)
    // one hop through a local const — the shape the corpus actually used
    expect(
      one(`const victim = ${JSON.stringify(real)}\nBun.spawnSync(["bun", "test", victim])`),
    ).toHaveLength(1)
    // the `{ cmd: [...] }` spelling
    expect(one(`Bun.spawn({ cmd: ["bun", "test", ${JSON.stringify(real)}] })`)).toHaveLength(1)
    // a target OUTSIDE the repo is not double work — nothing else runs it
    expect(one('Bun.spawnSync(["bun", "test", "/tmp/x/probe.test.ts"])')).toEqual([])
    // a computed target is not guessed at
    expect(one('Bun.spawnSync(["bun", "test", join(dir, "probe.test.ts")])')).toEqual([])
    // a path that does not exist is not a membership overlap
    expect(one('Bun.spawnSync(["bun", "test", "tests/unit/no-such-file.test.ts"])')).toEqual([])
    // not every `bun` spawn is a nested suite
    expect(one(`Bun.spawnSync(["bun", "run", "build", ${JSON.stringify(real)}])`)).toEqual([])
    // flags are not targets
    expect(one('Bun.spawnSync(["bun", "test", "-t", "name"])')).toEqual([])
  })

  test("ANTI-VACUITY: the corpus walk is the same populated one used above", () => {
    expect(TEST_FILES.length).toBeGreaterThan(500)
    // …and at least one file in the corpus really does spawn a child `bun`, or
    // "0 nested targets" is a statement about a corpus with no children in it.
    const spawnsBun = TEST_FILES.filter((file) => {
      const text = readFileSync(join(REPO_ROOT, file), "utf8")
      return text.includes('"bun"') && text.includes("spawn")
    })
    expect(
      spawnsBun.length,
      "no test file spawns bun at all — the nested-target scan is vacuous",
    ).toBeGreaterThan(5)
  })

  test("every nested `bun test` target is outside normal membership, or allowlisted with a reason", () => {
    const offenders = findings
      .filter((hit) => {
        const reason = ALLOWED[`${hit.file}:${hit.target}`]
        return reason === undefined || reason.trim() === ""
      })
      .map((hit) => `${hit.file}:${hit.line} spawns \`bun test ${hit.target}\``)
      .sort()
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : "this target is already scheduled by the tier, so the child duplicates it rather " +
            "than adding anything. Generate a minimal probe into the OS temp dir and spawn " +
            "that, or add an entry to ALLOWED with the reason:\n  " +
            offenders.join("\n  "),
    ).toEqual([])
  })

  test("no allowlist entry is stale", () => {
    const live = new Set(findings.map((hit) => `${hit.file}:${hit.target}`))
    const stale = Object.keys(ALLOWED)
      .filter((key) => !live.has(key))
      .sort()
    expect(stale, stale.length === 0 ? "" : `remove these:\n  ${stale.join("\n  ")}`).toEqual([])
  })
})

/**
 * A SPLIT FIXTURE COVERS ITS WHOLE PRE-SPLIT UNIVERSE, ONCE.
 *
 * Moving an exhaustive case to a `*.nightly.test.ts` sibling is the only way to
 * get a heavy fixture off the PR lane without deleting it — and it is also the
 * easiest way to delete one by accident, because a case that silently stops
 * running looks exactly like a case that got faster.
 *
 * So the two lanes are read, not trusted:
 *
 *     canary ids  ∪  nightly ids  ==  the recorded pre-split universe
 *     canary ids  ∩  nightly ids  ==  ∅
 *
 * The ids come out of the real test titles (`[case:<id>]`) by parsing the two
 * files. A registry that merely LISTED what each lane runs would be a claim
 * maintained by hand, and the first edit to either file would make it false with
 * nothing going red.
 *
 * It lives here for the same reason the nested-suite guard does: this file owns
 * the already-pinned walk, and the question — what does this fixture cost the
 * rest of the run — is the same one.
 */
describe("a split fixture covers its pre-split universe exactly once", () => {
  /** `[case:<id>]` tokens present in a file's TEST TITLES, not anywhere. */
  const caseIdsIn = (rel: string): readonly string[] => {
    const text = readFileSync(join(REPO_ROOT, rel), "utf8")
    const ids: string[] = []
    for (const match of text.matchAll(
      /\b(?:test|it)(?:\.[A-Za-z]+\([^)]*\))?\s*\(\s*(["'`])\[case:([a-z0-9-]+)\]/g,
    ))
      ids.push(match[2] as string)
    return ids
  }

  test("ANTI-VACUITY: the register is populated and its files exist and carry ids", () => {
    expect(SPLIT_FIXTURES.length, "no split fixture is registered").toBeGreaterThan(0)
    for (const fixture of SPLIT_FIXTURES) {
      expect(TEST_FILES, `${fixture.id}: canary file missing`).toContain(fixture.canaryFile)
      expect(TEST_FILES, `${fixture.id}: nightly file missing`).toContain(fixture.nightlyFile)
      expect(fixture.nightlyFile, `${fixture.id}: the nightly lane must be nightly-only`).toContain(
        ".nightly.",
      )
      expect(fixture.universe.length, `${fixture.id}: empty universe`).toBeGreaterThan(0)
      // Both lanes must actually declare something, or "union == universe" is
      // satisfiable by one lane carrying everything and the other being dead.
      expect(
        caseIdsIn(fixture.canaryFile).length,
        `${fixture.id}: canary declares nothing`,
      ).toBeGreaterThan(0)
      expect(
        caseIdsIn(fixture.nightlyFile).length,
        `${fixture.id}: nightly declares nothing`,
      ).toBeGreaterThan(0)
    }
  })

  test("🔴 the id reader sees a tagged test title and not a mention in prose", () => {
    // Proven on a file that really carries the tags, then on shapes that must
    // NOT count — otherwise the union below could be satisfied by a comment.
    const scratch = SPLIT_FIXTURES[0]
    expect(scratch).toBeDefined()
    const ids = caseIdsIn((scratch as (typeof SPLIT_FIXTURES)[number]).nightlyFile)
    expect(ids.length).toBeGreaterThan(0)
    const raw = readFileSync(
      join(REPO_ROOT, (scratch as (typeof SPLIT_FIXTURES)[number]).nightlyFile),
      "utf8",
    )
    // the doc comment at the top of that file mentions `[case:` nowhere as a
    // title, so every id found came from a test declaration
    for (const id of ids) expect(raw).toContain(`test("[case:${id}]`)
  })

  test("PR canary ∪ nightly == the pre-split universe, and their intersection is empty", () => {
    const failures: string[] = []
    for (const fixture of SPLIT_FIXTURES) {
      const canary = caseIdsIn(fixture.canaryFile).filter((id) => fixture.universe.includes(id))
      const nightly = caseIdsIn(fixture.nightlyFile).filter((id) => fixture.universe.includes(id))
      const both = canary.filter((id) => nightly.includes(id)).sort()
      if (both.length > 0) failures.push(`${fixture.id}: run in BOTH lanes → ${both.join(", ")}`)
      const union = [...new Set([...canary, ...nightly])].sort()
      const universe = [...fixture.universe].sort()
      const lost = universe.filter((id) => !union.includes(id))
      if (lost.length > 0) failures.push(`${fixture.id}: LOST from both lanes → ${lost.join(", ")}`)
      const extra = union.filter((id) => !universe.includes(id))
      if (extra.length > 0)
        failures.push(`${fixture.id}: not in the recorded universe → ${extra.join(", ")}`)
    }
    expect(
      failures.sort(),
      failures.length === 0
        ? ""
        : "a split that loses a case is a deletion wearing an optimisation, and one that " +
            "duplicates a case is the cost the split was supposed to remove:\n  " +
            failures.join("\n  "),
    ).toEqual([])
  })

  /** What is wrong with ONE registered boundary canary, if anything. */
  const canaryFaults = (
    fixture: (typeof SPLIT_FIXTURES)[number],
    added: (typeof SPLIT_FIXTURES)[number]["added"][number],
    declared: readonly string[],
  ): readonly string[] => {
    const faults: string[] = []
    if (!declared.includes(added.id))
      faults.push(`${fixture.id}: canary "${added.id}" is registered but not declared`)
    if (added.minimum.trim() === "") faults.push(`${fixture.id}/${added.id}: no minimum stated`)
    // A one-word "why" is how a canary quietly becomes a smoke test.
    if (added.why.trim().split(/\s+/).length < 12)
      faults.push(`${fixture.id}/${added.id}: the reason for the minimum is too thin`)
    if (fixture.universe.includes(added.id))
      faults.push(
        `${fixture.id}/${added.id}: an ADDED canary must not be counted as covering a ` +
          "pre-split case — it is new, and the case it replaced still has to run somewhere",
      )
    return faults
  }

  /** …and whether the split moved the number it claims to have moved. */
  const costFault = (fixture: (typeof SPLIT_FIXTURES)[number]): string | undefined => {
    const cost = fixture.cost
    if (cost.canary < cost.beforeSplit) return undefined
    return (
      `${fixture.id}: the PR lane's measured ${cost.kind} (${cost.canary}) is not below ` +
      `the pre-split figure (${cost.beforeSplit}) — the split bought nothing`
    )
  }

  test("every boundary canary added by a split is present, with a stated minimum and reason", () => {
    const failures = SPLIT_FIXTURES.flatMap((fixture) => {
      const declared = caseIdsIn(fixture.canaryFile)
      const cost = costFault(fixture)
      return [
        ...fixture.added.flatMap((added) => canaryFaults(fixture, added, declared)),
        ...(cost === undefined ? [] : [cost]),
      ]
    })
    expect(failures.sort(), failures.join("\n  ")).toEqual([])
  })
})

/**
 * A FILE'S TOTAL AWAITED REAL TIME IS A BUDGET, AND IT ONLY GOES DOWN.
 *
 * `tests/e2e-pty/cli-goal-pursuit-e2e.test.ts` holds 22,650 ms of awaited fixed
 * sleeps — MEASURED, and 66% of the entire repository's 34,530 ms. Thirteen
 * sites, each individually defensible, and the conversation about the file
 * always ended up about the single 16,000 ms one. Removing that leaves 6,650 ms
 * spread across twelve guesses and the file is still the slowest thing in its
 * lane. That is why the gate is on the SUM per file and not on any one site.
 *
 * Poll intervals (`while (…) await sleep(25)`) and `Promise.race` timeouts are
 * NOT charged — see `tools/dev/awaited-sleep-budget.ts`. Charging them would
 * make the correct shapes score worse than the guess they replace, which is how
 * a rule teaches the wrong lesson.
 *
 * One-directional: a per-file number may fall and an entry may disappear.
 * A rise, or a new file with any awaited fixed sleep at all, is RED — the
 * remedy is a readiness predicate or an injected clock, not a bigger number.
 */
describe("awaited real time per file is a one-directional budget", () => {
  const LEDGER = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools/dev/awaited-sleep-budget.json"), "utf8"),
  ) as { grandTotalMs: number; perFileMs: Record<string, number> }

  /**
   * ORDINARY TIER ONLY. A `*.nightly.test.ts` file is selected by name into the
   * nightly lane and nothing else, so a justified real-time canary living there
   * costs a PR nothing. Charging it to this budget would make "move it to
   * nightly" score identically to "keep it in PR", which is the one distinction
   * the budget exists to make. The 15-second rule below is what keeps the
   * exemption from becoming a loophole.
   */
  const ORDINARY = TEST_FILES.filter((file) => !file.includes(".nightly."))

  const totals = new Map(
    ORDINARY.map(
      (file) =>
        [
          file,
          awaitedSleepTotalMs({ path: file, text: readFileSync(join(REPO_ROOT, file), "utf8") }),
        ] as const,
    ),
  )

  test("ANTI-VACUITY: the ledger and the scan both see real, nonzero waits", () => {
    expect(Object.keys(LEDGER.perFileMs).length, "an empty ledger gates nothing").toBeGreaterThan(
      50,
    )
    const nonzero = [...totals.entries()].filter(([, ms]) => ms > 0)
    expect(
      nonzero.length,
      "the analyzer found no awaited sleep anywhere — it is reading nothing",
    ).toBeGreaterThan(50)
    // …and the analyzer must be able to say ZERO too, or every file is "over".
    expect([...totals.values()].filter((ms) => ms === 0).length).toBeGreaterThan(1000)
    // …and the nightly exemption must be narrow, not a second corpus
    expect(TEST_FILES.length - ORDINARY.length).toBeLessThan(40)
  })

  test("🔴 the analyzer charges a fixed wait and not a poll interval or a race bound", () => {
    const one = (text: string) => awaitedSleepTotalMs({ path: "probe.test.ts", text })
    expect(one("await sleep(1_000)")).toBe(1000)
    expect(one("await sleep(250)\nawait sleep(300)")).toBe(550)
    expect(one("await new Promise((r) => setTimeout(r, 700))")).toBe(700)
    // a poll INTERVAL is paid only until the predicate holds
    expect(one("while (Date.now() < deadline) {\n  if (ok()) return\n  await sleep(25)\n}")).toBe(0)
    expect(one("for (const x of xs) {\n  await sleep(50)\n}")).toBe(0)
    // a race BOUND is an upper limit on something that normally finishes sooner
    expect(one("await Promise.race([proc.exited, sleep(3_000)])")).toBe(0)
    // a non-literal argument is not guessed at
    expect(one("await sleep(idleMs)")).toBe(0)
    // and a bare `sleep(…)` that is never awaited is not a wait this file does
    expect(one("const p = sleep(5_000)")).toBe(0)
    // the site is reported with its line, for the message below
    const sites = awaitedSleeps({ path: "probe.test.ts", text: "\nawait sleep(1_000)\n" })
    expect(sites).toHaveLength(1)
    expect(sites[0]?.line).toBe(2)
    expect(sites[0]?.ms).toBe(1000)
  })

  test("no file's awaited real-time total rises, and no new file introduces one", () => {
    const offenders: string[] = []
    for (const [file, ms] of totals) {
      if (ms === 0) continue
      const allowed = LEDGER.perFileMs[file]
      const where = awaitedSleeps({
        path: file,
        text: readFileSync(join(REPO_ROOT, file), "utf8"),
      })
        .map((site) => `${site.line}:${site.ms}ms`)
        .join(" ")
      if (allowed === undefined) offenders.push(`${file}: ${ms}ms new — ${where}`)
      else if (ms > allowed) offenders.push(`${file}: ${ms}ms > ${allowed}ms — ${where}`)
    }
    expect(
      offenders.sort(),
      offenders.length === 0
        ? ""
        : "wait for the thing, not for a number of milliseconds: a readiness predicate, an " +
            "observable timer state, or an injected monotonic clock. If a real-time canary is " +
            "genuinely required, it belongs in a `*.nightly.test.ts` sibling:\n  " +
            offenders.join("\n  "),
    ).toEqual([])
  })

  test("the repository-wide total does not rise", () => {
    const grand = [...totals.values()].reduce((total, ms) => total + ms, 0)
    expect(
      grand,
      `the repo-wide awaited real time went up (${grand}ms > ${LEDGER.grandTotalMs}ms) — a file ` +
        "was added or a per-file entry was raised",
    ).toBeLessThanOrEqual(LEDGER.grandTotalMs)
  })

  test("no ORDINARY file waits 15 seconds or more at a single site", () => {
    // The ticket's completion criterion. 15 s is the shipped `/goal` quiet
    // window: a wait at or past it is waiting out a production timer, which is a
    // nightly canary's job. It is not a threshold invented here — below it the
    // window has not elapsed and the assertion cannot fail.
    const offenders = ORDINARY.flatMap((file) =>
      awaitedSleeps({ path: file, text: readFileSync(join(REPO_ROOT, file), "utf8") })
        .filter((site) => site.ms >= 15_000)
        .map((site) => `${file}:${site.line} — ${site.ms}ms (${site.text})`),
    ).sort()
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : "a wait this long is waiting out a production timer. That belongs in a " +
            "`*.nightly.test.ts` sibling with the reason written down — see " +
            "tests/e2e-pty/cli-goal-quiet-window.nightly.test.ts:\n  " +
            offenders.join("\n  "),
    ).toEqual([])
  })

  test("no ledger entry is stale — an improved file must be lowered or removed", () => {
    const stale = Object.entries(LEDGER.perFileMs)
      .filter(([file, ms]) => (totals.get(file) ?? 0) < ms)
      .map(([file, ms]) => `${file}: now ${totals.get(file) ?? 0}ms, ledger says ${ms}ms`)
      .sort()
    expect(stale, stale.length === 0 ? "" : `lower these:\n  ${stale.join("\n  ")}`).toEqual([])
  })
})
