/**
 * TB21-03 / TB21-01 — HELLGATE for `quanta-bench terminal doctor`.
 *
 * ⚠️ NO REAL TOOLING RUNS HERE. Every external probe (git, bun, python, uv,
 * harbor, docker, the brain shim, the agent import) goes through an INJECTED
 * `run` port. A doctor that shelled out for real would (a) need Docker on a CI
 * box and (b) be unable to prove the FAILURE arms at all.
 *
 * The load-bearing observables are: which checks exist, whether a required
 * failure produces a non-zero exit, and — the security rail — that neither the
 * checks nor the rendered receipt can leak a credential VALUE or the environment.
 */
import { describe, expect, test } from "bun:test"
import {
  formatDoctorReceipt,
  REQUIRED_DOCTOR_CHECKS,
  runTerminalDoctor,
  type DoctorPorts,
} from "./doctor"
import { TERMINAL_BENCH_DATASET, TERMINAL_BENCH_DATASET_REF } from "./dataset"

const SECRET = "sk-live-DOCTOR-MUST-NOT-PRINT-9876"

const OK_RUNS: Readonly<Record<string, { code: number; stdout: string; stderr: string }>> = {
  "git rev-parse HEAD": { code: 0, stdout: "9d5369d310bba9cf\n", stderr: "" },
  "git status --porcelain": { code: 0, stdout: "", stderr: "" },
  "bun --version": { code: 0, stdout: "1.3.0\n", stderr: "" },
  "python3 --version": { code: 0, stdout: "Python 3.13.1\n", stderr: "" },
  "uv --version": { code: 0, stdout: "uv 0.9.2\n", stderr: "" },
  harbor: { code: 0, stdout: "harbor 0.21.0\n", stderr: "" },
  "docker --version": { code: 0, stdout: "Docker version 27.0.3\n", stderr: "" },
  "docker info": { code: 0, stdout: "Server Version: 27.0.3\n", stderr: "" },
  "agent-import": {
    code: 0,
    stdout: JSON.stringify({
      module: "quanta_agent",
      klass: "QuantaAgent",
      isBaseAgentSubclass: true,
      abstractMethods: [],
      supportsAtif: true,
    }),
    stderr: "",
  },
  brain: { code: 0, stdout: "quanta-terminal-brain 1.0.025\n", stderr: "" },
}

/** Classify a spawn into one of the OK_RUNS keys — the fake's whole job. */
const classify = (bin: string, args: readonly string[]): string => {
  const line = [bin, ...args].join(" ")
  if (line.startsWith("git rev-parse")) return "git rev-parse HEAD"
  if (line.startsWith("git status")) return "git status --porcelain"
  if (line.startsWith("bun --version")) return "bun --version"
  if (/^python3? --version/.test(line)) return "python3 --version"
  if (line.startsWith("uv --version")) return "uv --version"
  if (line.includes("docker info")) return "docker info"
  if (line.includes("docker --version")) return "docker --version"
  if (line.includes("harbor")) return "harbor"
  if (line.includes("import quanta_agent") || line.includes("quanta_agent")) return "agent-import"
  return "brain"
}

const makePorts = (over: {
  readonly fail?: readonly string[]
  readonly stdout?: Readonly<Record<string, string>>
  readonly env?: NodeJS.ProcessEnv
  readonly canWrite?: boolean
} = {}): DoctorPorts => ({
  run: (bin, args) => {
    const key = classify(bin, args)
    const base = OK_RUNS[key] ?? { code: 0, stdout: "", stderr: "" }
    const stdout = over.stdout?.[key] ?? base.stdout
    return over.fail?.includes(key) === true
      ? { code: 1, stdout: "", stderr: `simulated ${key} failure` }
      : { ...base, stdout }
  },
  env: over.env ?? { OPENAI_API_KEY: SECRET, PATH: "/usr/bin" },
  canWriteDir: () => over.canWrite !== false,
})

const INPUT = {
  model: "gpt-5.5",
  provider: "openai" as const,
  effort: { requested: "xhigh", delivered: "xhigh", kind: "delivered" as const },
  sandbox: "docker" as const,
  outputRoot: "/tmp/tb-out",
}

describe("check inventory", () => {
  test("covers every required subject the ticket enumerates", () => {
    const report = runTerminalDoctor(makePorts(), INPUT)
    const ids = report.checks.map((c) => c.id)
    for (const id of REQUIRED_DOCTOR_CHECKS) expect(ids, `missing check ${id}`).toContain(id)
    // Anti-vacuity: this is a real inventory, not an empty floor.
    expect(REQUIRED_DOCTOR_CHECKS.length).toBeGreaterThanOrEqual(12)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("an all-green environment exits 0", () => {
    const report = runTerminalDoctor(makePorts(), INPUT)
    expect(report.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.exitCode).toBe(0)
  })

  test("the dataset check names the canonical dataset + pinned ref, never `latest`", () => {
    const report = runTerminalDoctor(makePorts(), INPUT)
    const check = report.checks.find((c) => c.id === "dataset-identity")
    expect(check?.ok).toBe(true)
    expect(check?.detail).toContain(TERMINAL_BENCH_DATASET)
    expect(check?.detail).toContain(TERMINAL_BENCH_DATASET_REF)
    expect(check?.detail).not.toContain("latest")
  })
})

describe("a required failure is non-zero — for EVERY required subject", () => {
  const FAILABLE: ReadonlyArray<{ readonly key: string; readonly check: string }> = [
    { key: "bun --version", check: "bun" },
    { key: "python3 --version", check: "python" },
    { key: "uv --version", check: "uv" },
    { key: "harbor", check: "harbor" },
    { key: "docker --version", check: "docker" },
    { key: "docker info", check: "docker-daemon" },
    { key: "agent-import", check: "agent-import" },
    { key: "brain", check: "brain-shim" },
  ]

  for (const f of FAILABLE) {
    test(`${f.check} failure ⇒ exit non-zero and that check is red`, () => {
      const report = runTerminalDoctor(makePorts({ fail: [f.key] }), INPUT)
      expect(report.checks.find((c) => c.id === f.check)?.ok, f.check).toBe(false)
      expect(report.ok).toBe(false)
      expect(report.exitCode).not.toBe(0)
    })
  }

  test("a NON-BaseAgent / abstract-open / ATIF-less agent each fail the import check", () => {
    for (const bad of [
      { module: "quanta_agent", klass: "QuantaAgent", isBaseAgentSubclass: false, abstractMethods: [], supportsAtif: true },
      { module: "quanta_agent", klass: "QuantaAgent", isBaseAgentSubclass: true, abstractMethods: ["version"], supportsAtif: true },
      { module: "quanta_agent", klass: "QuantaAgent", isBaseAgentSubclass: true, abstractMethods: [], supportsAtif: false },
    ]) {
      const report = runTerminalDoctor(
        makePorts({ stdout: { "agent-import": JSON.stringify(bad) } }),
        INPUT,
      )
      expect(report.checks.find((c) => c.id === "agent-import")?.ok, JSON.stringify(bad)).toBe(
        false,
      )
      expect(report.exitCode).not.toBe(0)
    }
  })

  test("a missing credential is red — but ONLY presence is checked", () => {
    const report = runTerminalDoctor(makePorts({ env: { PATH: "/usr/bin" } }), INPUT)
    const cred = report.checks.find((c) => c.id === "credentials")
    expect(cred?.ok).toBe(false)
    expect(report.exitCode).not.toBe(0)
  })

  test("an unwritable output root is red", () => {
    const report = runTerminalDoctor(makePorts({ canWrite: false }), INPUT)
    expect(report.checks.find((c) => c.id === "output-dir")?.ok).toBe(false)
  })

  test("a dirty worktree is REPORTED but does not fail the doctor", () => {
    const report = runTerminalDoctor(
      makePorts({ stdout: { "git status --porcelain": " M src/x.ts\n" } }),
      INPUT,
    )
    const dirty = report.checks.find((c) => c.id === "repo-dirty")
    expect(dirty?.required).toBe(false)
    expect(report.exitCode).toBe(0)
    expect(dirty?.detail).toMatch(/dirty|not promotable/i)
  })
})

describe("SECURITY — the doctor never prints credential values or the environment", () => {
  test("no check detail contains the secret VALUE, but the NAME is surfaced", () => {
    const report = runTerminalDoctor(makePorts(), INPUT)
    const blob = JSON.stringify(report)
    expect(blob).not.toContain(SECRET)
    expect(report.checks.find((c) => c.id === "credentials")?.detail).toContain("OPENAI_API_KEY")
  })

  test("the rendered receipt leaks neither the value nor unrelated env names", () => {
    const env = {
      OPENAI_API_KEY: SECRET,
      PATH: "/usr/bin",
      MY_PRIVATE_HOSTNAME: "internal.example",
    }
    const receipt = formatDoctorReceipt(runTerminalDoctor(makePorts({ env }), INPUT))
    expect(receipt).not.toContain(SECRET)
    expect(receipt).not.toContain("internal.example")
    expect(receipt).not.toContain("MY_PRIVATE_HOSTNAME")
    // Anti-vacuity: the receipt really did render the checks.
    expect(receipt).toContain("dataset-identity")
    expect(receipt).toContain("agent-import")
  })

  test("the repo-sha receipt is BOUNDED (a sha, not a log)", () => {
    const report = runTerminalDoctor(
      makePorts({ stdout: { "git rev-parse HEAD": `${"a".repeat(40)}\n${"x".repeat(5000)}` } }),
      INPUT,
    )
    const sha = report.checks.find((c) => c.id === "repo-sha")
    expect(sha?.detail.length).toBeLessThan(120)
  })
})
