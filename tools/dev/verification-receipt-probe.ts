import { createHash } from "node:crypto"

import type { Gate } from "./gate-manifest"
import {
  readExactVerificationReceipt,
  type VerificationContext,
  validateExactVerificationReceipt,
  verificationDependencySha256,
  verificationEnvironmentSha256,
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

/** One manifest identity owner for the pre-lease probe and the gate runner. */
export const verificationManifestSha256 = (gates: readonly Gate[]): string =>
  sha256(
    JSON.stringify(
      gates.map(({ id, stage, run, consumes, hostDependent, notInWorkflow }) => ({
        id,
        stage,
        run,
        consumes: consumes ?? null,
        hostDependent: hostDependent ?? null,
        notInWorkflow: notInWorkflow ?? null,
      })),
    ),
  )

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
