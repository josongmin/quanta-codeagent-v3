/**
 * Per-instance sandbox lifecycle: create an isolated `cp -R` copy of the
 * instance's repo into `benchWorkRoot()/bench-<id>-XXXX`, hand it to the
 * driver, then unconditionally `rm -rf` on the finally path. Pure path
 * functions: no behavior change vs the prior inline runner.ts block, just a
 * single-responsibility module the driver imports.
 *
 * The corpus is NEVER mutated — that invariant lives here.
 */
import { cp, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { benchWorkRoot } from "../corpus/paths"
import type { Instance } from "../types"

/** Create the fresh sandbox dir under `benchWorkRoot()`. Returns the absolute
 *  sandbox path. Does NOT copy the repo — that is a separate step (see
 *  {@link copyRepo}) so the runner's try/catch can map a `cp` failure (e.g.
 *  0o000 source perms) to a structured `InstanceResult.error` rather than
 *  throwing out of the cleanup boundary. */
export const createSandbox = async (instance: Instance): Promise<string> =>
  mkdtemp(join(benchWorkRoot(), `bench-${instance.id}-`))

/** Recursive copy of the instance's repo into the sandbox. Separate from
 *  {@link createSandbox} so the runner can catch a permissions / disk failure
 *  inside its try arm and surface it as a failed InstanceResult. */
export const copyRepo = async (instance: Instance, sandbox: string): Promise<void> => {
  await cp(instance.repoPath, sandbox, { recursive: true })
}

/** Best-effort cleanup — never throws (the run is already done). */
export const cleanupSandbox = async (sandbox: string): Promise<void> => {
  await rm(sandbox, { recursive: true, force: true })
}
