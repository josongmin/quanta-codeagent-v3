import { defaultPerCallSandbox, type PerCallSandboxPort } from "@/runtime/os-sandbox"
import type { SandboxProfile } from "@/runtime/os-sandbox/types"

/**
 * ADR-0295 — Closed-port DI seam for the bash tool's `mode="read"` per-call
 * sandbox. Production wires the default factory built atop `defaultPerCallSandbox`
 * from `@/runtime/os-sandbox`; tests inject a fake via {@link __setBashPerCallSandboxFactory}
 * for hermetic coverage.
 *
 * Why a module-level seam rather than threading through `ToolContext`: the
 * bash tool already declares its own DI ports here (mirrors the existing
 * pattern of the shell-sandbox holder). The `ToolContext` build site is a
 * cross-track hot file we deliberately do NOT touch.
 *
 * Default-OFF wire: the bash tool only consults this factory when its `mode`
 * input is `"read"`. Default `mode: "write"` never reaches this code, so
 * existing sessions are byte-identical.
 */
export interface PerCallSandboxFactoryOpts {
  readonly extraWritePaths?: ReadonlyArray<string>
}

export type PerCallSandboxFactory = (
  profile: SandboxProfile,
  opts?: PerCallSandboxFactoryOpts,
) => PerCallSandboxPort

let installed: PerCallSandboxFactory | undefined

/** Production default — closed over `defaultPerCallSandbox`. */
const productionFactory: PerCallSandboxFactory = (profile, opts) =>
  defaultPerCallSandbox(profile, {
    ...(opts?.extraWritePaths !== undefined ? { extraWritePaths: opts.extraWritePaths } : {}),
  })

/** Read the factory the bash tool consults on mode='read'. */
export const getBashPerCallSandboxFactory = (): PerCallSandboxFactory =>
  installed ?? productionFactory

/** Test-only DI seam. Pass `undefined` to clear. */
export const __setBashPerCallSandboxFactory = (
  factory: PerCallSandboxFactory | undefined,
): void => {
  installed = factory
}
