import { afterEach, describe, expect, test } from "bun:test"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verificationReceiptPath } from "../../../tools/dev/verification-receipt"

const SOURCE_GATE = join(import.meta.dir, "..", "..", "..", "tools", "dev", "gate.ts")
const SOURCE_DIR = join(import.meta.dir, "..", "..", "..", "tools", "dev")
const roots: string[] = []
const BEHAVIOR_TIMEOUT_MS = 15_000
const behaviorTest = (name: string, run: () => void): void => {
  test(name, run, BEHAVIOR_TIMEOUT_MS)
}

interface ReceiptGate {
  readonly id: string
  readonly run: string
  readonly status: "passed" | "failed" | "skipped" | "not_run"
  readonly elapsedMs: number
}

interface GateReceipt {
  readonly schema: "quanta.gate-receipt.v1"
  readonly stage: "prepush"
  readonly head: string | null
  readonly endHead: string | null
  readonly manifestSha256: string
  readonly snapshotStable: boolean
  readonly startClean: boolean
  readonly endClean: boolean | null
  readonly gates: readonly ReceiptGate[]
  readonly elapsedMs: number
  readonly status: "passed" | "failed" | "invalid"
  readonly missingCapabilities: readonly string[]
  readonly error?: string
}

const cleanGitEnv = (): Record<string, string | undefined> => {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  return env
}

const git = (root: string, args: readonly string[]): string => {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: cleanGitEnv(),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`)
  }
  return proc.stdout.toString().trim()
}

const manifestSource = (
  runs: readonly string[],
  consumesByIndex: Readonly<Record<number, string>> = {},
  quietBoxByIndex: Readonly<Record<number, string>> = {},
): string => {
  const entries = runs.map((run, index) => ({
    id: `gate-${index + 1}`,
    stage: index < 10 ? "precommit" : "prepush",
    run,
    why: `behavioral fixture gate ${index + 1}`,
    ...(consumesByIndex[index] === undefined ? {} : { consumes: consumesByIndex[index] }),
    ...(quietBoxByIndex[index] === undefined ? {} : { needsQuietBox: quietBoxByIndex[index] }),
  }))
  return `
export type GateStage = "precommit" | "prepush"
export interface Gate {
  readonly id: string
  readonly stage: GateStage
  readonly run: string
  readonly why: string
  readonly consumes?: string
  readonly hostDependent?: string
  readonly notInWorkflow?: string
  readonly needsQuietBox?: string
}
export const GATES: readonly Gate[] = ${JSON.stringify(entries, null, 2)}
export const GATE_CONTRACT: readonly { readonly id: string; readonly stage: GateStage }[] =
  GATES.map((gate) => ({ id: gate.id, stage: gate.stage }))
export const gatesForStage = (stage: GateStage): readonly Gate[] =>
  stage === "precommit" ? GATES.filter((gate) => gate.stage === "precommit") : GATES
export const gatesForVerificationTier = (_tier: string): readonly Gate[] => GATES
export const tiersForGate = (gate: Gate): readonly string[] =>
  gate.stage === "precommit"
    ? ["smoke", "prepush", "pr", "full", "nightly"]
    : ["prepush", "pr", "full", "nightly"]
`
}

const makeRepo = (
  runs: readonly string[],
  consumesByIndex: Readonly<Record<number, string>> = {},
  quietBoxByIndex: Readonly<Record<number, string>> = {},
): string => {
  const root = mkdtempSync(join(tmpdir(), "quanta-gate-receipt-"))
  roots.push(root)
  mkdirSync(join(root, "tools", "dev"), { recursive: true })
  copyFileSync(SOURCE_GATE, join(root, "tools", "dev", "gate.ts"))
  for (const dependency of [
    "box-load.ts",
    "verification-admission.ts",
    "verification-nightly-manifest.ts",
    "verification-receipt.ts",
    "verification-receipt-probe.ts",
    "verification-result.ts",
    "verification-tier.ts",
    "external-toolchain.ts",
    "verdict-env.ts",
    "gate-manifest-contract.ts",
  ]) {
    copyFileSync(join(SOURCE_DIR, dependency), join(root, "tools", "dev", dependency))
  }
  writeFileSync(
    join(root, "tools", "dev", "gate-manifest.ts"),
    manifestSource(runs, consumesByIndex, quietBoxByIndex),
  )
  // The exact receipt lands under .cache/; an untracked receipt must not dirty
  // the NEXT run's frozen snapshot (mirrors the real repository's ignore).
  writeFileSync(join(root, ".gitignore"), ".cache/\n")
  writeFileSync(join(root, "tracked.txt"), "baseline\n")
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "gate-test@example.invalid"])
  git(root, ["config", "user.name", "Gate Test"])
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "fixture"])
  return root
}

const runGate = (
  root: string,
  stage: "precommit" | "prepush",
  extraArgs: readonly string[] = [],
  extraEnv: Readonly<Record<string, string>> = {},
): { readonly code: number; readonly stdout: string; readonly stderr: string } => {
  const proc = Bun.spawnSync(
    [process.execPath, join(root, "tools", "dev", "gate.ts"), stage, "--quiet", ...extraArgs],
    {
      cwd: root,
      env: { ...cleanGitEnv(), ...extraEnv },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

const receiptFrom = (stdout: string): GateReceipt => {
  const parsed = stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Partial<GateReceipt>)
    .find((value) => value.schema === "quanta.gate-receipt.v1")
  if (parsed === undefined) throw new Error(`gate receipt missing from stdout:\n${stdout}`)
  return parsed as GateReceipt
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("gate.ts fixture copies every local import", () => {
  test("dropping a sibling from makeRepo fails this scan", async () => {
    const gate = await Bun.file(SOURCE_GATE).text()
    const fixture = await Bun.file(import.meta.path).text()
    const specs = [...gate.matchAll(/from "\.\/([^"]+)"/g)].map((match) => match[1])
    expect(specs.length).toBeGreaterThan(5)
    for (const spec of specs) {
      if (spec === "gate-manifest") {
        expect(fixture).toContain("gatesForVerificationTier")
        expect(fixture).toContain("tiersForGate")
        continue
      }
      expect(fixture).toContain(`${spec}.ts`)
    }
  })
})

describe("a green states what it could not check", () => {
  behaviorTest("absent host tools reach both the summary and the receipt", () => {
    // MEASURED on this box: dlv, gopls and lldb-dap are absent, so the DAP and
    // gopls lanes sit out — and before this, the run printed the same `ok — 21
    // of 21 gate(s) passed` it would print with every tool installed. Absence
    // was already part of the receipt's IDENTITY (a box that gains one cannot
    // replay this green); what was missing was saying so.
    const root = makeRepo(Array.from({ length: 21 }, () => "true"))
    const result = runGate(root, "prepush")
    expect(result.code, result.stderr).toBe(0)
    const receipt = receiptFrom(result.stdout)
    expect(Array.isArray(receipt.missingCapabilities)).toBe(true)

    // The two must agree: a reader of the log and a reader of the receipt are
    // told the same thing, or one of them is being misled.
    if (receipt.missingCapabilities.length === 0) {
      expect(result.stdout).not.toContain("[capabilities]")
      return
    }
    const line = result.stdout.split("\n").find((text) => text.includes("[capabilities]"))
    expect(line, `no capability line in:\n${result.stdout}`).toBeDefined()
    for (const tool of receipt.missingCapabilities) expect(line).toContain(tool)
  })
})

describe("a gate that declares it needs a quiet box", () => {
  // WIRING PROOF. `waitForQuietBox` is unit-tested on its own, which says
  // nothing about whether the gate loop calls it — the shape of an inert
  // surface change. This drives the REAL gate.ts over a synthetic manifest and
  // reads what it printed.
  behaviorTest("the runner waits for the box and reports what it found", () => {
    const root = makeRepo(
      Array.from({ length: 21 }, () => "true"),
      {},
      {
        20: "fixture: a real toolchain that loses to contention",
      },
    )
    // Budget zero: this proves the wait is WIRED, not that the box is quiet.
    // The first version waited on the machine's real load and blew a 15s
    // timeout after 58 seconds inside a campaign — a test whose duration is a
    // function of what else the box is doing.
    const result = runGate(root, "prepush", [], { QUANTA_QUIET_BOX_BUDGET_MS: "0" })
    expect(result.code, result.stderr).toBe(0)
    // Either outcome is correct — what must never happen is silence, because
    // silence is what made a saturated box read as a code defect.
    const line = result.stdout
      .split("\n")
      .find((text) => text.includes("[gate-21]") && text.includes("load/core"))
    expect(line, `no quiet-box line in:\n${result.stdout}`).toBeDefined()
    expect(/box quiet|waited \d+s for a quiet box|RAN HOT/.test(line ?? "")).toBe(true)
  })

  behaviorTest("a FAILING gate reports the load it competed with", () => {
    // The fact whose absence cost a 45-minute campaign: two rust-analyzer cases
    // failed while the box sat at load 52 (16 cores) under another session's
    // forty orphaned busy-loops, and the summary said only FAIL. It was
    // investigated as a code defect for as long as that took.
    const runs = Array.from({ length: 21 }, (_, index) => (index === 20 ? "false" : "true"))
    const root = makeRepo(runs)
    const result = runGate(root, "prepush")
    expect(result.code).not.toBe(0)
    const line = result.stdout
      .split("\n")
      .find((text) => text.includes("FAIL") && text.includes("gate-21"))
    expect(line, `no FAIL line in:\n${result.stdout}`).toBeDefined()
    expect(line).toContain("load/core")
  })

  behaviorTest("gates that do NOT declare it are not made to wait", () => {
    const root = makeRepo(Array.from({ length: 21 }, () => "true"))
    const result = runGate(root, "prepush")
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain("quiet box")
  })
})

describe("prepush clean-head receipt", () => {
  behaviorTest("clean run emits one complete machine-readable receipt", () => {
    const root = makeRepo(Array.from({ length: 21 }, () => "true"))
    const expectedHead = git(root, ["rev-parse", "HEAD"])

    const result = runGate(root, "prepush")
    const receipt = receiptFrom(result.stdout)

    expect(result.code).toBe(0)
    expect(receipt.status).toBe("passed")
    expect(receipt.head).toBe(expectedHead)
    expect(receipt.endHead).toBe(expectedHead)
    expect(receipt.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.snapshotStable).toBe(true)
    expect(receipt.startClean).toBe(true)
    expect(receipt.endClean).toBe(true)
    expect(receipt.gates).toHaveLength(21)
    expect(receipt.gates.every((gate) => gate.status === "passed" && gate.elapsedMs >= 0)).toBe(
      true,
    )
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  behaviorTest("a consumer placed BEFORE its producer refuses to run at all", () => {
    // `consumes` reports SKIP when the producer FAILED — but a consumer that
    // runs FIRST never sees a failure to react to. It reads whatever the
    // previous campaign left in .cache/ and reports a verdict over it, which
    // is the stale-input false green the mechanism exists to stop. Membership
    // was validated; sequence never was.
    const runs = Array.from({ length: 21 }, () => "printf spent >> spend.log")
    // gate-12 consumes gate-15, i.e. its producer runs three gates LATER.
    const root = makeRepo(runs, { 11: "gate-15" })

    const result = runGate(root, "prepush")

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("consume a producer that has not run yet")
    expect(result.stderr).toContain("gate-12 runs BEFORE")
    // Refused before spending anything — no gate executed.
    expect(existsSync(join(root, "spend.log"))).toBe(false)
  })

  behaviorTest("a consumer placed AFTER its producer is accepted", () => {
    const runs = Array.from({ length: 21 }, () => "true")
    const root = makeRepo(runs, { 15: "gate-12" })
    expect(runGate(root, "prepush").code).toBe(0)
  })

  behaviorTest("dirty start fails before spending gate 1", () => {
    const spend = "printf spent >> spend.log"
    const root = makeRepo(Array.from({ length: 21 }, () => spend))
    writeFileSync(join(root, "dirty.txt"), "dirty\n")

    const result = runGate(root, "prepush")
    const receipt = receiptFrom(result.stdout)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("refusing before gate 1")
    expect(existsSync(join(root, "spend.log"))).toBe(false)
    expect(receipt.status).toBe("invalid")
    expect(receipt.startClean).toBe(false)
    expect(receipt.gates.every((gate) => gate.status === "not_run")).toBe(true)
  })

  behaviorTest("tracked status drift invalidates an otherwise green gate set", () => {
    const runs = Array.from({ length: 21 }, () => "true")
    runs[0] = "printf drift >> tracked.txt"
    const root = makeRepo(runs)

    const result = runGate(root, "prepush")
    const receipt = receiptFrom(result.stdout)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("prepush: INVALID")
    expect(receipt.status).toBe("invalid")
    expect(receipt.snapshotStable).toBe(false)
    expect(receipt.head).toBe(receipt.endHead)
    expect(receipt.endClean).toBe(false)
    expect(receipt.gates.every((gate) => gate.status === "passed")).toBe(true)
  })

  behaviorTest("HEAD drift invalidates a clean ending tree", () => {
    const runs = Array.from({ length: 21 }, () => "true")
    runs[0] = "git commit --allow-empty -qm drift"
    const root = makeRepo(runs)

    const result = runGate(root, "prepush")
    const receipt = receiptFrom(result.stdout)

    expect(result.code).toBe(1)
    expect(receipt.status).toBe("invalid")
    expect(receipt.snapshotStable).toBe(false)
    expect(receipt.head).not.toBe(receipt.endHead)
    expect(receipt.endClean).toBe(true)
  })

  behaviorTest(
    "--bail still stops after the first failed gate and receipts the remainder as not-run",
    () => {
      const runs = Array.from({ length: 21 }, () => "printf spent >> spend.log")
      runs[0] = "false"
      const root = makeRepo(runs)

      const result = runGate(root, "prepush", ["--bail"])
      const receipt = receiptFrom(result.stdout)

      expect(result.code).toBe(1)
      expect(existsSync(join(root, "spend.log"))).toBe(false)
      expect(receipt.status).toBe("failed")
      expect(receipt.gates[0]?.status).toBe("failed")
      expect(receipt.gates.slice(1).every((gate) => gate.status === "not_run")).toBe(true)
    },
  )

  behaviorTest(
    "a same-head rerun executes every gate again instead of reusing the prior receipt",
    () => {
      const runs = Array.from({ length: 21 }, () => "true")
      runs[0] = "printf x >> .git/gate-count"
      const root = makeRepo(runs)

      const first = runGate(root, "prepush")
      const second = runGate(root, "prepush")

      expect(first.code).toBe(0)
      expect(second.code).toBe(0)
      expect(receiptFrom(first.stdout).status).toBe("passed")
      expect(receiptFrom(second.stdout).status).toBe("passed")
      expect(readFileSync(join(root, ".git", "gate-count"), "utf8")).toBe("xx")
    },
  )

  behaviorTest("--reuse-receipt skips every gate only behind a green same-state run", () => {
    const runs = Array.from({ length: 21 }, () => "true")
    runs[0] = "printf x >> .git/gate-count"
    const root = makeRepo(runs)

    // Cold: no receipt exists — every gate runs, then the receipt is minted.
    const first = runGate(root, "prepush", ["--reuse-receipt"])
    expect(first.code).toBe(0)
    expect(first.stdout).toContain("receipt not reusable")
    expect(first.stdout).toContain("exact receipt stored")

    // Warm same state: zero gates execute.
    const second = runGate(root, "prepush", ["--reuse-receipt"])
    expect(second.code).toBe(0)
    expect(second.stdout).toContain("REUSED exact receipt")
    expect(readFileSync(join(root, ".git", "gate-count"), "utf8")).toBe("x")

    // HEAD drift: the receipt is content-bound, so the gates run again.
    git(root, ["commit", "--allow-empty", "-qm", "drift"])
    const third = runGate(root, "prepush", ["--reuse-receipt"])
    expect(third.code).toBe(0)
    expect(third.stdout).toContain("receipt not reusable")
    expect(readFileSync(join(root, ".git", "gate-count"), "utf8")).toBe("xx")
  })

  behaviorTest("a red run destroys the green receipt for the SAME state", () => {
    // The gate goes red on a file under .git — untracked, so the checkout stays
    // clean and both runs describe the identical state. That is the case the
    // delete exists for: a receipt that WOULD validate, superseded by a run
    // that failed.
    const runs = Array.from({ length: 21 }, () => "true")
    runs[18] = "test ! -f .git/make-me-red"
    const root = makeRepo(runs)
    expect(runGate(root, "prepush", ["--reuse-receipt"]).code).toBe(0)
    expect(existsSync(verificationReceiptPath(root))).toBe(true)

    writeFileSync(join(root, ".git", "make-me-red"), "")
    const red = runGate(root, "prepush")
    expect(red.code).toBe(1)
    expect(existsSync(verificationReceiptPath(root))).toBe(false)
  })

  behaviorTest("a checkout it cannot read is not a licence to delete", () => {
    // END-TO-END, and labelled for what it does and does not show: it proves a
    // run that cannot read the checkout leaves the receipt alone. It does NOT
    // discriminate the fail-closed `catch` on its own — with a HEAD this
    // broken, the receipt PATH is derived from git too, so an injected
    // fail-open deletes something else and this case still passes. The reason
    // the catch returns false stands on its own: a stale receipt is rejected by
    // validation on the way in, while a deleted one costs whoever earned it a
    // full campaign.
    const root = makeRepo(Array.from({ length: 21 }, () => "true"))
    expect(runGate(root, "prepush", ["--reuse-receipt"]).code).toBe(0)
    const receipt = verificationReceiptPath(root)
    const before = readFileSync(receipt, "utf8")

    // A HEAD git cannot resolve: `gitSnapshot()` throws, and the receipt file
    // itself is still perfectly readable.
    writeFileSync(join(root, ".git", "HEAD"), "not a ref\n")
    const confused = runGate(root, "prepush")
    expect(confused.code).not.toBe(0)
    expect(existsSync(receipt), "a run that could not read the checkout deleted it").toBe(true)
    expect(readFileSync(receipt, "utf8")).toBe(before)
  })

  behaviorTest("a red run does NOT destroy a receipt for a DIFFERENT state", () => {
    // The cache is shared by every worktree of the repository — one git
    // common-dir, by design. The delete used to be unconditional, so a prepush
    // from a checkout carrying any uncommitted file threw away a green another
    // checkout had just earned, while being unable to mint a replacement
    // (minting requires a clean status). MEASURED: `git push` from a working
    // copy dirty with one unrelated file discarded a 21-of-21 receipt earned
    // minutes earlier in a pristine worktree, and started the 45 minutes again.
    const root = makeRepo(Array.from({ length: 21 }, () => "true"))
    expect(runGate(root, "prepush", ["--reuse-receipt"]).code).toBe(0)
    const receipt = verificationReceiptPath(root)
    expect(existsSync(receipt)).toBe(true)
    const before = readFileSync(receipt, "utf8")

    // A dirty checkout at the same HEAD: it cannot match this receipt, cannot
    // mint one, and must not delete one.
    writeFileSync(join(root, "tracked.txt"), "locally modified\n")
    const dirty = runGate(root, "prepush")
    expect(dirty.code).not.toBe(0)
    expect(existsSync(receipt), "a dirty peer deleted a clean checkout's green").toBe(true)
    expect(readFileSync(receipt, "utf8")).toBe(before)
  })

  behaviorTest(
    "precommit keeps its existing dirty-tree behavior and emits no prepush receipt",
    () => {
      const root = makeRepo(Array.from({ length: 21 }, () => "true"))
      writeFileSync(join(root, "dirty.txt"), "dirty\n")

      const result = runGate(root, "precommit")

      expect(result.code).toBe(0)
      expect(result.stdout).toContain("precommit: ok — 10 of 10 gate(s) passed")
      expect(result.stdout).not.toContain('"schema":"quanta.gate-receipt.v1"')
    },
  )
})
