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
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { discoverSuiteFiles } from "./test-shard-discovery"
import { planTestChunks } from "./test-shard-plan"
import {
  aggregateMatrixReceipts,
  parseMatrixWorkerReceipt,
  parseVerificationMatrixPlan,
  planVerificationMatrix,
  workerReceipt,
} from "./verification-matrix"

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const command = process.argv[2] ?? "plan"
const args = process.argv.slice(3)

const valueArg = (name: string): string | undefined => {
  const prefix = `${name}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
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
  const files = discoverSuiteFiles(repoRoot, "full")
  const chunks = planTestChunks(files)
  const plan = planVerificationMatrix(
    headSha,
    chunks.map((chunk) => ({
      id: `${chunk.resourceClass}-${chunk.index}`,
      files: chunk.files.map((file) => relative(repoRoot, file)),
    })),
  )
  const out = resolve(repoRoot, valueArg("--out") ?? ".cache/verification-matrix/plan.json")
  writeJsonAtomic(out, plan)
  const githubOutput = valueArg("--github-output")
  if (githubOutput !== undefined) {
    appendFileSync(githubOutput, `chunks=${JSON.stringify(plan.chunks.map((chunk) => chunk.id))}\n`)
    appendFileSync(githubOutput, `plan_sha256=${plan.planSha256}\n`)
  }
  process.stdout.write(
    `${JSON.stringify({ path: relative(repoRoot, out), headSha: plan.headSha, planSha256: plan.planSha256, chunks: plan.chunks.length }, null, 2)}\n`,
  )
  process.exit(0)
}

if (command === "aggregate") {
  const plan = parseVerificationMatrixPlan(JSON.parse(readFileSync(requiredArg("--plan"), "utf8")))
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
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "test",
      ...chunk.files,
      "--timeout=60000",
      "--parallel=1",
      "--bail=1",
      "--reporter=junit",
      `--reporter-outfile=${junitPath}`,
    ],
    cwd: repoRoot,
    env: { ...process.env, QUANTA_TEST_CACHE: "off" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await proc.exited
  const junitOk = existsSync(junitPath) && readFileSync(junitPath, "utf8").includes("<testcase")
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
    files: chunk.files,
    outcome: code === 0 && junitOk && snapshotStable ? "passed" : "failed",
    snapshotStable,
    junitFile,
    ...(junitOk ? { junitSha256: sha256(readFileSync(junitPath)) } : {}),
  })
  writeJsonAtomic(receiptPath, receipt)
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  process.exit(receipt.outcome === "passed" ? 0 : code === 0 ? 1 : code)
}

process.stderr.write(
  "usage: verification-matrix-cli.ts plan [--out=PATH] [--github-output=PATH] | " +
    "worker --plan=PATH --chunk=ID --out-dir=DIR | " +
    "aggregate --plan=PATH --receipts=DIR [--out=PATH]\n",
)
process.exit(2)
