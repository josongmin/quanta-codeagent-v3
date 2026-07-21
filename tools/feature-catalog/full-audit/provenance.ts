import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { LoadedFeature } from "../schema"
import type { AuditInputDigests } from "./schema"

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")

export interface CatalogInput {
  readonly path: string
  readonly content: string
}

export interface AuditInputContents {
  readonly catalog: readonly CatalogInput[]
  readonly defaultOffLedger: string
  readonly baseline: string
}

/**
 * Digest paths together with raw YAML so renames, additions, removals, and
 * content changes all invalidate a frozen audit snapshot.
 */
export const digestAuditInputs = (inputs: AuditInputContents): AuditInputDigests => {
  const catalog = [...inputs.catalog]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path, content }) => [path, content] as const)
  return {
    catalog_yaml: sha256(JSON.stringify(catalog)),
    default_off_ledger: sha256(inputs.defaultOffLedger),
    baseline: sha256(inputs.baseline),
  }
}

export const readAuditInputDigests = async (
  root: string,
  features: readonly LoadedFeature[],
  defaultOffLedgerPath: string,
  baselinePath: string,
): Promise<AuditInputDigests> => {
  const catalog = await Promise.all(
    features.map(async ({ path }) => ({ path, content: await readFile(join(root, path), "utf8") })),
  )
  const [defaultOffLedger, baseline] = await Promise.all([
    readFile(defaultOffLedgerPath, "utf8"),
    readFile(baselinePath, "utf8"),
  ])
  return digestAuditInputs({ catalog, defaultOffLedger, baseline })
}
