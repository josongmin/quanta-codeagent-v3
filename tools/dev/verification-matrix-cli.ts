#!/usr/bin/env bun
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { discoverSuiteFiles } from "./test-shard-discovery"
import { planTestChunks } from "./test-shard-plan"
import {
  aggregateMatrixReceipts,
  planVerificationMatrix,
  workerReceipt,
} from "./verification-matrix"

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const command = process.argv[2] ?? "plan"

if (command === "plan") {
  const files = discoverSuiteFiles(repoRoot, "full")
  const chunks = planTestChunks(files)
  const plan = planVerificationMatrix(
    chunks.map((chunk) => ({
      id: `${chunk.resourceClass}:${chunk.index}`,
      files: chunk.files,
    })),
  )
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  process.exit(0)
}

if (command === "aggregate") {
  const expectedRaw = process.env.QUANTA_MATRIX_EXPECTED
  const receiptsRaw = process.env.QUANTA_MATRIX_RECEIPTS
  const expected =
    expectedRaw === undefined || expectedRaw === ""
      ? []
      : (JSON.parse(expectedRaw) as { id: string; files: string[] }[])
  const receipts =
    receiptsRaw === undefined || receiptsRaw === ""
      ? []
      : (JSON.parse(receiptsRaw) as Parameters<typeof workerReceipt>[0][])
  const verdict = aggregateMatrixReceipts({
    expected,
    receipts: receipts.map((row) => workerReceipt(row)),
  })
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`)
  process.exit(verdict.verdict === "passed" ? 0 : 1)
}

if (command === "worker") {
  const chunkId = process.env.QUANTA_MATRIX_CHUNK_ID ?? "none"
  const filesRaw = process.env.QUANTA_MATRIX_CHUNK_FILES
  const files = filesRaw === undefined || filesRaw === "" ? [] : (JSON.parse(filesRaw) as string[])
  process.stdout.write(
    `${JSON.stringify(
      workerReceipt({
        chunkId,
        files,
        outcome: files.length === 0 ? "cancelled" : "passed",
      }),
      null,
      2,
    )}\n`,
  )
  process.exit(0)
}

process.stderr.write(`usage: verification-matrix-cli.ts plan|worker|aggregate\n`)
process.exit(2)
