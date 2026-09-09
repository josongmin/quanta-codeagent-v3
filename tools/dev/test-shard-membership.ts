import { createHash } from "node:crypto"
import type { TestResourceClass } from "./test-shard-plan"

export interface MembershipConfig {
  readonly version: "v1"
  readonly algorithm: "sha256-mod"
  readonly bucketsByClass: Readonly<Record<TestResourceClass, number>>
}

export const DEFAULT_MEMBERSHIP: MembershipConfig = {
  version: "v1",
  algorithm: "sha256-mod",
  bucketsByClass: {
    pure: 24,
    worktree: 2,
    "repo-write": 1,
    browser: 1,
    lsp: 4,
    port: 2,
    "process-global": 2,
    "integration-path": 8,
  },
}

const bucketIndex = (file: string, buckets: number): number => {
  const digest = createHash("sha256").update(file).digest()
  const n = digest.readUInt32BE(0)
  return n % Math.max(1, buckets)
}

export const bucketForFile = (
  file: string,
  resourceClass: TestResourceClass,
  config: MembershipConfig = DEFAULT_MEMBERSHIP,
): { readonly class: TestResourceClass; readonly bucket: number } => ({
  class: resourceClass,
  bucket: bucketIndex(file, config.bucketsByClass[resourceClass]),
})

export interface MembershipManifest {
  readonly version: string
  readonly algorithm: string
  readonly chunks: readonly {
    readonly id: string
    readonly resourceClass: TestResourceClass
    readonly files: readonly string[]
  }[]
  readonly digest: string
}

export const buildMembershipManifest = (
  files: readonly { readonly file: string; readonly resourceClass: TestResourceClass }[],
  config: MembershipConfig = DEFAULT_MEMBERSHIP,
): MembershipManifest => {
  const groups = new Map<string, string[]>()
  for (const row of files) {
    const { class: resourceClass, bucket } = bucketForFile(row.file, row.resourceClass, config)
    const id = `${resourceClass}:${bucket}`
    const group = groups.get(id)
    if (group === undefined) groups.set(id, [row.file])
    else group.push(row.file)
  }
  const chunks = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, members]) => ({
      id,
      resourceClass: id.split(":")[0] as TestResourceClass,
      files: [...members].sort((a, b) => a.localeCompare(b)),
    }))
  const assigned = chunks.flatMap((chunk) => chunk.files)
  if (assigned.length !== files.length || new Set(assigned).size !== files.length) {
    throw new Error("membership is not an exact partition")
  }
  const digest = createHash("sha256")
    .update(JSON.stringify({ version: config.version, algorithm: config.algorithm, chunks }))
    .digest("hex")
  return { version: config.version, algorithm: config.algorithm, chunks, digest }
}

export const membershipDigest = (manifest: MembershipManifest): string => manifest.digest
