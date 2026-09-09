#!/usr/bin/env bun
import {
  aggregateMatrixReceipts,
  planVerificationMatrix,
  workerReceipt,
} from "./verification-matrix"

const command = process.argv[2] ?? "plan"
if (command === "plan") {
  process.stdout.write(`${JSON.stringify(planVerificationMatrix([]), null, 2)}\n`)
  process.exit(0)
}
if (command === "aggregate") {
  const verdict = aggregateMatrixReceipts({ expected: [], receipts: [] })
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`)
  process.exit(verdict.verdict === "passed" ? 0 : 1)
}
if (command === "worker") {
  process.stdout.write(
    `${JSON.stringify(workerReceipt({ chunkId: "none", files: [], outcome: "cancelled" }), null, 2)}\n`,
  )
  process.exit(0)
}
process.stderr.write(`usage: verification-matrix-cli.ts plan|worker|aggregate\n`)
process.exit(2)
