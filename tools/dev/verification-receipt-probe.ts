import { createHash } from "node:crypto"

import type { Gate } from "./gate-manifest"
import {
  readExactVerificationReceipt,
  type VerificationContext,
  validateExactVerificationReceipt,
  verificationBaseOid,
  verificationDependencySha256,
  verificationEnvironmentSha256,
  verificationHomeCapabilitySha256,
  verificationReceiptPath,
  verificationToolchainSha256,
} from "./verification-receipt"

export interface VerificationGitSnapshot {
  readonly head: string
  readonly status: string
}

export type ExactReceiptProbe =
  | { readonly ok: true; readonly head: string; readonly path: string }
  | { readonly ok: false; readonly reason: string; readonly path: string }

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")

/**
 * The manifest fields a receipt's identity is made of — a CLOSED universe.
 *
 * TVH item 11. The digest hashed six fields chosen by destructuring, and
 * `needsQuietBox` was not one of them. That field changes DISPATCH: a gate
 * carrying it makes the runner wait for the box to go quiet before it starts.
 * So adding it to, or removing it from, a gate produced a manifest the receipt
 * called identical, and a green minted under one dispatch policy replayed under
 * another.
 *
 * Destructuring is exactly how that happens: a new field is simply not
 * mentioned, and nothing anywhere notices. The two lists below are exhaustive
 * over `keyof Gate` — the compiler checks it, and {@link assertClosedDispatchSchema}
 * checks it again against the gates at run time, because a field can be added
 * to the data before it is added to the type.
 */
const DISPATCH_FIELDS = [
  "id",
  "stage",
  "run",
  "consumes",
  "hostDependent",
  "notInWorkflow",
  "needsQuietBox",
] as const satisfies readonly (keyof Gate)[]

/**
 * Fields deliberately OUTSIDE the identity, named rather than omitted.
 *
 * `why` is the reason the gate exists, for a reader. Rewording it must not
 * invalidate a green campaign, and leaving it unlisted would make that a fact
 * about which fields someone remembered to destructure.
 */
const NON_DISPATCH_FIELDS = ["why"] as const satisfies readonly (keyof Gate)[]

/** Compile-time exhaustiveness: every `Gate` key is classified, one way or the other. */
type ClassifiedGateKey = (typeof DISPATCH_FIELDS)[number] | (typeof NON_DISPATCH_FIELDS)[number]
type UnclassifiedGateKey = Exclude<keyof Gate, ClassifiedGateKey>
const _exhaustive: UnclassifiedGateKey extends never ? true : never = true
void _exhaustive

/**
 * Run-time drift guard. `satisfies` proves the lists are keys of `Gate`; it
 * cannot prove a gate OBJECT carries no other key, which is the shape a
 * hand-edited manifest or a widened type produces first.
 */
export const assertClosedDispatchSchema = (gates: readonly Gate[]): void => {
  const known = new Set<string>([...DISPATCH_FIELDS, ...NON_DISPATCH_FIELDS])
  const unknown = new Set<string>()
  for (const gate of gates) {
    for (const key of Object.keys(gate)) if (!known.has(key)) unknown.add(key)
  }
  if (unknown.size > 0) {
    throw new Error(
      `verification manifest: gate field(s) ${[...unknown].sort().join(", ")} are in no dispatch ` +
        "class. Add each to DISPATCH_FIELDS (it changes what runs) or NON_DISPATCH_FIELDS " +
        "(it does not), so the receipt identity cannot silently omit it.",
    )
  }
}

/** One manifest identity owner for the pre-lease probe and the gate runner. */
export const verificationManifestSha256 = (gates: readonly Gate[]): string => {
  assertClosedDispatchSchema(gates)
  return sha256(
    JSON.stringify(
      gates.map((gate) =>
        Object.fromEntries(DISPATCH_FIELDS.map((field) => [field, gate[field] ?? null])),
      ),
    ),
  )
}

const gitOutput = (repoRoot: string, args: readonly string[]): string => {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    throw new Error(
      `\`git ${args.join(" ")}\` failed (exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`,
    )
  }
  return proc.stdout.toString()
}

const gitSnapshot = (repoRoot: string): VerificationGitSnapshot => ({
  head: gitOutput(repoRoot, ["rev-parse", "HEAD"]).trim(),
  status: gitOutput(repoRoot, ["status", "--porcelain=v1", "-uall", "-z"]),
})

export const verificationContextForSnapshot = (
  repoRoot: string,
  snapshot: VerificationGitSnapshot,
  manifestSha256: string,
  env: NodeJS.ProcessEnv = process.env,
): VerificationContext => ({
  head: snapshot.head,
  statusSha256: sha256(snapshot.status),
  manifestSha256,
  dependencySha256: verificationDependencySha256(repoRoot),
  toolchainSha256: verificationToolchainSha256(),
  environmentSha256: verificationEnvironmentSha256(env),
  // The two moving parts a same-HEAD, same-status receipt used to be blind to:
  // the remote comparison base, and HOME-derived tool resolution.
  baseOid: verificationBaseOid(repoRoot),
  homeCapabilitySha256: verificationHomeCapabilitySha256(env.HOME),
})

/**
 * Read-only, content-bound receipt probe. Callers treat throws and non-matches
 * as misses; only an exact clean match may bypass repository-lease acquisition.
 */
export const probeExactVerificationReceipt = (
  repoRoot: string,
  gates: readonly Gate[],
): ExactReceiptProbe => {
  const path = verificationReceiptPath(repoRoot)
  const snapshot = gitSnapshot(repoRoot)
  const validation = validateExactVerificationReceipt(
    readExactVerificationReceipt(path),
    verificationContextForSnapshot(repoRoot, snapshot, verificationManifestSha256(gates)),
  )
  return validation.ok
    ? { ok: true, head: snapshot.head, path }
    : { ok: false, reason: validation.reason, path }
}
