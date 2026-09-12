import { readFileSync } from "node:fs"
import { join } from "node:path"
import { hostCapabilityFingerprint } from "./external-toolchain"
import { CAPABILITY_GROUPS } from "./test-capability-manifest"
import {
  resolveResourceCertification,
  type TestResourceCertification,
} from "./test-resource-certification"
import { toolScopeSha256 } from "./test-shard-receipt"
import {
  certifyDeclaredInputs,
  declaredInputOptIn,
  runnerBaseScopeSha256,
  WHOLE_TREE_INPUT_SCOPE_SHA256,
} from "./verification-input-scope"

const digestOf = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex")

/**
 * The interpreter is not an optional capability: every chunk runs on it, and
 * `EXTERNAL_TOOLS` fingerprints the BINARY (dev:ino, size, mtime), which a
 * rebuild moves even when `Bun.version` does not. So `bun` is claimed by every
 * chunk, certified or not.
 */
export const ALWAYS_CLAIMED_TOOLS = ["bun"] as const

/** A shared artifact a chunk consumes rather than produces (TVH-12 seam). */
export interface ProducerReceiptRef {
  readonly id: string
  readonly sha256: string
}

export const producerReceiptsSha256 = (refs: readonly ProducerReceiptRef[]): string =>
  digestOf(
    JSON.stringify(
      [...refs]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ id, sha256 }) => [id, sha256]),
    ),
  )

export const NO_PRODUCER_RECEIPTS_SHA256 = producerReceiptsSha256([])

/**
 * Tool capabilities a test file DECLARES, from the capability manifest.
 *
 * Every group is indexed, not only the `lane-gated` ones: a
 * `declared-pending-gate` group's members need their tools just as much, and
 * indexing only the gated half would under-claim — the unsafe direction.
 */
const toolClaimIndex = (): ReadonlyMap<string, readonly string[]> => {
  const index = new Map<string, string[]>()
  for (const group of CAPABILITY_GROUPS) {
    const tools = group.needs
      .filter((need) => need.kind === "binary" || need.kind === "daemon")
      .map((need) => need.id)
    for (const member of group.members) {
      index.set(member, [...(index.get(member) ?? []), ...tools])
    }
  }
  return index
}

let cachedToolClaims: ReadonlyMap<string, readonly string[]> | undefined

export const declaredToolClaims = (id: string): readonly string[] => {
  cachedToolClaims ??= toolClaimIndex()
  return cachedToolClaims.get(id) ?? []
}

export interface ChunkCacheScope {
  readonly kind: "whole-tree" | "certified"
  /** Why — names the first file that pinned an uncertified chunk. */
  readonly reason: string
  readonly inputScopeSha256: string
  readonly toolScopeSha256: string
  readonly producerReceiptsSha256: string
  readonly claimedTools: readonly string[]
}

export interface ChunkScopeInput {
  readonly repoRoot: string
  /** Repo-relative test ids in this chunk. */
  readonly ids: readonly string[]
  /** TVH-04's certification corpus. Empty today: every file falls back. */
  readonly resourceCertifications: readonly TestResourceCertification[]
  readonly declaredOptIn?: ReadonlySet<string>
  readonly toolchainFingerprint?: Record<string, string>
  readonly producerReceipts?: readonly ProducerReceiptRef[]
  readonly read?: (id: string) => string | undefined
  readonly toolClaims?: (id: string) => readonly string[]
}

const readRepoFile =
  (repoRoot: string) =>
  (id: string): string | undefined => {
    try {
      return readFileSync(join(repoRoot, id), "utf8")
    } catch {
      return undefined
    }
  }

const wholeTree = (input: ChunkScopeInput, reason: string): ChunkCacheScope => ({
  kind: "whole-tree",
  reason,
  inputScopeSha256: WHOLE_TREE_INPUT_SCOPE_SHA256,
  toolScopeSha256: toolScopeSha256(
    input.toolchainFingerprint ?? hostCapabilityFingerprint(),
    undefined,
  ),
  producerReceiptsSha256: producerReceiptsSha256(input.producerReceipts ?? []),
  claimedTools: [],
})

/**
 * A chunk is certified only when EVERY file in it is certified twice over.
 *
 * TVH-04 (`resolveResourceCertification`) answers "are this file's resource
 * claims known and does its source still match them"; TVH-05's declared input
 * scope answers "can this file read anything it has not declared". Both are
 * required because they cover different failure modes, and neither is
 * reinvented here.
 *
 * At this HEAD every chunk still resolves to the `whole-tree` fail-safe, and it
 * is worth being exact about WHICH half does it, because the first version of
 * this comment named the wrong one. `test-resource-certifications.json` holds
 * 562 rows, 548 of them `certified` — not zero. What is empty is the
 * DECLARED-INPUT opt-in: `declaredInputOptIn()` returns a set of size 0, so
 * `certifyDeclaredInputs` refuses every file. Measured, with the real registry
 * passed in:
 *
 *   a resource-certified file -> whole-tree, `input-not-opted-in:<id>`
 *   an uncertified file       -> whole-tree, `resource-missing:<id>`
 *
 * Same conclusion, different cause — and the difference is the whole
 * promotion path: populating the opt-in narrows the cache with no code change,
 * while "populate the registry" would have been work already done.
 */
export const resolveChunkCacheScope = (input: ChunkScopeInput): ChunkCacheScope => {
  if (input.ids.length === 0) return wholeTree(input, "empty-chunk")
  const read = input.read ?? readRepoFile(input.repoRoot)
  const optIn = input.declaredOptIn ?? declaredInputOptIn()
  const claimsOf = input.toolClaims ?? declaredToolClaims
  const certifications = []
  const claimed = new Set<string>(ALWAYS_CLAIMED_TOOLS)
  for (const id of input.ids) {
    const source = read(id)
    if (source === undefined) return wholeTree(input, `unreadable:${id}`)
    const resource = resolveResourceCertification({
      testId: id,
      source,
      certifications: input.resourceCertifications,
    })
    if (resource.kind !== "certified") {
      return wholeTree(input, `resource-${resource.reason}:${id}`)
    }
    const declared = certifyDeclaredInputs({ id, source, optIn, repoRoot: input.repoRoot, read })
    if (declared.kind !== "declared-v1") {
      return wholeTree(input, `input-${declared.reason}:${id}`)
    }
    certifications.push(declared)
    for (const tool of claimsOf(id)) claimed.add(tool)
  }
  const claimedTools = [...claimed].sort((left, right) => left.localeCompare(right))
  return {
    kind: "certified",
    reason: `certified:${input.ids.length}`,
    inputScopeSha256: digestOf(
      JSON.stringify({
        base: runnerBaseScopeSha256(input.repoRoot, read),
        files: certifications,
      }),
    ),
    toolScopeSha256: toolScopeSha256(
      input.toolchainFingerprint ?? hostCapabilityFingerprint(),
      claimedTools,
    ),
    producerReceiptsSha256: producerReceiptsSha256(input.producerReceipts ?? []),
    claimedTools,
  }
}
