#!/usr/bin/env bun
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { availableParallelism, loadavg } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runBoundedChild } from "./bounded-child"
import { executedFileSetVerdict } from "./executed-file-set"
import { scanReachMembershipSha256 } from "./scan-reach-authority"
import {
  loadPolicyOverrides,
  policyDigest,
  resolveTestPopulation,
  selectTestPoliciesForTier,
} from "./test-policy"
import { discoverSuiteFiles } from "./test-shard-discovery"
import {
  chooseIntraWorkerParallelism,
  chooseShardTestTimeoutMs,
  planTestChunks,
} from "./test-shard-plan"
import { testToolchainSha256 } from "./test-shard-receipt"
import { junitExecutedFiles, loadTestTimings } from "./test-shard-timings"
import {
  aggregateMatrixReceipts,
  parseMatrixWorkerReceipt,
  parseVerificationMatrixPlan,
  planVerificationMatrix,
  workerReceipt,
} from "./verification-matrix"
import { sharedVerificationCacheRoot } from "./verification-receipt"
import { assertKnownTier } from "./verification-tier"

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const timingStore = join(sharedVerificationCacheRoot(repoRoot), "test-timings-v2.json")
const policyOverrides = join(repoRoot, "tools/dev/test-policy-overrides.json")
const command = process.argv[2] ?? "plan"
const args = process.argv.slice(3)

const valueArg = (name: string): string | undefined => {
  const prefix = `${name}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

/** Present-or-absent, unlike requiredArg: an omitted comparison is not an error. */
const optionalArg = (name: string): string | undefined => {
  const value = valueArg(name)
  return value === undefined || value === "" ? undefined : value
}

const requiredArg = (name: string): string => {
  const value = valueArg(name)
  if (value === undefined || value === "") throw new Error(`missing ${name}=...`)
  return value
}

const sha256 = (bytes: string | Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

const writeJsonAtomic = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, path)
}

const captureGit = async (args: readonly string[]): Promise<string> => {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`)
  return stdout
}

const cleanGitHead = async (): Promise<string> => {
  const [head, status] = await Promise.all([
    captureGit(["rev-parse", "HEAD"]),
    captureGit(["status", "--porcelain"]),
  ])
  if (status !== "") throw new Error("matrix execution requires a clean exact-HEAD checkout")
  return head.trim()
}

const safeArtifactStem = (chunkId: string): string => {
  if (!/^[a-z0-9-]+$/i.test(chunkId)) throw new Error(`unsafe matrix chunk id: ${chunkId}`)
  return chunkId
}

if (command === "plan") {
  const headSha = await cleanGitHead()
  // REQUIRED, never the literal it used to be. The planner hardcoded "full"
  // while the monolith ran `QUANTA_VERIFICATION_TIER: pr` — 3,951 files against
  // 3,941 — so a verdict-equality claim between the two was not a statement
  // that could ever be true.
  // Validated against the closed tier union, so a typo is a named refusal
  // rather than a plan that selects nothing and aggregates to green.
  const tier = assertKnownTier(requiredArg("--tier"))
  const discoveredFiles = discoverSuiteFiles(repoRoot, "full")
  const policies = resolveTestPopulation(
    discoveredFiles.map((file) => relative(repoRoot, file)),
    loadPolicyOverrides(policyOverrides).overrides,
  )
  const selectedIds = new Set(selectTestPoliciesForTier(policies, tier).map(({ id }) => id))
  const files = discoveredFiles.filter((file) => selectedIds.has(relative(repoRoot, file)))
  const timings = loadTestTimings(timingStore)
  const cpuCount = availableParallelism()
  const loadAverage1m = loadavg()[0] ?? 0
  const pressure = Math.max(1, Math.ceil(loadAverage1m / Math.max(1, cpuCount * 2)))
  const testTimeoutMs = chooseShardTestTimeoutMs({ loadAverage1m, cpuCount })
  const chunks = planTestChunks(files, {
    predictMs: (file) => timings.get(relative(repoRoot, file)),
    membershipFile: (file) => relative(repoRoot, file),
  })
  const population = {
    tier,
    universe: discoveredFiles.length,
    membershipSha256: scanReachMembershipSha256(repoRoot, [...selectedIds]),
    policySha256: policyDigest(policies),
    capabilitySha256: testToolchainSha256(),
  }
  const plan = planVerificationMatrix(
    headSha,
    population,
    chunks.map((chunk) => ({
      id: `${chunk.resourceClass}-${chunk.index}`,
      files: chunk.files.map((file) => relative(repoRoot, file)),
      resourceClass: chunk.resourceClass,
      predictedMs: chunk.predictedMs,
      testTimeoutMs,
      intraParallel: chooseIntraWorkerParallelism({
        resourceClass: chunk.resourceClass,
        cpuCount,
        workers: 1,
        pressure,
      }),
    })),
  )
  const out = resolve(repoRoot, valueArg("--out") ?? ".cache/verification-matrix/plan.json")
  writeJsonAtomic(out, plan)
  const githubOutput = valueArg("--github-output")
  if (githubOutput !== undefined) {
    const launchOrder = [...plan.chunks]
      .sort(
        (left, right) => right.predictedMs - left.predictedMs || left.id.localeCompare(right.id),
      )
      .map((chunk) => chunk.id)
    appendFileSync(githubOutput, `chunks=${JSON.stringify(launchOrder)}\n`)
    appendFileSync(githubOutput, `plan_sha256=${plan.planSha256}\n`)
  }
  process.stdout.write(
    `${JSON.stringify({ path: relative(repoRoot, out), headSha: plan.headSha, planSha256: plan.planSha256, chunks: plan.chunks.length }, null, 2)}\n`,
  )
  process.exit(0)
}

if (command === "aggregate") {
  const plan = parseVerificationMatrixPlan(JSON.parse(readFileSync(requiredArg("--plan"), "utf8")))
  // The shadow matrix exists to be compared against the monolith. A plan built
  // for a different tier cannot be that comparison, and before the plan carried
  // a tier at all nothing could have said so — the planner hardcoded "full"
  // while the monolith ran "pr", 3,951 files against 3,941.
  const expectTier = optionalArg("--expect-tier")
  if (expectTier !== undefined && plan.population.tier !== expectTier) {
    throw new Error(
      `[matrix] plan tier "${plan.population.tier}" is not the "${expectTier}" this ` +
        "aggregation was asked to compare; refusing to report an equality that cannot hold",
    )
  }
  const receiptsDir = requiredArg("--receipts")
  const receiptPaths = readdirSync(receiptsDir)
    .filter((name) => name.endsWith(".receipt.json"))
    .map((name) => join(receiptsDir, name))
    .sort()
  const receipts = receiptPaths.map((path) =>
    parseMatrixWorkerReceipt(JSON.parse(readFileSync(path, "utf8"))),
  )
  const junitDigests = new Map<string, string>()
  for (const receipt of receipts) {
    const junitPath = join(receiptsDir, receipt.junitFile)
    if (existsSync(junitPath)) junitDigests.set(receipt.junitFile, sha256(readFileSync(junitPath)))
  }
  const verdict = aggregateMatrixReceipts({
    plan,
    receipts,
    junitDigests,
  })
  const out = valueArg("--out")
  if (out !== undefined) writeJsonAtomic(out, verdict)
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`)
  process.exit(verdict.verdict === "passed" ? 0 : 1)
}

if (command === "worker") {
  const plan = parseVerificationMatrixPlan(JSON.parse(readFileSync(requiredArg("--plan"), "utf8")))
  const currentHead = await cleanGitHead()
  if (currentHead !== plan.headSha) throw new Error(`matrix worker HEAD mismatch`)
  const chunkId = requiredArg("--chunk")
  const chunk = plan.chunks.find((candidate) => candidate.id === chunkId)
  if (chunk === undefined) throw new Error(`unknown matrix chunk: ${chunkId}`)
  const stem = safeArtifactStem(chunk.id)
  const outDir = resolve(repoRoot, requiredArg("--out-dir"))
  mkdirSync(outDir, { recursive: true })
  const junitFile = `${stem}.junit.xml`
  const junitPath = join(outDir, junitFile)
  const receiptPath = join(outDir, `${stem}.receipt.json`)
  const startedAt = performance.now()
  // `await proc.exited` with no deadline: a matrix worker that wedged held its
  // runner slot until the hosted job's own limit killed the whole thing, which
  // reports as "the job timed out" and names no chunk. Bounded through the
  // same primitive as the gate runner and the pollution guard, so the three
  // rails cannot drift in what "bounded" means.
  const outcome = await runBoundedChild({
    cmd: [
      "bun",
      "test",
      ...chunk.files,
      `--timeout=${chunk.testTimeoutMs}`,
      `--parallel=${chunk.intraParallel}`,
      "--bail=1",
      "--reporter=junit",
      `--reporter-outfile=${junitPath}`,
    ],
    cwd: repoRoot,
    env: { ...process.env, QUANTA_TEST_CACHE: "off" },
    // A chunk's OWN per-case timeout is `chunk.testTimeoutMs`; this is the
    // bound on the whole chunk, derived from it rather than picked: enough room
    // for every planned file to hit its individual ceiling, and not more.
    limits: {
      totalMs: Math.max(chunk.testTimeoutMs * Math.max(1, chunk.files.length), 10 * 60_000),
      inactivityMs: Math.max(chunk.testTimeoutMs * 2, 12 * 60_000),
    },
    onStdout: (text) => process.stdout.write(text),
    onStderr: (text) => process.stderr.write(text),
  })
  if (outcome.status === "timed-out") {
    process.stderr.write(
      `[matrix] chunk ${chunk.id} killed on the ${outcome.deadline ?? "unknown"} deadline ` +
        `after ${Math.round(outcome.elapsedMs / 1_000)}s\n`,
    )
  }
  const code = outcome.exitCode ?? 1
  const elapsedMs = Math.max(1, Math.round(performance.now() - startedAt))
  const junitXml = existsSync(junitPath) ? readFileSync(junitPath, "utf8") : ""
  // One owner for "did it run what it was planned". The local shard runner
  // compared a COUNT until this helper existed; a sorted-join here and a
  // `length ===` there is how the two rails came to disagree.
  const executedSet = executedFileSetVerdict({
    repoRoot,
    plannedRaw: chunk.files,
    executedRaw: junitExecutedFiles(junitXml),
  })
  const executedFiles = executedSet.executed
  const exactExecutedSet = executedSet.ok
  if (!exactExecutedSet) {
    process.stderr.write(`[matrix] executed-set mismatch ${chunk.id}: ${executedSet.reason}\n`)
  }
  const junitOk = junitXml.includes("<testcase") && executedFiles.length > 0
  let snapshotStable = false
  try {
    snapshotStable = (await cleanGitHead()) === plan.headSha
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[matrix] checkout changed during ${chunk.id}: ${message}\n`)
  }
  const receipt = workerReceipt({
    headSha: plan.headSha,
    planSha256: plan.planSha256,
    chunkId: chunk.id,
    plannedFiles: chunk.files,
    executedFiles,
    executedDigestSha256: executedSet.digestSha256,
    testTimeoutMs: chunk.testTimeoutMs,
    intraParallel: chunk.intraParallel,
    outcome: code === 0 && junitOk && exactExecutedSet && snapshotStable ? "passed" : "failed",
    snapshotStable,
    junitFile,
    ...(junitOk ? { junitSha256: sha256(readFileSync(junitPath)) } : {}),
  })
  writeJsonAtomic(receiptPath, receipt)
  process.stdout.write(`${JSON.stringify({ ...receipt, elapsedMs }, null, 2)}\n`)
  process.exit(receipt.outcome === "passed" ? 0 : code === 0 ? 1 : code)
}

process.stderr.write(
  "usage: verification-matrix-cli.ts plan [--out=PATH] [--github-output=PATH] | " +
    "worker --plan=PATH --chunk=ID --out-dir=DIR | " +
    "aggregate --plan=PATH --receipts=DIR [--out=PATH]\n",
)
process.exit(2)
