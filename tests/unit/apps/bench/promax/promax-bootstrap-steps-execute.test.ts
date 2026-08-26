/**
 * HELLGATE — EVERY BOOTSTRAP STEP RUNS IN A REAL SHELL, OR IS JUSTIFIED.
 *
 * RCA of this lane's defect history. Eleven separate fixes landed in one pass;
 * they are not eleven bugs. Group them by what the failing code had in common
 * and four of them collapse into ONE:
 *
 *   - the image-provenance program was quoted with `JSON.stringify`, arrived as
 *     one line with literal `\n`, raised a Python SyntaxError, and the pipeline
 *     still exited 0 — every grade discarded for eight live runs;
 *   - the grader-container absence probe used `test -z "$(docker ps …)"`, and
 *     command substitution discards the child's status, so a box with NO docker
 *     reported CLEAN;
 *   - the campaign-root and venv steps interpolated their paths into an `sh -c`
 *     string unquoted.
 *
 * Each was reviewed, each reads correctly as text, and each was wrong the
 * instant a shell parsed it. The common factor is not carelessness: it is that
 * the correctness of these commands lives on the FAR side of a process boundary
 * (ssh → shell → python → docker) while every test in this directory lived on
 * the near side and asserted about a string. The only thing that ever crossed
 * the boundary was a paid EC2 run — which is why the signature of this lane is
 * eight live runs each surfacing exactly one boundary defect.
 *
 * The gap was total, not partial: before this file, the ANSWER-KEY ABSENCE
 * PROBE — the single command the entire gold boundary rests on — had never been
 * executed by anything. Its tests drove fake ssh functions that returned
 * whatever the fixture said.
 *
 * So this file is the class, not another instance. Every step the live plan
 * declares must either RUN here or carry a written reason why it cannot, and
 * the classification is derived from the plan rather than hand-listed, so a new
 * step cannot land unclassified.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  argvRecorder,
  cleanupAllSandboxes,
  declaredStepNames,
  executedStepNames,
  recordedArgv,
  sandbox,
} from "./_bootstrap-exec-harness"

afterAll(cleanupAllSandboxes)

/**
 * Steps a real shell RUNS here, under assertion.
 *
 * Exactly that, and no more. The ledger test at the end of this file backs this
 * list against a set only `Bun.spawn` can add to — so a step listed here that
 * no shell ever ran reddens. MEASURED, and worth stating because the obvious
 * reading is wrong: deleting a step's behavioural scenario does NOT redden it,
 * because the plan-wide round-trip property spawns every plain-argv step too.
 *
 * So this list means "executed", not "its effect is asserted". Which steps have
 * their EFFECT pinned is a separate claim, and the honest evidence for it is
 * red-on-injection rather than a list: breaking the gold probe's negation reds
 * 3, neutering the teardown reds 1, re-opening the container probe reds 1,
 * unquoting the venv root reds 1, truncating the docker format reds 1,
 * unquoting the campaign root reds 2.
 */
const EXECUTED = [
  "gold-absence",
  "grader-container-absence",
  "campaign-root",
  "docker-ready",
  "disk",
  "python-floor",
  "checkout",
  "verify-hashes",
  "python-env",
  "gold-teardown",
] as const

/**
 * Steps that CANNOT be executed locally, each with the reason. Empty today —
 * kept because an empty allowlist is a claim ("nothing is exempt") and a
 * populated one must state its price, and because the drift guard below needs
 * somewhere honest to put a step rather than a reason to be weakened.
 */
const NOT_EXECUTABLE: Readonly<Record<string, string>> = {}

describe("every declared bootstrap step is classified", () => {
  test("🔴 no step is neither executed nor justified", () => {
    const declared = declaredStepNames()
    const classified = new Set<string>([...EXECUTED, ...Object.keys(NOT_EXECUTABLE)])
    const unclassified = declared.filter((s) => !classified.has(s))
    expect(
      unclassified,
      "a bootstrap step reaches a real shell with nothing proving it survives one",
    ).toEqual([])
  })

  test("🔴 an exemption must state its price", () => {
    // An empty string satisfied `Record<string, string>`, so a step could be
    // moved out of EXECUTED — including `gold-absence`, the most safety-critical
    // one — and its scenarios deleted, with every test still green.
    for (const [step, reason] of Object.entries(NOT_EXECUTABLE)) {
      expect(reason.trim().length, `"${step}" is exempted with no reason given`).toBeGreaterThan(20)
    }
  })

  test("🔴 the steps the gold boundary rests on may NEVER be exempted", () => {
    // A one-line edit to a table must not be able to retire the answer-key
    // probe or its teardown from execution coverage.
    for (const step of ["gold-absence", "gold-teardown", "checkout"]) {
      expect(Object.keys(NOT_EXECUTABLE), `${step} was exempted`).not.toContain(step)
      expect(EXECUTED as readonly string[], `${step} lost its coverage`).toContain(step)
    }
  })

  test("the classification does not name steps the plan no longer declares", () => {
    // a stale entry is how an allowlist quietly becomes a blanket amnesty
    const declared = new Set(declaredStepNames())
    const stale = [...EXECUTED, ...Object.keys(NOT_EXECUTABLE)].filter((s) => !declared.has(s))
    expect(stale, "the classification names steps that no longer exist").toEqual([])
  })

  test("ANTI-VACUITY: the plan really declares the steps this file claims to cover", () => {
    // without this, a plan that returned [] would satisfy both tests above
    expect(declaredStepNames().length).toBeGreaterThanOrEqual(10)
  })
})

describe("gold-absence — the command the whole answer-key boundary rests on", () => {
  test("🔴 it PASSES when the checkout is absent", async () => {
    const sb = sandbox()
    const ran = await sb.runStep("gold-absence")
    expect(ran.code, `probe failed on a clean box: ${ran.stderr}`).toBe(0)
  }, 30_000)

  test("🔴 it FAILS when the answer key is sitting there", async () => {
    // The paired half, and the one that matters: a probe that cannot detect the
    // key is a probe that licenses running an agent beside it. Nothing executed
    // this before — every test drove a fake ssh that answered what it was told.
    const sb = sandbox()
    mkdirSync(sb.checkoutRoot, { recursive: true })
    const ran = await sb.runStep("gold-absence")
    expect(ran.code, "the probe reported CLEAN with the checkout present").not.toBe(0)
  }, 30_000)

  test("🔴 a checkout root containing shell metacharacters is still detected", async () => {
    // `test ! -e $x` unquoted would word-split and silently change the question
    const sb = sandbox()
    mkdirSync(sb.checkoutRoot, { recursive: true })
    writeFileSync(join(sb.checkoutRoot, "data"), "GOLD")
    expect((await sb.runStep("gold-absence")).code).not.toBe(0)
  }, 30_000)
})

describe("grader-container-absence — fail-closed in a real shell", () => {
  test("🔴 a clean box passes; a box with NO docker refuses", async () => {
    const clean = sandbox()
    clean.stub("docker", "exit 0")
    expect((await clean.runStep("grader-container-absence")).code).toBe(0)

    const noDocker = sandbox()
    // no docker stub at all — the shape that used to report CLEAN
    expect(
      (await noDocker.runStep("grader-container-absence")).code,
      "a box with no docker reported CLEAN",
    ).not.toBe(0)
  }, 30_000)

  test("🔴 a leftover grader container refuses", async () => {
    const sb = sandbox()
    sb.stub("docker", "echo g_leftover; exit 0")
    expect((await sb.runStep("grader-container-absence")).code).not.toBe(0)
  }, 30_000)
})

describe("campaign-root — it really creates the directory", () => {
  test("🔴 the root exists afterwards, under its literal name", async () => {
    const sb = sandbox()
    // `sudo` is not available in a unit test and must not be; the stub runs the
    // rest of the command as the current user, which is what `sudo` does here.
    sb.stub("sudo", 'exec "$@"')
    sb.stub("chown", "exit 0")
    const ran = await sb.runStep("campaign-root")
    expect(ran.code, ran.stderr).toBe(0)
    expect(existsSync(sb.campaignRoot), "the campaign root was not created").toBe(true)
  }, 30_000)
})

describe("docker-ready — the format string survives the shell", () => {
  test("🔴 the braces reach docker as ONE argument, unexpanded", async () => {
    const sb = sandbox()
    const log = join(sb.root, "docker-argv.txt")
    argvRecorder(sb, "docker", log)
    const ran = await sb.run(sb.plan.find((c) => c.step === "docker-ready") as never)
    expect(ran.code, ran.stderr).toBe(0)
    // `{{.OSType}}/{{.Architecture}}` is brace-expansion bait; unquoted, bash
    // would rewrite it and docker would report a platform we never asked for.
    expect(recordedArgv(log)[0]).toEqual(["info", "--format", "{{.OSType}}/{{.Architecture}}"])
  }, 30_000)
})

describe("disk — a real df against a real directory", () => {
  test("🔴 it reports POSIX 1K blocks for the campaign root", async () => {
    const sb = sandbox()
    mkdirSync(sb.campaignRoot, { recursive: true })
    const ran = await sb.runStep("disk")
    expect(ran.code, ran.stderr).toBe(0)
    // the readiness evaluator parses this; `-P` is what guarantees one row
    expect(ran.stdout).toMatch(/1024-blocks|1K-blocks/)
    expect(ran.stdout.trim().split("\n").length).toBe(2)
    // `-P` is DECLARED here rather than proven by this run, and the distinction
    // is deliberate: what POSIX mode buys is one row for a long device name, and
    // no local filesystem produces one. MEASURED — dropping `-P` leaves every
    // execution assertion in this file green, so an explicit claim about the
    // flag is the honest guard, not a regex that happens to still match.
    expect(sb.plan.find((c) => c.step === "disk")?.argv).toContain("-Pk")
  }, 30_000)
})

describe("python-floor — the interpreter that BUILDS the venv", () => {
  test("🔴 it reports a parseable version from a real python3", async () => {
    const sb = sandbox()
    const ran = await sb.runStep("python-floor")
    expect(ran.code, ran.stderr).toBe(0)
    expect(`${ran.stdout}${ran.stderr}`).toMatch(/Python \d+\.\d+/)
  }, 30_000)
})

describe("checkout — the rendered git commands round-trip through a shell", () => {
  test("🔴 every git argv arrives exactly as declared", async () => {
    const sb = sandbox()
    const log = join(sb.root, "git-argv.txt")
    argvRecorder(sb, "git", log)
    const ran = await sb.runStep("checkout")
    expect(ran.code, ran.stderr).toBe(0)
    // The step also carries a `test ! -L` refusal, and `test` is a shell
    // BUILTIN — a PATH stub can never intercept it, so it cannot round-trip
    // through a recorder. Excluded by command, the same rule the plan-wide
    // property uses.
    const declared = sb.plan
      .filter((c) => c.step === "checkout" && !SHELL_BUILTINS.has(c.argv[0] as string))
      .map((c) => c.argv.slice(1))
    const seen = recordedArgv(log)
    // THE boundary property: a shell parsing the rendered string yields back the
    // argv that was declared — no word splitting, no glob, no `$` expansion. The
    // pinned URL and the 40-char sha are exactly where a mangled token would be
    // invisible in a string assertion and fatal on a box.
    expect(seen).toEqual(declared.map((a) => [...a]))
  }, 30_000)
})

describe("verify-hashes — the digest line the executor parses", () => {
  test("🔴 the rendered command yields `<digest>  <path>` for the pinned files", async () => {
    const sb = sandbox()
    // macOS has no `sha256sum`; the box does. The stub is the real algorithm.
    sb.stub("sha256sum", 'exec shasum -a 256 "$@"')
    mkdirSync(join(sb.checkoutRoot, "data"), { recursive: true })
    mkdirSync(join(sb.checkoutRoot, "src/evaluation"), { recursive: true })
    for (const rel of [
      "data/swe-bench-promax.json",
      "data/eval.json",
      "src/evaluation/test_run.py",
    ]) {
      writeFileSync(join(sb.checkoutRoot, rel), "PINNED")
    }
    const first = sb.plan.filter((c) => c.step === "verify-hashes")[0]
    const ran = await sb.run(first as never)
    expect(ran.code, ran.stderr).toBe(0)
    expect(ran.stdout).toMatch(/^[0-9a-f]{64} {2}\//)
    // …and the PATH in that line is the one we asked about, not a mangled form
    expect(ran.stdout).toContain(sb.checkoutRoot)
  }, 30_000)
})

describe("python-env — `$HOME` expands, the venv root does not", () => {
  test("🔴 uv is invoked from the box's home with a quoted venv root", async () => {
    const sb = sandbox()
    mkdirSync(join(sb.root, ".local/bin"), { recursive: true })
    const log = join(sb.root, "uv-argv.txt")
    // the step names `"$HOME"/.local/bin/uv` — so the stub must live THERE, which
    // is itself the assertion that the expansion happens
    writeFileSync(
      join(sb.root, ".local/bin/uv"),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\nexit 0\n`,
    )
    require("node:fs").chmodSync(join(sb.root, ".local/bin/uv"), 0o755)
    const step = sb.plan.filter((c) => c.step === "python-env")[0]
    const ran = await sb.run(step as never)
    expect(ran.code, `$HOME did not expand, or uv was not found: ${ran.stderr}`).toBe(0)
    expect(recordedArgv(log)[0] ?? []).toEqual(["venv", "--python", "3.11", sb.venvRoot])
  }, 30_000)
})

describe("gold-teardown — the answer key is really removed", () => {
  test("🔴 a populated checkout is gone afterwards", async () => {
    const sb = sandbox()
    mkdirSync(join(sb.checkoutRoot, "data"), { recursive: true })
    writeFileSync(join(sb.checkoutRoot, "data/swe-bench-promax.json"), "GOLD")
    expect(existsSync(sb.checkoutRoot)).toBe(true)
    const ran = await sb.runStep("gold-teardown")
    expect(ran.code, ran.stderr).toBe(0)
    expect(existsSync(sb.checkoutRoot), "the answer key survived teardown").toBe(false)
  }, 30_000)
})

/**
 * PROPERTIES OVER THE WHOLE PLAN.
 *
 * The per-step scenarios above each assert a behaviour, and a behaviour
 * assertion only catches what its fixture can express: a tame `mkdtemp` path
 * behaves identically whether a step quotes it or not, and a `df -Pk` that
 * silently became `df -k` still prints a header a loose regex accepts. Both were
 * MEASURED here — injecting each defect left all eighteen scenarios green.
 *
 * These two properties hold over EVERY command the plan declares, so a step
 * added later inherits them without anyone remembering to.
 */
/**
 * Commands the SHELL resolves itself, so a PATH stub can never intercept them.
 * Keyed by argv[0] rather than by step name: `test` backs both `gold-absence`
 * and part of `gold-teardown`, and a step-name exemption silently widened the
 * moment a step grew a second command.
 */
const SHELL_BUILTINS = new Set(["test", "[", "echo", ":", "true", "false"])

describe("PROPERTY — every declared argv round-trips through a real shell", () => {
  // Spawns one real shell per declared command. Alone that is well under a
  // second; sharing a machine with the rest of this directory it is not, and the
  // 5s default made it flake. The budget is stated rather than the work reduced.
  test("🔴 no token is split, globbed, or expanded on the way to the process", async () => {
    const sb = sandbox()
    const plain = sb.plan.filter(
      (c) => c.argv[0] !== "sh" && !SHELL_BUILTINS.has(c.argv[0] as string),
    )
    expect(plain.length, "nothing to check — the plan shape drifted").toBeGreaterThanOrEqual(8)
    for (const [i, step] of plain.entries()) {
      const log = join(sb.root, `argv-${i}.txt`)
      argvRecorder(sb, step.argv[0] as string, log)
      const ran = await sb.run(step)
      expect(ran.code, `${step.step}: ${ran.stderr}`).toBe(0)
      // The far side is the only place this can be observed. A dropped `-P`, a
      // split path, a `{{…}}` rewritten by brace expansion — all invisible in
      // the rendered string, all fatal on a box.
      expect(recordedArgv(log)[0], `${step.step} argv was mangled by the shell`).toEqual([
        ...step.argv.slice(1),
      ])
    }
  }, 30_000)
})

describe("PROPERTY — every `sh -c` step's script survives the outer shell intact", () => {
  test("🔴 the script reaches `sh` as ONE argument, byte-for-byte", async () => {
    // The argv round-trip above skips `sh -c` steps, and `sh -c` is the shape of
    // two of the three historical defects this file's header lists — so they had
    // ZERO coverage of the property that matters most for them: the script is a
    // single argument the OUTER shell does not touch. A stub `sh` records what
    // it was actually handed.
    const sb = sandbox()
    const shSteps = sb.plan.filter((c) => c.argv[0] === "sh")
    expect(shSteps.length, "no `sh -c` steps — the plan shape drifted").toBeGreaterThanOrEqual(2)
    for (const [i, step] of shSteps.entries()) {
      const log = join(sb.root, `sh-argv-${i}.txt`)
      argvRecorder(sb, "sh", log)
      const ran = await sb.run(step)
      expect(ran.code, `${step.step}: ${ran.stderr}`).toBe(0)
      expect(recordedArgv(log)[0], `${step.step}'s script was mangled`).toEqual([
        ...step.argv.slice(1),
      ])
    }
  }, 30_000)
})

describe("PROPERTY — a hostile campaign root is carried as DATA by every step", () => {
  test("🔴 no step lets the path's NAME execute a command", async () => {
    const sb = sandbox({ hostilePaths: true })
    const canary = join(sb.root, "PWNED")
    // stubs so each step gets far enough to interpolate its path at all
    sb.stub("sudo", 'exec "$@"')
    sb.stub("chown", "exit 0")
    sb.stub("docker", "exit 0")
    sb.stub("git", "exit 0")
    sb.stub("sha256sum", "exit 0")
    for (const step of sb.plan) {
      await sb.run(step)
      expect(existsSync(canary), `step "${step.step}" executed the path's name`).toBe(false)
    }
  }, 30_000)

  test("🔴 the steps that CREATE paths create them under the literal hostile name", async () => {
    // the paired control: "nothing was executed" also passes when nothing ran at
    // all, so at least one step must still do its job with such a path
    const sb = sandbox({ hostilePaths: true })
    sb.stub("sudo", 'exec "$@"')
    sb.stub("chown", "exit 0")
    expect((await sb.runStep("campaign-root")).code).toBe(0)
    expect(existsSync(sb.campaignRoot), "the quoted hostile path was not created").toBe(true)
    expect(existsSync(join(sb.root, "PWNED"))).toBe(false)
  }, 30_000)
})

/**
 * THE GUARD'S OWN WIRING PROOF. Runs last: `EXECUTED` is a hand-written list,
 * and a hand-written list of "steps that are covered" is exactly the kind of
 * near-side claim this file exists to reject. The ledger is written only by
 * `Bun.spawn`, so a step named here that no scenario ran cannot pass.
 */
describe("the coverage claim is backed by actual shell executions", () => {
  test("every step listed as EXECUTED really had a shell spawned for it", () => {
    // HONEST SCOPE, corrected after an audit: this cannot fail while the
    // plan-wide properties exist, because they spawn every declared command
    // themselves — `LEDGER ⊇ plan` by construction, and the stale-entry test
    // already forbids listing a step outside the plan. It is kept as the
    // check that survives if those properties are ever narrowed, not as
    // evidence that any behavioural scenario exists. What pins the SCENARIOS is
    // red-on-injection, recorded in EXECUTED's own comment.
    const ledger = executedStepNames()
    expect(EXECUTED.filter((s) => !ledger.has(s))).toEqual([])
  })

  test("ANTI-VACUITY: a shell really ran for every command the plan declares", () => {
    // stated against the PLAN rather than against EXECUTED, which the
    // classification test already forces to cover the plan
    const declared = new Set(declaredStepNames())
    for (const step of declared) {
      expect(executedStepNames().has(step), `no shell ever ran for "${step}"`).toBe(true)
    }
  })
})
