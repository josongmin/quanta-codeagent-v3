/**
 * ADR-0249 — barrel.
 *
 * Public entry-point for the node-repl persistent-kernel slice. Composition
 * roots should import from here; downstream slice files (default-kernel,
 * state-store, headless-stub) stay internal except for their re-exported
 * factories / types.
 */

export {
  createDefaultNodeReplKernel,
  type DefaultKernelOptions,
} from "./default-kernel"
export { type HeadlessStubOptions, headlessStub } from "./headless-stub"
export type {
  KernelListing,
  NodeReplExecOptions,
  NodeReplKernel,
  NodeReplSpawnOptions,
} from "./port"
export { listKernels, removeKernel, safeId, stateDir, writeKernel } from "./state-store"
export type {
  ExecResult,
  KernelError,
  KernelId,
  KernelSpec,
  KernelState,
} from "./types"
