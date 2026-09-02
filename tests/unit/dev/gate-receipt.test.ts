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

const manifestSource = (runs: readonly string[]): string => {
  const entries = runs.map((run, index) => ({
    id: `gate-${index + 1}`,
    stage: index < 10 ? "precommit" : "prepush",
    run,
    why: `behavioral fixture gate ${index + 1}`,
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
}
export const GATES: readonly Gate[] = ${JSON.stringify(entries, null, 2)}
export const gatesForStage = (stage: GateStage): readonly Gate[] =>
  stage === "precommit" ? GATES.filter((gate) => gate.stage === "precommit") : GATES
`
}

const makeRepo = (runs: readonly string[]): string => {
  const root = mkdtempSync(join(tmpdir(), "quanta-gate-receipt-"))
  roots.push(root)
  mkdirSync(join(root, "tools", "dev"), { recursive: true })
  copyFileSync(SOURCE_GATE, join(root, "tools", "dev", "gate.ts"))
  for (const dependency of [
    "verification-receipt.ts",
    "verification-receipt-probe.ts",
    "external-toolchain.ts",
    "verdict-env.ts",
  ]) {
    copyFileSync(join(SOURCE_DIR, dependency), join(root, "tools", "dev", dependency))
  }
  writeFileSync(join(root, "tools", "dev", "gate-manifest.ts"), manifestSource(runs))
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
): { readonly code: number; readonly stdout: string; readonly stderr: string } => {
  const proc = Bun.spawnSync(
    [process.execPath, join(root, "tools", "dev", "gate.ts"), stage, "--quiet", ...extraArgs],
    {
      cwd: root,
      env: cleanGitEnv(),
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

  behaviorTest("a red run destroys the previous green exact receipt", () => {
    const runs = Array.from({ length: 21 }, () => "true")
    const root = makeRepo(runs)
    const first = runGate(root, "prepush", ["--reuse-receipt"])
    expect(first.code).toBe(0)
    expect(existsSync(verificationReceiptPath(root))).toBe(true)

    // Break one prepush gate, then run WITHOUT reuse: the stale green receipt
    // must be deleted before gate 1 so a later --reuse-receipt cannot resurrect it.
    const broken = Array.from({ length: 21 }, () => "true")
    broken[18] = "false"
    writeFileSync(join(root, "tools", "dev", "gate-manifest.ts"), manifestSource(broken))
    git(root, ["add", "."])
    git(root, ["commit", "-qm", "break gate"])
    const red = runGate(root, "prepush")
    expect(red.code).toBe(1)
    expect(existsSync(verificationReceiptPath(root))).toBe(false)
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
