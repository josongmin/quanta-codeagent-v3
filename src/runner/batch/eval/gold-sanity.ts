import { join } from "node:path"
import type { Instance } from "../types"
import { exec } from "./exec"
import { cleanupSandbox, copyRepo, createSandbox } from "./sandbox"
import { type VerifyDeps, verify } from "./verdict"

export type GoldSanityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

const GOLD_PATCH_FILE = ".quanta-gold.patch"

const applyGoldPatch = async (
  instance: Instance,
  sandbox: string,
  timeoutMs: number,
): Promise<GoldSanityResult> => {
  const patch = instance.goldPatch
  if (patch === undefined || patch === "") return { ok: true }
  await Bun.write(join(sandbox, GOLD_PATCH_FILE), patch)
  const applied = await exec(`git apply --whitespace=nowarn ${GOLD_PATCH_FILE}`, sandbox, timeoutMs, {
    ...(instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {}),
  })
  if (applied.code === 0) return { ok: true }
  return {
    ok: false,
    error: `gold patch apply failed (code ${applied.code}): ${applied.stderr.slice(0, 500)}`,
  }
}

export const validateGoldPatch = async (
  instance: Instance,
  deps: VerifyDeps,
): Promise<GoldSanityResult> => {
  if (instance.goldPatch === undefined || instance.goldPatch === "") return { ok: true }
  const sandbox = await createSandbox(instance)
  try {
    await copyRepo(instance, sandbox)
    const applied = await applyGoldPatch(instance, sandbox, deps.timeoutMs)
    if (!applied.ok) return applied
    const verified = await verify(instance, instance.goldPatch, sandbox, deps)
    if (verified.passed) return { ok: true }
    const detail = verified.error ?? verified.logTail
    return {
      ok: false,
      error: `gold patch did not resolve under selected verifier: ${detail.slice(0, 500)}`,
    }
  } finally {
    await cleanupSandbox(sandbox)
  }
}
