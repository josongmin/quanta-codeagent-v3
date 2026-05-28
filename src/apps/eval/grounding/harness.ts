import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GROUNDING_HARNESS_CONTRACT } from "./schema"
import { shortHash, stableJson } from "./stable-json"

const HARNESS_SOURCE_FILES = [
  "compare.ts",
  "config.ts",
  "execution-contract.ts",
  "file-context.ts",
  "harness.ts",
  "loader.ts",
  "normalizer.ts",
  "normalization/heuristic.ts",
  "normalization/structural.ts",
  "parser.ts",
  "probe.ts",
  "replay-scaffold.ts",
  "referent-context.ts",
  "report.ts",
  "route-matrix.ts",
  "schema.ts",
  "scorer.ts",
  "stable-json.ts",
] as const

const sourceHash = (file: string): string =>
  createHash("sha256")
    .update(readFileSync(join(import.meta.dir, file), "utf8").replaceAll("\r\n", "\n"))
    .digest("hex")

export const buildGroundingHarnessManifest = () => ({
  contract: GROUNDING_HARNESS_CONTRACT,
  sourceFiles: HARNESS_SOURCE_FILES.map((file) => ({
    file,
    sha256: sourceHash(file),
  })),
})

export const groundingHarnessFingerprint = (): string =>
  shortHash(stableJson(buildGroundingHarnessManifest()))
