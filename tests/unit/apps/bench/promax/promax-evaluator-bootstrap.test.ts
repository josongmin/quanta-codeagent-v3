/**
 * PMX-04 — the on-box evaluator BOOTSTRAP: a typed specification plus pure
 * command builders, so argv and ordering are provable without executing
 * anything.
 *
 * The load-bearing claim is "moving `main` cannot change the on-box checkout".
 * A source scan for the string `main` would be a decorative rail, so this file
 * instead runs the EMITTED argv through a fake git that actually implements
 * fetch/checkout/rev-parse against a server whose `main` MOVES between the two
 * runs. If the plan ever regressed to `git clone --depth 1 <url>` the fake would
 * resolve `main` and the two runs would disagree.
 *
 * ⚠️ SPEND SAFETY. No network, no git binary, no Docker, no EC2 — the fake is
 * the only executor and it is local pure state.
 */
import { describe, expect, test } from "bun:test"
import {
  buildProMaxBootstrapPlan,
  buildProMaxBootstrapSpec,
  buildProMaxEvaluatorInvocation,
  evaluateProMaxBootstrapReadiness,
  PROMAX_BOOTSTRAP_STEPS,
  type ProMaxBootstrapCommand,
  type ProMaxBootstrapStep,
} from "@/apps/bench/harness/promax"
import { PROMAX_V1_SNAPSHOT, PROMAX_V1_UPSTREAM_PATHS } from "@/apps/bench/promax/provenance"

const PINNED = PROMAX_V1_SNAPSHOT.upstream_git_commit
/** The campaign root the AGENT phase creates EMPTY; the gold-bearing checkout
 *  lands UNDER it, and only in the grader phase. */
const CAMPAIGN = "/opt/quanta/promax-campaign"
const ROOT = `${CAMPAIGN}/upstream`
const VENV = `${CAMPAIGN}/venv`

const spec = (over: Partial<Parameters<typeof buildProMaxBootstrapSpec>[0]> = {}) =>
  buildProMaxBootstrapSpec({
    campaignRoot: CAMPAIGN,
    checkoutRoot: ROOT,
    venvRoot: VENV,
    patchGenConcurrency: 12,
    ...over,
  })

const plan = (): readonly ProMaxBootstrapCommand[] => buildProMaxBootstrapPlan(spec())

// ---------------------------------------------------------------------------
// A fake git that resolves refs FOR REAL, against a server whose `main` moves.
// ---------------------------------------------------------------------------

interface FakeGitServer {
  branches: Record<string, string>
  objects: Set<string>
}

interface FakeRepo {
  head: string | undefined
  detached: boolean
  fetchHead: string | undefined
  remotes: Record<string, string>
}

interface GitOutcome {
  readonly code: number
  readonly stdout: string
}
const OK: GitOutcome = { code: 0, stdout: "" }
const FAIL: GitOutcome = { code: 128, stdout: "" }

interface GitCall {
  readonly server: FakeGitServer
  readonly repo: FakeRepo
  /** argv after `git` and any `-C <dir>`, minus the subcommand. */
  readonly rest: readonly string[]
  /** id → itself when the object exists; otherwise the branch it names. */
  readonly resolve: (ref: string) => string | undefined
  /** positional (non-flag) arguments. */
  readonly positional: readonly string[]
}

const GIT_COMMANDS: Record<string, (c: GitCall) => GitOutcome> = {
  init: () => OK,
  remote: ({ repo, rest }) => {
    repo.remotes[rest[1] ?? ""] = rest[2] ?? ""
    return OK
  },
  // A `clone` (with or without --depth) takes whatever the DEFAULT BRANCH says.
  // Present precisely so a regression to `git clone` would be OBSERVED, not
  // silently ignored by the fake.
  clone: ({ repo, server }) => {
    repo.head = server.branches.main
    repo.detached = false
    return OK
  },
  fetch: ({ repo, server, positional, resolve }) => {
    const ref = positional[1]
    repo.fetchHead = ref === undefined ? server.branches.main : resolve(ref)
    return repo.fetchHead === undefined ? FAIL : OK
  },
  checkout: ({ repo, rest, positional, resolve }) => {
    const ref = positional[0] ?? "FETCH_HEAD"
    const target = ref === "FETCH_HEAD" ? repo.fetchHead : resolve(ref)
    if (target === undefined) return FAIL
    repo.head = target
    repo.detached = rest.includes("--detach")
    return OK
  },
  "rev-parse": ({ repo }) =>
    repo.head === undefined ? FAIL : { code: 0, stdout: `${repo.head}\n` },
}

const runFakeGit = (server: FakeGitServer, repo: FakeRepo, argv: readonly string[]): GitOutcome => {
  // strip the leading `git` and any `-C <dir>`
  const tokens = [...argv]
  if (tokens[0] === "git") tokens.shift()
  if (tokens[0] === "-C") tokens.splice(0, 2)
  const [cmd, ...rest] = tokens
  const handler = GIT_COMMANDS[cmd ?? ""]
  if (handler === undefined) return OK
  return handler({
    server,
    repo,
    rest,
    positional: rest.filter((t) => !t.startsWith("-")),
    resolve: (ref) => (server.objects.has(ref) ? ref : server.branches[ref]),
  })
}

const checkoutThroughFakeGit = (mainTip: string): FakeRepo => {
  const server: FakeGitServer = {
    branches: { main: mainTip },
    objects: new Set([PINNED, mainTip]),
  }
  const repo: FakeRepo = { head: undefined, detached: false, fetchHead: undefined, remotes: {} }
  for (const cmd of plan()) {
    if (cmd.step !== "checkout") continue
    const r = runFakeGit(server, repo, cmd.argv)
    if (r.code !== 0) throw new Error(`fake git refused: ${cmd.argv.join(" ")}`)
  }
  return repo
}

describe("PMX-04 bootstrap — the on-box checkout is pinned to the EXACT commit", () => {
  test("a moving `main` cannot change the resulting HEAD", () => {
    const MOVED = "9".repeat(40)
    const first = checkoutThroughFakeGit(PINNED) // main happens to be at the pin
    const second = checkoutThroughFakeGit(MOVED) // upstream advanced main
    expect(first.head).toBe(PINNED)
    expect(second.head).toBe(PINNED)
    expect(second.head).not.toBe(MOVED)
  })

  test("the checkout lands DETACHED (a symbolic ref could move under a long run)", () => {
    expect(checkoutThroughFakeGit(PINNED).detached).toBe(true)
  })

  test("the plan names the commit and never a branch/tag ref", () => {
    const checkout = plan().filter((c) => c.step === "checkout")
    expect(checkout.length).toBeGreaterThan(0)
    const flat = checkout.map((c) => c.argv.join(" ")).join("\n")
    expect(flat).toContain(PINNED)
    for (const token of checkout.flatMap((c) => c.argv)) {
      expect(token).not.toBe("main")
      expect(token).not.toBe("master")
      expect(token).not.toBe("HEAD")
      expect(token).not.toContain("refs/heads/")
    }
    // A verification read-back is part of the plan, not an assumption.
    expect(flat).toContain("rev-parse")
  })

  test("the repo URL is the frozen upstream repo", () => {
    const flat = plan()
      .flatMap((c) => c.argv)
      .join(" ")
    expect(flat).toContain(PROMAX_V1_SNAPSHOT.upstream_repo_url)
  })
})

describe("PMX-04 bootstrap — all THREE upstream file hashes are verified on-box", () => {
  test("one verify command per upstream file, each carrying its frozen sha256", () => {
    const verify = plan().filter((c) => c.step === "verify-hashes")
    expect(verify).toHaveLength(3)
    // The expectation is TYPED plan data (replayable from a receipt), and the
    // argv genuinely hashes the on-box absolute path it names.
    expect(verify.map((c) => [c.verifies?.path, c.verifies?.sha256])).toEqual([
      [PROMAX_V1_UPSTREAM_PATHS.dataset, PROMAX_V1_SNAPSHOT.dataset_sha256],
      [PROMAX_V1_UPSTREAM_PATHS.evalMeta, PROMAX_V1_SNAPSHOT.eval_sha256],
      [PROMAX_V1_UPSTREAM_PATHS.evaluator, PROMAX_V1_SNAPSHOT.evaluator_sha256],
    ])
    for (const c of verify) {
      expect(c.argv).toEqual(["sha256sum", c.verifies?.absolutePath ?? "<unset>"])
      expect(c.verifies?.absolutePath).toBe(`${ROOT}/${c.verifies?.path}`)
    }
  })

  test("the spec carries exactly the three frozen files", () => {
    expect(spec().upstreamFiles.map((f) => f.path)).toEqual([
      PROMAX_V1_UPSTREAM_PATHS.dataset,
      PROMAX_V1_UPSTREAM_PATHS.evalMeta,
      PROMAX_V1_UPSTREAM_PATHS.evaluator,
    ])
    expect(spec().upstreamFiles.map((f) => f.sha256)).toEqual([
      PROMAX_V1_SNAPSHOT.dataset_sha256,
      PROMAX_V1_SNAPSHOT.eval_sha256,
      PROMAX_V1_SNAPSHOT.evaluator_sha256,
    ])
  })
})

describe("PMX-04 bootstrap — dedicated python env, docker readiness, disk, platform", () => {
  test("a DEDICATED interpreter environment is created under the campaign venv root", () => {
    const py = plan().filter((c) => c.step === "python-env")
    expect(py.length).toBeGreaterThan(0)
    const flat = py.map((c) => c.argv.join(" ")).join("\n")
    expect(flat).toContain("venv")
    expect(flat).toContain(VENV)
    // and the spec's evaluator interpreter points INTO it, not at a system python
    expect(spec().evaluatorPython).toBe(`${VENV}/bin/python`)
  })

  test("docker daemon readiness is probed for OSType/Architecture", () => {
    const flat = plan()
      .filter((c) => c.step === "docker-ready")
      .map((c) => c.argv.join(" "))
      .join("\n")
    expect(flat).toContain("docker")
    expect(flat).toContain("info")
    expect(flat).toContain("OSType")
    expect(flat).toContain("Architecture")
  })

  test("free disk is probed against the CAMPAIGN root, never the gold-bearing checkout", () => {
    const flat = plan()
      .filter((c) => c.step === "disk")
      .map((c) => c.argv.join(" "))
      .join("\n")
    expect(flat).toContain("df")
    expect(flat).toContain(CAMPAIGN)
    // The disk probe is AGENT-phase, so it must not name the checkout root —
    // that path does not exist while the agent runs.
    expect(flat).not.toContain(ROOT)
  })

  test("the AGENT phase creates the campaign root EMPTY and touches nothing else", () => {
    const agent = plan().filter((c) => c.phase === "agent")
    expect(agent.length).toBeGreaterThanOrEqual(2)
    expect(agent.every((c) => !c.goldBearing)).toBe(true)
    // aug-22 A-A: the agent phase now also PROVES the checkout is absent, which
    // is the ONE kind of agent-phase command allowed to name the gold-bearing
    // root — it names it in order to assert nothing is there. Classify rather
    // than exempt: every other agent command must still be gold-path-free, and
    // the probe must be a DECLARED probe, not merely a command that happens to
    // mention the path.
    const probes = agent.filter((c) => c.absenceProbe !== undefined)
    // The absence proof is now more than one command — a symlink at the root
    // defeats both `test ! -e` and the teardown's `rm -rf`, so the refusal is
    // split across declared probes. What must hold is that EVERY agent-phase
    // command naming the gold root is a declared probe, and every probe names
    // that root; the COUNT was never the property.
    expect(probes.length).toBeGreaterThanOrEqual(1)
    for (const probe of probes) {
      expect(probe.absenceProbe?.absolutePath).toBe(ROOT)
    }
    // The PROPERTY, not the spelling: the probe names the root, asserts absence,
    // and creates nothing. It was `["test","!","-e",ROOT]` until a symlink was
    // shown to defeat both it and the teardown, so an argv-equality assertion
    // here reds on the security fix rather than on a regression.
    const probeCmd = (probes[0]?.argv ?? []).join(" ")
    expect(probeCmd).toContain(ROOT)
    expect(probeCmd).toMatch(/test\s+!\s+-e/)
    expect(probeCmd).not.toMatch(/\bmkdir\b|\bgit\b|\brm\b/)
    const flat = agent
      .filter((c) => c.absenceProbe === undefined)
      .map((c) => c.argv.join(" "))
      .join("\n")
    expect(flat).toContain("mkdir")
    expect(flat).toContain(CAMPAIGN)
    // no upstream identity, no checkout, no gold path
    expect(flat).not.toContain(ROOT)
    expect(flat).not.toContain(PINNED)
    expect(flat).not.toContain(PROMAX_V1_SNAPSHOT.upstream_repo_url)
    for (const rel of Object.values(PROMAX_V1_UPSTREAM_PATHS)) expect(flat).not.toContain(rel)
    // …and NOT EVEN the probe may name the pinned commit, the upstream URL or a
    // gold FILE — absence is asserted on the directory, nothing more is revealed.
    const probeFlat = probes.map((c) => c.argv.join(" ")).join("\n")
    expect(probeFlat).not.toContain(PINNED)
    expect(probeFlat).not.toContain(PROMAX_V1_SNAPSHOT.upstream_repo_url)
    for (const rel of Object.values(PROMAX_V1_UPSTREAM_PATHS)) expect(probeFlat).not.toContain(rel)
  })

  test("a checkoutRoot OUTSIDE the campaign root is REFUSED", () => {
    // Otherwise the agent-phase disk gate would measure one filesystem while the
    // answer key landed on another, and the absence claim would cover the wrong
    // directory.
    expect(() => spec({ checkoutRoot: "/elsewhere/upstream" })).toThrow(/UNDER campaignRoot/)
  })

  test("every declared step actually appears in the plan (no dead step token)", () => {
    const seen = new Set<ProMaxBootstrapStep>(plan().map((c) => c.step))
    expect([...seen].sort()).toEqual([...PROMAX_BOOTSTRAP_STEPS].sort())
  })
})

describe("PMX-04 bootstrap — readiness classification is fail-closed", () => {
  const observed = (over: Record<string, unknown> = {}) => ({
    dockerInfo: "linux/amd64",
    freeDiskBytes: 400 * 1024 ** 3,
    headCommit: PINNED,
    detached: true,
    fileHashes: {
      [PROMAX_V1_UPSTREAM_PATHS.dataset]: PROMAX_V1_SNAPSHOT.dataset_sha256,
      [PROMAX_V1_UPSTREAM_PATHS.evalMeta]: PROMAX_V1_SNAPSHOT.eval_sha256,
      [PROMAX_V1_UPSTREAM_PATHS.evaluator]: PROMAX_V1_SNAPSHOT.evaluator_sha256,
    },
    // A ready box runs an interpreter the pinned evaluator can import. The
    // floor's own refusals are owned by `promax-evaluator-python-floor.test.ts`;
    // here it is a field of "fully ready" like the platform and the disk.
    pythonVersion: { major: 3, minor: 11 },
    ...over,
  })

  test("a fully-ready box yields NO problems", () => {
    expect(evaluateProMaxBootstrapReadiness(spec(), observed())).toEqual([])
  })

  test("a non-amd64 daemon is refused", () => {
    const problems = evaluateProMaxBootstrapReadiness(
      spec(),
      observed({ dockerInfo: "linux/arm64" }),
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("arm64")
  })

  test("a non-linux daemon is refused", () => {
    expect(
      evaluateProMaxBootstrapReadiness(spec(), observed({ dockerInfo: "windows/amd64" })),
    ).toHaveLength(1)
  })

  test("insufficient disk is refused", () => {
    const problems = evaluateProMaxBootstrapReadiness(spec(), observed({ freeDiskBytes: 1024 }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("disk")
  })

  test("a HEAD that is not the pin, or is not detached, is refused", () => {
    expect(
      evaluateProMaxBootstrapReadiness(spec(), observed({ headCommit: "9".repeat(40) })),
    ).toHaveLength(1)
    expect(evaluateProMaxBootstrapReadiness(spec(), observed({ detached: false }))).toHaveLength(1)
  })

  test("ANY of the three file hashes disagreeing is refused, by NAME", () => {
    for (const rel of Object.values(PROMAX_V1_UPSTREAM_PATHS)) {
      const bad = observed()
      ;(bad.fileHashes as Record<string, string>)[rel] = "0".repeat(64)
      const problems = evaluateProMaxBootstrapReadiness(spec(), bad)
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain(rel)
    }
  })

  test("a MISSING hash observation is refused rather than skipped", () => {
    const bad = observed()
    delete (bad.fileHashes as Record<string, string>)[PROMAX_V1_UPSTREAM_PATHS.evaluator]
    expect(evaluateProMaxBootstrapReadiness(spec(), bad)).toHaveLength(1)
  })
})

describe("PMX-04 bootstrap — grader concurrency is SEPARATE from patch-gen concurrency", () => {
  test("evaluator workers stay 1 while patch-gen concurrency varies", () => {
    for (const n of [1, 4, 12, 16]) {
      const s = spec({ patchGenConcurrency: n })
      expect(s.patchGenConcurrency).toBe(n)
      expect(s.evaluatorWorkers).toBe(1)
    }
  })

  test("the REAL evaluator invocation built from the spec is `--workers 1` regardless", () => {
    const s = spec({ patchGenConcurrency: 16 })
    const inv = buildProMaxEvaluatorInvocation({
      pinnedRoot: s.checkoutRoot,
      predictionsPath: "/campaign/preds.json",
      goldenPath: "/campaign/campaign-golden.json",
      outputPath: "/campaign/pass-rate.json",
      pythonExecutable: s.evaluatorPython,
      workers: s.evaluatorWorkers,
    })
    if (!inv.ok) throw new Error("invocation refused")
    const w = inv.invocation.argv.indexOf("--workers")
    expect(inv.invocation.argv[w + 1]).toBe("1")
    expect(inv.invocation.argv[0]).toBe(`${VENV}/bin/python`)
    expect(inv.invocation.cwd).toBe(ROOT)
  })

  test("a patch-gen concurrency that is not a positive integer is refused", () => {
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      expect(() => spec({ patchGenConcurrency: bad })).toThrow()
    }
  })
})
