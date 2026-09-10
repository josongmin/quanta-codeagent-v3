#!/usr/bin/env bun
import { readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import {
  auditResourceCertifications,
  certificationDigest,
  loadTestResourceCertifications,
} from "./test-resource-certification"
import { discoverSuiteFiles } from "./test-shard-discovery"
import { classifyTestResource } from "./test-shard-plan"

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const REGISTRY = join(REPO_ROOT, "tools/dev/test-resource-certifications.json")
const INTEGRATION_PATH_FLOOR = 500

const certifications = loadTestResourceCertifications(REGISTRY).certifications
const integrationPathFiles = discoverSuiteFiles(REPO_ROOT, "full")
  .filter((file) => classifyTestResource(file) === "integration-path")
  .map((file) => ({ testId: relative(REPO_ROOT, file), source: readFileSync(file, "utf8") }))

if (integrationPathFiles.length < INTEGRATION_PATH_FLOOR) {
  throw new Error(
    `resource audit reached ${integrationPathFiles.length} integration-path files, below floor ${INTEGRATION_PATH_FLOOR}`,
  )
}

const rows = auditResourceCertifications(integrationPathFiles, certifications)
const counts = rows.reduce<Record<string, number>>((result, row) => {
  result[row.status] = (result[row.status] ?? 0) + 1
  return result
}, {})
const output = {
  schema: "quanta.test-resource-certification-audit.v1",
  population: rows.length,
  certificationDigest: certificationDigest(certifications),
  counts,
  rows,
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)

if (
  process.argv.includes("--check") &&
  rows.some(({ status }) => status === "missing" || status === "source-drift")
) {
  process.exitCode = 1
}
