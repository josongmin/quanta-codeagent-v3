import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { loadTestResourceCertifications } from "../../../tools/dev/test-resource-certification"
import {
  CLASS_RESOURCE_CLAIMS,
  holdsResource,
  mergeResourceClaims,
  pathOnlyResourceClass,
  RESOURCE_CLAIM_KINDS,
  resourceClaimKind,
  resourceClassFor,
  resourceEvidenceFor,
  scheduleClaimsOverlap,
  TEST_RESOURCE_CLASSES,
  type TestResourceClass,
} from "../../../tools/dev/test-resource-claims"
import {
  CERTIFICATION_REGISTRY_PATH,
  policyTestResources,
  resolveTestResource,
  resolveTestResourceSnapshot,
} from "../../../tools/dev/test-resource-resolution"
import { discoverSuiteFiles, SUITE_FLOORS } from "../../../tools/dev/test-shard-discovery"
import {
  chunkClaimsOverlap,
  classifyTestResource,
  resourceClassesOverlap,
  type TestChunk,
} from "../../../tools/dev/test-shard-plan"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")

interface CorpusRow {
  readonly id: string
  readonly source: string
  readonly evidence: ReturnType<typeof resourceEvidenceFor>
  readonly resourceClass: TestResourceClass
}

/**
 * The discovered universe, read and classified ONCE for the whole file.
 *
 * Four of these tests are corpus-wide invariants — that is the point of them,
 * a sample cannot tell you "0 of 3,959 disagree" — so the read and the
 * detector pass are shared rather than repeated per test.
 */
let cachedCorpus: readonly CorpusRow[] | undefined
const corpus = (): readonly CorpusRow[] => {
  cachedCorpus ??= discoverSuiteFiles(REPO_ROOT, "full").map((file) => {
    const id = relative(REPO_ROOT, file)
    const source = readFileSync(file, "utf8")
    const evidence = resourceEvidenceFor(source)
    return {
      id,
      source,
      evidence,
      resourceClass: evidence.classSignal ?? pathOnlyResourceClass(id),
    }
  })
  return cachedCorpus
}

/** Corpus-wide passes read every file in the tree; 5s is a per-test default,
 *  not a budget anybody measured for this shape of work. */
const CORPUS_TIMEOUT_MS = 60_000

/**
 * The overlap matrix this repository SHIPS.
 *
 * Pinned as a literal because it is a contract, not a corpus measurement: an
 * 8x8 table of which chunk classes may run together, every cell of which was
 * paid for by a measured incident or a measured win. It is the thing that must
 * not move while `resourceClassesOverlap` is rebuilt on top of claim sets.
 */
const SHIPPED_OVERLAP: Readonly<Record<TestResourceClass, readonly TestResourceClass[]>> = {
  pure: ["pure", "worktree", "repo-write", "lsp", "port", "process-global", "integration-path"],
  worktree: ["pure"],
  "repo-write": ["pure"],
  browser: [],
  lsp: ["pure"],
  port: ["pure"],
  "process-global": ["pure"],
  "integration-path": ["pure"],
}

describe("typed resource claims", () => {
  test("a file that uses TWO resources keeps BOTH claims; first-match kept one", () => {
    // ★ THE DEFECT. `classifyTestResource` returned the first regex that
    // matched, so the later hazard was not "considered and allowed" — it was
    // never represented. Both injections below are ordered so that the class
    // detector list would have swallowed the second one.
    const browserAndWorktree = resourceEvidenceFor(`
      const chrome = await launchChromium({ args: ["--headless"] })
      await run("git worktree add /tmp/w main")
    `)
    const browserKeys = browserAndWorktree.claims.map(({ key }) => key)
    expect(browserKeys).toContain("browser-profile")
    expect(browserKeys).toContain("git-common")
    // The legacy class is still ONE value, and it is the earlier detector —
    // which is exactly why the class alone could not express this file.
    expect(browserAndWorktree.classSignal).toBe("worktree")

    const portAndProcessEnv = resourceEvidenceFor(`
      const server = Bun.listen({ port: 4317, socket: {} })
      process.env.QUANTA_HOME = "/tmp/quanta-home"
    `)
    const portKeys = portAndProcessEnv.claims.map(({ key }) => key)
    expect(portKeys).toContain("port:ephemeral")
    expect(portKeys).toContain("process-env")
    expect(portAndProcessEnv.classSignal).toBe("port")

    // PAIRED CONTROL — a file that uses NEITHER claims neither, so "contains"
    // is not passing because the extractor returns everything.
    const inert = resourceEvidenceFor("expect(add(1, 2)).toBe(3)")
    expect(inert.claims.map(({ key }) => key)).not.toContain("browser-profile")
    expect(inert.claims.map(({ key }) => key)).not.toContain("port:ephemeral")
    expect(inert.classSignal).toBeUndefined()
  })

  test(
    "every multi-claim file in the REAL corpus keeps more than its class",
    () => {
      // The synthetic injection above proves the mechanism; this proves the
      // mechanism reaches the corpus, and its floor is derived from the corpus
      // rather than pinned — a growing tree cannot make it wrong, and an empty
      // one cannot make it pass.
      const rows = corpus()
      expect(rows.length).toBeGreaterThanOrEqual(SUITE_FLOORS.full)
      const named = (row: CorpusRow): readonly string[] =>
        row.evidence.claims
          .map(({ key }) => key)
          .filter((key) => resourceClaimKind(key) !== "host-cpu" && key !== "unknown")
      const multiClaim = rows.filter((row) => named(row).length > 1)
      expect(multiClaim.length).toBeGreaterThan(0)
      // Each of those files names a resource its single class value cannot
      // carry — i.e. the hazard first-match classification discarded.
      const withoutHidden = multiClaim.filter((row) => {
        const classClaims = CLASS_RESOURCE_CLAIMS[row.resourceClass]
        return named(row).every((key) => classClaims.some((claim) => claim.key === key))
      })
      expect(withoutHidden.map(({ id }) => id)).toEqual([])
    },
    CORPUS_TIMEOUT_MS,
  )

  test(
    "the class is a projection of the SAME evidence, corpus-wide",
    () => {
      // The 359-file defect was two layers answering from different evidence.
      // This asserts the structural property that makes that impossible: the
      // class a file resolves to is the first class-carrying detector that
      // fired on its source, and that detector's claim is IN the claim set.
      let signalled = 0
      const broken: string[] = []
      for (const row of corpus()) {
        const projected = resourceClassFor(row.id, row.source)
        if (row.evidence.classSignal === undefined) {
          if (projected !== pathOnlyResourceClass(row.id)) broken.push(`${row.id}:path`)
          continue
        }
        signalled += 1
        if (projected !== row.evidence.classSignal) broken.push(`${row.id}:class`)
        const classClaim = CLASS_RESOURCE_CLAIMS[row.evidence.classSignal].find(
          ({ key }) => key !== "unknown",
        )
        if (!row.evidence.claims.some(({ key }) => key === classClaim?.key)) {
          broken.push(`${row.id}:claim`)
        }
      }
      expect(broken).toEqual([])
      // Anti-vacuum: both branches must actually have been reached.
      expect(signalled).toBeGreaterThan(0)
      expect(corpus().length - signalled).toBeGreaterThan(0)
    },
    CORPUS_TIMEOUT_MS,
  )

  test(
    "every claim key names a term in the vocabulary",
    () => {
      const kinds = new Set<string>()
      for (const claims of Object.values(CLASS_RESOURCE_CLAIMS)) {
        for (const claim of claims) {
          expect(resourceClaimKind(claim.key)).toBeDefined()
          kinds.add(resourceClaimKind(claim.key) as string)
        }
      }
      for (const row of corpus()) {
        for (const claim of row.evidence.claims) {
          expect(resourceClaimKind(claim.key)).toBeDefined()
          kinds.add(resourceClaimKind(claim.key) as string)
        }
      }
      // Anti-vacuum: a vocabulary check that never saw a real key would pass on
      // an empty corpus. Require the corpus to exercise most of the vocabulary.
      expect(kinds.size).toBeGreaterThanOrEqual(RESOURCE_CLAIM_KINDS.length - 4)
      expect(resourceClaimKind("portt:4317")).toBeUndefined()
    },
    CORPUS_TIMEOUT_MS,
  )

  test("merging claims keeps the STRICTER mode, not the last one seen", () => {
    const merged = mergeResourceClaims(
      [{ key: "child-process", mode: "shared" }],
      [{ key: "child-process", mode: "exclusive" }],
      [{ key: "child-process", mode: "shared" }],
    )
    expect(merged).toEqual([{ key: "child-process", mode: "exclusive" }])
  })
})

describe("claim-set scheduling", () => {
  test("the shipped 8x8 overlap matrix is reproduced exactly from claim sets", () => {
    for (const left of TEST_RESOURCE_CLASSES) {
      for (const right of TEST_RESOURCE_CLASSES) {
        expect(`${left}+${right}=${resourceClassesOverlap(left, right)}`).toBe(
          `${left}+${right}=${SHIPPED_OVERLAP[left].includes(right)}`,
        )
      }
    }
    // Anti-vacuum: the table must not be all-false or all-true.
    const cells = TEST_RESOURCE_CLASSES.flatMap((left) =>
      TEST_RESOURCE_CLASSES.map((right) => resourceClassesOverlap(left, right)),
    )
    expect(cells.filter(Boolean).length).toBeGreaterThan(0)
    expect(cells.filter((cell) => !cell).length).toBeGreaterThan(0)
  })

  test("host-cpu exclusivity is what keeps a real browser alone on the box", () => {
    // 2026-09-02 gate audit: a real-Chrome file lost an HONOURED,
    // pressure-scaled 60,000ms CDP budget by 1.88ms while scheduled beside a
    // 137-file `pure` chunk, and passed 3/3 alone. `pure` holds no resource,
    // so no resource KIND can express that — only a CPU claim can.
    const browser = CLASS_RESOURCE_CLAIMS.browser
    expect(browser).toContainEqual({ key: "host-cpu", mode: "exclusive" })
    expect(scheduleClaimsOverlap(browser, [])).toBe(false)
    expect(scheduleClaimsOverlap([], browser)).toBe(false)
    // PAIRED CONTROL — remove only the CPU claim and the browser would overlap
    // `pure` again, which is the regression this rule exists to prevent.
    const withoutCpu = browser.filter(({ key }) => key !== "host-cpu")
    expect(scheduleClaimsOverlap(withoutCpu, [])).toBe(true)
  })

  test("`unknown` blocks a peer that HOLDS something and nothing else", () => {
    const unknown = [{ key: "unknown", mode: "exclusive" }] as const
    // Holds nothing: a resource collision needs two parties. This is the rule
    // that keeps `pure` overlapping the uncertified corpus.
    expect(scheduleClaimsOverlap(unknown, [])).toBe(true)
    expect(holdsResource([])).toBe(false)
    // Holds something: the uncertified side might be holding the same thing.
    expect(scheduleClaimsOverlap(unknown, [{ key: "port:4317", mode: "exclusive" }])).toBe(false)
    expect(scheduleClaimsOverlap(unknown, [{ key: "child-process", mode: "shared" }])).toBe(false)
    expect(scheduleClaimsOverlap(unknown, unknown)).toBe(false)
    // A host-cpu SHARED claim is not "holding something" — every test uses CPU.
    expect(holdsResource([{ key: "host-cpu", mode: "shared" }])).toBe(false)
    expect(scheduleClaimsOverlap(unknown, [{ key: "host-cpu", mode: "shared" }])).toBe(true)
  })

  test("certified disjoint keys overlap; the same key does not unless both share", () => {
    const left = [
      { key: "lsp-workspace", mode: "exclusive" },
      { key: "child-process", mode: "shared" },
    ] as const
    const right = [
      { key: "checkout", mode: "exclusive" },
      { key: "child-process", mode: "shared" },
    ] as const
    expect(scheduleClaimsOverlap(left, right)).toBe(true)
    expect(scheduleClaimsOverlap(left, [{ key: "lsp-workspace", mode: "exclusive" }])).toBe(false)
    expect(scheduleClaimsOverlap(left, [{ key: "lsp-workspace", mode: "shared" }])).toBe(false)
    // Symmetry is a property, not a coincidence of argument order.
    expect(scheduleClaimsOverlap(right, left)).toBe(scheduleClaimsOverlap(left, right))
  })
})

describe("one source-aware resolution", () => {
  test(
    "policy and planner agree on EVERY discovered file — and the old call did not",
    () => {
      // ★ THE 359-FILE DEFECT, measured in both directions in one test.
      //
      // `test-policy.ts` called `classifyTestResource(id, "")`. An empty source
      // means the path heuristic always wins, so the policy layer's `resources`
      // field described a file nobody had read. The planner read the real bytes.
      const rows = corpus()
      expect(rows.length).toBeGreaterThanOrEqual(SUITE_FLOORS.full)

      const plannerResources = (id: string): readonly string[] => {
        const resourceClass = classifyTestResource(resolve(REPO_ROOT, id))
        return resourceClass === "pure" ? [] : [resourceClass]
      }
      const legacyPolicyResources = (id: string): readonly string[] => {
        const resourceClass = classifyTestResource(id, "")
        return resourceClass === "pure" ? [] : [resourceClass]
      }

      const shared = rows.filter(
        (row) => policyTestResources(row.id).join("+") !== plannerResources(row.id).join("+"),
      )
      expect(shared.map(({ id }) => id)).toEqual([])

      // RED-ON-INJECTION, live rather than pinned: the same comparison against
      // the empty-source call must still find disagreements. If it ever finds
      // none, this test has stopped being able to detect the defect and says so
      // instead of passing quietly.
      const legacy = rows.filter(
        (row) => legacyPolicyResources(row.id).join("+") !== plannerResources(row.id).join("+"),
      )
      expect(legacy.length).toBeGreaterThan(0)
    },
    CORPUS_TIMEOUT_MS,
  )

  test("a resolution reads the file; a synthetic id says it could not", () => {
    const real = resolveTestResource("tools/dev/test-resource-claims.ts", { repoRoot: REPO_ROOT })
    expect(real.sourceSha256).toBeDefined()
    expect(real.certification).not.toBe("not-read")
    // `not-read` exists so a caller can tell "no evidence" from "evidence says
    // pure" — the conflation that made the empty-source call look reasonable.
    const synthetic = resolveTestResource("tests/unit/does-not-exist.test.ts", {
      repoRoot: REPO_ROOT,
    })
    expect(synthetic.sourceSha256).toBeUndefined()
    expect(synthetic.certification).toBe("not-read")
    expect(synthetic.resourceClass).toBe("pure")
  })

  test("the snapshot digest changes when a file's resolution changes", () => {
    const ids = ["tests/unit/a.test.ts", "tests/integration/b.test.ts"]
    const base = resolveTestResourceSnapshot(ids, { repoRoot: REPO_ROOT })
    const same = resolveTestResourceSnapshot([...ids].reverse(), { repoRoot: REPO_ROOT })
    expect(same.digest).toBe(base.digest)
    const grown = resolveTestResourceSnapshot([...ids, "tests/unit/c.test.ts"], {
      repoRoot: REPO_ROOT,
    })
    expect(grown.digest).not.toBe(base.digest)
  })
})

describe("the certification registry", () => {
  const registry = loadTestResourceCertifications(
    resolve(REPO_ROOT, CERTIFICATION_REGISTRY_PATH),
  ).certifications

  test(
    "every integration-path file has a decision, and the count is derived",
    () => {
      const integrationPath = corpus().filter((row) => row.resourceClass === "integration-path")
      // Anti-vacuum floor from the corpus, not a pinned 562: the tree grows
      // under concurrent agents, and a pinned number is wrong by morning.
      expect(integrationPath.length).toBeGreaterThan(0)
      const certified = new Set(registry.map(({ testId }) => testId))
      const undecided = integrationPath.filter((row) => !certified.has(row.id))
      expect(undecided.map(({ id }) => id)).toEqual([])
      // Both outcomes must be REACHABLE, or "every file is decided" could be
      // satisfied by stamping one status on everything.
      expect(registry.some(({ status }) => status === "certified")).toBe(true)
    },
    CORPUS_TIMEOUT_MS,
  )

  test("a certified file exposes its reviewed claims; a drifted one falls back", () => {
    const row = registry.find(({ status }) => status === "certified")
    expect(row).toBeDefined()
    const certified = row as NonNullable<typeof row>
    const resolved = resolveTestResource(certified.testId, { repoRoot: REPO_ROOT })
    expect(resolved.certification).toBe("certified")
    expect(resolved.claims).toEqual(certified.claims)
    expect(resolved.claims.map(({ key }) => key)).not.toContain("unknown")

    // DRIFT: the same file with one byte appended must NOT keep the reviewed
    // claims. Resolved through the source override so nothing is written to a
    // file another session may be editing.
    const drifted = resolveTestResource(certified.testId, {
      repoRoot: REPO_ROOT,
      source: `${readFileSync(resolve(REPO_ROOT, certified.testId), "utf8")}\n// drift`,
    })
    expect(drifted.certification).toBe("source-drift")
    expect(drifted.claims).toEqual(CLASS_RESOURCE_CLAIMS[drifted.resourceClass])
    expect(drifted.claims.map(({ key }) => key)).toContain("unknown")
  })

  test("an intentionally-exclusive row claims `unknown` and overlaps nothing that holds", () => {
    const exclusive = registry.filter(({ status }) => status === "intentionally-exclusive")
    // The fallback must be REACHABLE — a registry where every row certified
    // would make the fallback path untested rather than unnecessary.
    expect(exclusive.length).toBeGreaterThan(0)
    for (const row of exclusive) {
      expect(row.claims.some(({ key }) => key === "unknown")).toBe(true)
      expect(row.reason).toMatch(/closure contains constructs this analyzer cannot read/)
      expect(scheduleClaimsOverlap(row.claims, [{ key: "checkout", mode: "exclusive" }])).toBe(
        false,
      )
    }
  })
})

/**
 * `chunkClaimsOverlap` — the claim-set form of `resourceClassesOverlap`, and
 * the only place certification's value is observable.
 *
 * It was exported with ZERO call sites and ZERO tests. This campaign deleted
 * `assertGateManifestMatchesContract` for exactly that shape, so this one owes
 * either a proof or a delete. It earns its keep: the class form cannot express
 * "two `port` chunks that hold different ports", and that is the entire reason
 * the certification registry exists.
 *
 * The scheduler still passes CLASS labels. Flipping it needs a 1/2/4-worker
 * verdict-equality canary from a real campaign, so the last test here is an
 * interlock, not decoration.
 */
describe("chunk claim overlap", () => {
  const chunk = (index: number, claims: readonly { key: string; mode: "shared" | "exclusive" }[]) =>
    ({
      index,
      files: [`tests/unit/fixture-${index}.test.ts`],
      resourceClass: "port",
      predictedMs: 1_000,
      claims,
    }) satisfies TestChunk

  test("two certified chunks of the same non-pure class may overlap; their class may not", () => {
    const left = chunk(0, [{ key: "port:4317", mode: "exclusive" }])
    const right = chunk(1, [{ key: "port:5555", mode: "exclusive" }])

    // PAIRED CONTROL. Same two chunks, same scheduler question, two vocabularies.
    // If this arm were also `true` the test would prove nothing about claims.
    expect(resourceClassesOverlap(left.resourceClass, right.resourceClass)).toBe(false)
    expect(chunkClaimsOverlap(left, right)).toBe(true)
  })

  test("one uncertified member collapses the whole chunk back to exclusive", () => {
    // A chunk owns the UNION of its members, so a single unread file's
    // `unknown` is contagious. This is the property that makes partial
    // certification safe to land.
    const certified = chunk(0, [{ key: "port:4317", mode: "exclusive" }])
    const mixed = chunk(1, [
      { key: "port:5555", mode: "exclusive" },
      { key: "unknown", mode: "exclusive" },
    ])
    expect(chunkClaimsOverlap(certified, mixed)).toBe(false)
    expect(chunkClaimsOverlap(mixed, certified)).toBe(false)
  })

  test("the browser CPU carve-out survives the claim form", () => {
    // `host-cpu: exclusive` is the one claim a peer cannot opt out of by
    // holding nothing: measured 2026-09-02, a real-Chrome file lost an
    // honoured 60,000ms CDP budget by 1.88ms beside a 137-file `pure` chunk.
    const browser = chunk(0, [
      { key: "browser-profile", mode: "exclusive" },
      { key: "host-cpu", mode: "exclusive" },
    ])
    const pure = chunk(1, [])
    const disjoint = chunk(2, [{ key: "port:4317", mode: "exclusive" }])
    expect(chunkClaimsOverlap(browser, pure)).toBe(false)
    expect(chunkClaimsOverlap(browser, disjoint)).toBe(false)
    expect(chunkClaimsOverlap(pure, browser)).toBe(false)
  })

  test("the ordinary lock rule still decides a shared key", () => {
    const key = "lsp-workspace"
    const sharedA = chunk(0, [{ key, mode: "shared" }])
    const sharedB = chunk(1, [{ key, mode: "shared" }])
    const writer = chunk(2, [{ key, mode: "exclusive" }])
    expect(chunkClaimsOverlap(sharedA, sharedB)).toBe(true)
    expect(chunkClaimsOverlap(sharedA, writer)).toBe(false)
    expect(chunkClaimsOverlap(writer, sharedA)).toBe(false)
    // ANTI-VACUITY: a function stuck at either constant fails one of these.
    expect(chunkClaimsOverlap(chunk(3, []), chunk(4, []))).toBe(true)
  })

  test("INTERLOCK: the scheduler still schedules by class, and must until the canary exists", () => {
    // Wiring this without a 1/2/4-worker verdict-equality run would widen
    // real concurrency on the strength of a unit test. When that canary is
    // produced, delete this arm in the same commit that changes the call.
    const runner = readFileSync(resolve(REPO_ROOT, "tools/dev/run-test-shards.ts"), "utf8")
    // The PRESENT property, not the absence of a string: the runner hands the
    // scheduler a CLASS label. A stale `not.toContain` would also fire on a
    // comment that merely names the function.
    expect(runner).toMatch(
      /runResourceAwareSchedule<[\s\S]*?resourceClass: cached\.chunk\.resourceClass/,
    )
    const imported = runner.slice(0, runner.indexOf("\n\n"))
    // ANTI-VACUITY: a blank line moved into the import block would shrink this
    // slice to nothing, and "nothing" contains no forbidden symbol either.
    expect(imported).toContain("runResourceAwareSchedule")
    expect(imported).toContain("resourceClassesOverlap")
    expect(imported).not.toContain("chunkClaimsOverlap")
  })
})
