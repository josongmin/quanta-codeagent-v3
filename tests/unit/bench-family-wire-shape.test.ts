/**
 * HELLGATE — the ABSENT-selector SUBPROCESS WIRE SHAPE (aug-22 re-audit R3).
 *
 * The launching side forwards a `KEY=val ` env prefix into the box command. At
 * HEAD an ABSENT family selector forwarded NO `QUANTA_SWEBENCH_DATASET_FAMILY`
 * assignment at all: the pool bridge wrote the env var only for a non-empty argv
 * value, and the full-remote path forwarded ambient `process.env` verbatim. The
 * T2/HIGH-1 repair replaced that with `buildSubprocessFamilyEnv(family, …)`,
 * which takes a RESOLVED family and therefore cannot tell "the operator selected
 * nothing" from "the operator typed `--dataset-family verified`" — so every box
 * command on the DEFAULT (i.e. every) run grew a fabricated
 * `QUANTA_SWEBENCH_DATASET_FAMILY='verified'`. That is a live wire-shape change
 * sold as byte-identical.
 *
 * OBSERVABLE: the REAL `createFullRemoteBackend(...).run()` with an injected
 * SpawnFn — i.e. the actual production launch path — and the actual ssh command
 * string it sends to the box. Nothing here re-asserts the encoder in isolation;
 * the assertion is on the bytes the box would receive.
 *
 * NON-VACUITY: the full family union flows through, the absent case is asserted
 * against the EXPLICIT-verified case (same resolved family, different wire), and
 * a known-item floor proves the command string really is the box command.
 *
 * ⚠️ LIVE-DATA: `gradeChunkOnBox` mirrors the fetched report into the operator's
 * `~/.quanta/bench/results` SSOT corpus. Every test here redirects that sink to a
 * per-file temp dir and restores it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatasetFamily } from "../../src/apps/bench/dataset-family-token"
import { createFullRemoteBackend } from "../../src/apps/bench/remote/full"
import { __resetRuntimeConfig } from "../../src/shared"
import {
  createSpawnRecorder,
  ok,
  whenArgsInclude,
  whenCmd,
  whenSshRemote,
  whenSshRemoteIncludes,
  whenSshRemoteMatches,
} from "./bench-spawn-testkit"

const FAMILY_KEY = "QUANTA_SWEBENCH_DATASET_FAMILY"

const TEMP_DIRS: string[] = []
const alloc = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.push(dir)
  return dir
}

/** A REAL python diff: the strict-grounding preflight identifies task language
 *  from the gold patch's file headers and fail-closes without one. */
const PY_FIX_PATCH = [
  "diff --git a/app.py b/app.py",
  "--- a/app.py",
  "+++ b/app.py",
  "@@ -1 +1 @@",
  "-answer = 0",
  "+answer = 42",
].join("\n")

/** One row that satisfies EVERY family's launch preflight, so the family axis is
 *  the only thing that varies across cases: the strict-grounding check needs a
 *  parseable gold patch, and Pro's shape check needs the Scale-harness columns. */
const DATASET = join(alloc("bench-wire-ds-"), "instances.jsonl")
writeFileSync(
  DATASET,
  `${JSON.stringify({
    instance_id: "psf__requests-5414",
    patch: PY_FIX_PATCH,
    before_repo_set_cmd: "pip install -e .",
    selected_test_files_to_run: "tests/test_requests.py",
    fail_to_pass: '["tests/test_requests.py::test_answer"]',
  })}\n`,
)

const RESULTS_DIR = alloc("bench-wire-results-")

const AUTH = JSON.stringify({
  access_token: "ACCESS-xyz",
  refresh_token: "r",
  id_token: "i",
  account_id: "acct",
  expires_at: "2099-01-01T00:00:00Z",
})

let resultsDirBefore: string | undefined
let familyEnvBefore: string | undefined

beforeAll(() => {
  // LIVE-DATA GUARD: point the report SSOT mirror at a temp corpus.
  resultsDirBefore = process.env.QUANTA_BENCH_RESULTS_DIR
  process.env.QUANTA_BENCH_RESULTS_DIR = RESULTS_DIR
  // The absent-selector cases require the ambient key to be genuinely ABSENT —
  // an inherited export would make them pass for the wrong reason.
  familyEnvBefore = process.env[FAMILY_KEY]
  delete process.env[FAMILY_KEY]
  __resetRuntimeConfig()
})

afterAll(() => {
  if (resultsDirBefore === undefined) delete process.env.QUANTA_BENCH_RESULTS_DIR
  else process.env.QUANTA_BENCH_RESULTS_DIR = resultsDirBefore
  if (familyEnvBefore === undefined) delete process.env[FAMILY_KEY]
  else process.env[FAMILY_KEY] = familyEnvBefore
  __resetRuntimeConfig()
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

const mockSpawn = () =>
  createSpawnRecorder(
    whenArgsInclude("describe-security-groups", ok("sg-abc")),
    whenCmd("curl", ok("9.9.9.9")),
    whenArgsInclude("run-instances", ok("i-deadbeef")),
    whenArgsInclude("describe-instances", ok("1.2.3.4")),
    whenSshRemoteIncludes("setsid bash -c", ({ onData }) => {
      onData?.("[PASS] psf__requests-5414 (turns=2)\n")
      return ok("LAUNCHED")
    }),
    whenSshRemote(
      (remote) => remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ"),
      ok("0\n==XQ-RUN-EXIT-XQ==\n"),
    ),
    whenSshRemote((remote) => remote.includes("bun") && remote.includes("READY"), ok("READY")),
    whenSshRemoteIncludes("command -v pyright-langserver", ok("pyright 1.1.350\n")),
    whenSshRemoteIncludes("echo OK", ok("OK\n")),
    whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
    whenSshRemoteMatches(/cat ~\/(?:runs\/[^/]+\/)?report\.json/, () =>
      ok(JSON.stringify({ resolved_ids: ["psf__requests-5414"] })),
    ),
    whenSshRemote((remote) => remote.includes("cat ") || remote.includes(".json"), ok("")),
  )

/** Drive the REAL full-remote backend and return the ssh remote string that
 *  launches the on-box bench command (the one carrying the forwarded env
 *  prefix). `family: undefined` ⇒ the ABSENT selector. */
const boxCommand = async (family: DatasetFamily | undefined): Promise<string> => {
  const { fn, calls } = mockSpawn()
  // FRESH guard/budget dirs per call: those are cross-process leases, and a
  // leftover one from a previous case would abort the launch BEFORE the box
  // command is built — which would make the "no family key" assertion pass
  // vacuously (no command at all contains no key).
  let runErr: unknown
  await createFullRemoteBackend({
    repoDir: "/tmp/fake-repo",
    authJson: AUTH,
    datasetPath: DATASET,
    instanceIds: ["psf__requests-5414"],
    singleBoxGuardDir: join(alloc("bench-wire-guard-"), "guard"),
    tokenBudgetDir: alloc("bench-wire-budget-"),
    tokenBudgetWaitMs: 5_000,
    tokenBudgetPollMs: 10,
    sleep: async () => {},
    maxReadyPolls: 2,
    // Explicit AMI ⇒ the launcher skips SSM resolution (which the fake spawn has
    // no reason to model). Unrelated to the family axis under test.
    ami: "ami-0testtesttesttest",
    spawn: fn,
    ...(family !== undefined ? { swebenchDatasetFamily: family } : {}),
  })
    .run()
    .catch((e: unknown) => {
      runErr = e
    })
  const launch = calls.find(
    (c) => c.cmd === "ssh" && (c.args[c.args.length - 1] ?? "").includes("setsid bash -c"),
  )
  const remote = launch?.args[launch.args.length - 1]
  if (remote === undefined) {
    throw new Error(
      `the backend never issued the box launch command (family=${family ?? "ABSENT"}); ` +
        `run error: ${runErr instanceof Error ? runErr.message : String(runErr)}`,
    )
  }
  return remote
}

/** The family assignment as it appears on the box command, unwrapping the
 *  `setsid bash -c '…'` single-quote escaping (`'\''`). `undefined` ⇒ the key is
 *  not on the command line at all, which is HEAD's absent-selector shape. */
const wiredFamily = (cmd: string): string | undefined =>
  /QUANTA_SWEBENCH_DATASET_FAMILY=(?:'\\''|')([a-z0-9_-]+)/.exec(cmd)?.[1]

describe("R3 — the forwarded box-command env reproduces HEAD's absent-selector shape", () => {
  test("KNOWN-ITEM FLOOR — the captured string really is the box bench command", async () => {
    const cmd = await boxCommand("pro")
    // If this walker ever stops finding the real launch command, these fail
    // loudly instead of letting the family assertions pass vacuously.
    expect(cmd).toContain("setsid bash -c")
    expect(cmd).toContain("src/apps/bench/cli.ts")
    expect(cmd).toContain("--swebench")
  }, 60_000)

  test("ABSENT selector ⇒ NO family assignment on the box command at all", async () => {
    const cmd = await boxCommand(undefined)
    expect(
      cmd.includes(FAMILY_KEY),
      `HEAD forwarded no family key for an absent selector; got:\n${cmd.slice(0, 800)}`,
    ).toBe(false)
  }, 60_000)

  test("EXPLICIT selector ⇒ the family IS assigned, for the whole union", async () => {
    for (const fam of ["verified", "live", "pro"] as const) {
      const cmd = await boxCommand(fam)
      expect(cmd.includes(FAMILY_KEY), `--dataset-family ${fam} put no key on the wire`).toBe(true)
      expect(wiredFamily(cmd), `--dataset-family ${fam} never reached the box command`).toBe(fam)
    }
  }, 120_000)

  // PMX-01 SPEND GUARD — `promax` is deliberately NOT in the loop above. Its
  // remote lane is not wired (PMX-04 owns it), and the profile refuses it in
  // PREFLIGHT, i.e. before provisioning. This drives the REAL backend and asserts
  // on the recorded AWS calls: the refusal must land with no RunInstances.
  test("promax full-remote is refused BEFORE RunInstances (no box is spent)", async () => {
    const dataset = join(alloc("bench-wire-promax-ds-"), "promax.jsonl")
    writeFileSync(
      dataset,
      `${JSON.stringify({
        instance_id: "psf__requests-5414",
        repo: "psf/requests",
        base_commit: "c".repeat(40),
        problem_statement: "x",
        language: "python",
        // GRADER-ONLY fields on purpose: they are what makes the gold-leak
        // preflight the FIRST gate this row hits, and that gate is the one that
        // refuses before any box is launched. See the pin below.
        image_name: "promax/psf-requests:pinned",
        working_dir: "/testbed",
      })}\n`,
    )
    const { fn, calls } = mockSpawn()
    let runErr: unknown
    await createFullRemoteBackend({
      repoDir: "/tmp/fake-repo",
      authJson: AUTH,
      datasetPath: dataset,
      instanceIds: ["psf__requests-5414"],
      singleBoxGuardDir: join(alloc("bench-wire-guard-"), "guard"),
      tokenBudgetDir: alloc("bench-wire-budget-"),
      tokenBudgetWaitMs: 5_000,
      tokenBudgetPollMs: 10,
      sleep: async () => {},
      maxReadyPolls: 2,
      ami: "ami-0testtesttesttest",
      preset: "agentless-v1",
      spawn: fn,
      swebenchDatasetFamily: "promax",
    })
      .run()
      .catch((e: unknown) => {
        runErr = e
      })
    expect(runErr).toBeDefined()
    // `caa32c3f6` OPENED the ProMax lane, which DELETED the "REMOTE ProMax lane"
    // refusal this used to pin — that string now exists nowhere but in this file.
    // What refuses this row today is the gold-leak preflight, and it is the gate
    // that makes the money assertion below true: it lands before any launch.
    //
    // ⚠️ KNOWN GAP, deliberately not papered over here. Drop the two grader-only
    // fields above (i.e. ship the PUBLIC projection, which is what a real
    // full-remote row should be) and the run gets PAST this gate and reaches
    // RunInstances before refusing at the harness spec — it spends a box. That
    // is a fail-late in the ProMax lane's own money path, not something this
    // test can fix; it needs the lane owner. The pin here states what the code
    // actually guarantees today rather than what we wish it did.
    expect(String(runErr)).toMatch(/GRADER-ONLY gold fields/)
    const spentMoney = calls.filter((c) => c.args.includes("run-instances"))
    expect(spentMoney, "a refused ProMax launch must never reach RunInstances").toEqual([])
    // PAIRED CONTROL: the SAME harness DOES reach RunInstances for `pro`, so the
    // assertion above is not passing because nothing ever provisions here.
    const pro = mockSpawn()
    await createFullRemoteBackend({
      repoDir: "/tmp/fake-repo",
      authJson: AUTH,
      datasetPath: DATASET,
      instanceIds: ["psf__requests-5414"],
      singleBoxGuardDir: join(alloc("bench-wire-guard-"), "guard"),
      tokenBudgetDir: alloc("bench-wire-budget-"),
      tokenBudgetWaitMs: 5_000,
      tokenBudgetPollMs: 10,
      sleep: async () => {},
      maxReadyPolls: 2,
      ami: "ami-0testtesttesttest",
      spawn: pro.fn,
      swebenchDatasetFamily: "pro",
    })
      .run()
      .catch(() => {})
    expect(pro.calls.some((c) => c.args.includes("run-instances"))).toBe(true)
  }, 120_000)

  test("PAIRED — absent and EXPLICIT verified resolve alike but wire differently", async () => {
    // The crux the bare-family encoder could not express: same resolved family,
    // two different wire shapes. A regression that collapses them fails here even
    // though every behavioural family decision is identical.
    const absent = await boxCommand(undefined)
    const explicit = await boxCommand("verified")
    expect(absent.includes(FAMILY_KEY)).toBe(false)
    expect(wiredFamily(absent)).toBeUndefined()
    expect(wiredFamily(explicit)).toBe("verified")
    // Everything ELSE about the two commands is identical — the family key is
    // the only difference, which is what makes this a wire-SHAPE assertion
    // rather than an incidental string diff.
    expect(
      explicit.replace(/ QUANTA_SWEBENCH_DATASET_FAMILY=(?:'\\''|')[a-z0-9_-]+(?:'\\''|')/, ""),
    ).toBe(absent)
  }, 90_000)

  // PMX-04 wiring proof. `withResolvedFamilyBootstrap` calls itself "the ONE
  // resolution point", but it was called INSIDE the provision helper, so the
  // resolved config never left that function and the GRADE phase read the
  // UNRESOLVED one. For a family that grades on-box that meant
  // `bootstrap: undefined`, and the refusal landed ON THE BOX — after
  // RunInstances, i.e. after the money was already spent. Resolution now happens
  // once, at the top of the attempt, so both the provision and the grade path
  // see it.
  //
  // Red-on-injection: put the resolution back inside the provision helper and
  // this run dies with "grades in its own grader phase but the chunk carried NO
  // declared bootstrap".
  test("a ProMax full-remote run reaches the grade phase WITH its declared bootstrap", async () => {
    const dataset = join(alloc("bench-wire-promax-pub-"), "promax.jsonl")
    writeFileSync(
      dataset,
      `${JSON.stringify({
        instance_id: "psf__requests-5414",
        repo: "psf/requests",
        base_commit: "c".repeat(40),
        problem_statement: "x",
        language: "python",
      })}\n`,
    )
    const { fn } = mockSpawn()
    let runErr: unknown
    await createFullRemoteBackend({
      repoDir: "/tmp/fake-repo",
      authJson: AUTH,
      datasetPath: dataset,
      instanceIds: ["psf__requests-5414"],
      singleBoxGuardDir: join(alloc("bench-wire-guard-pub-"), "guard"),
      tokenBudgetDir: alloc("bench-wire-budget-pub-"),
      tokenBudgetWaitMs: 5_000,
      tokenBudgetPollMs: 10,
      sleep: async () => {},
      maxReadyPolls: 2,
      ami: "ami-0testtesttesttest",
      preset: "agentless-v1",
      spawn: fn,
      swebenchDatasetFamily: "promax",
    })
      .run()
      .catch((e: unknown) => {
        runErr = e
      })
    expect(
      String(runErr ?? ""),
      "the declared bootstrap must reach the grade phase, not go missing between provision and grade",
    ).not.toMatch(/NO declared bootstrap/)
  }, 120_000)
})
