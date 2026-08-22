import type { SandboxPolicy } from "./os-sandbox/types"
import type { WrappedShellArgv, WrapShellArgvConfig } from "./os-sandbox/wrap-argv"

/**
 * S1 (OS Sandbox actual wire-up). A SINGLE module-level slot holding the
 * argv-wrapper the CLI surface installs at boot. `runShell` consults this slot
 * (via {@link getShellSandbox}) to decide whether to wrap the spawned argv
 * with the active OS backend (`sandbox-exec` on macOS, `bwrap` /
 * `landlock-cli` on Linux, or honest passthrough degradation).
 *
 * Why a module slot and not `ToolContext` plumbing: the central `ToolContext`
 * build site lives in `src/agent/dispatch.ts` — a WIP hot-zone file the S1
 * track is forbidden to touch. The module slot keeps the wire-up surface to
 * non-WIP files (this file + `runtime/shell.ts` + `apps/cli/sandbox-wire.ts`
 * + `apps/cli/index.ts`).
 *
 * Default-OFF contract:
 *   - Until {@link installShellSandbox} is called the slot is `undefined`.
 *   - {@link getShellSandbox} returns `undefined` ⇒ `runShell` runs its
 *     legacy `Bun.spawn(["bash","-lc",cmd], …)` path BYTE-IDENTICALLY.
 *   - The CLI installs ONCE at startup (apps/cli/index.ts) — no mid-run
 *     mutation. {@link __resetShellSandbox} is the test-only reset seam.
 *
 * Anti-leak invariants:
 *   - HARD_DENY (permission layer) runs upstream in dispatch BEFORE the bash
 *     tool's `execute` body is invoked. The sandbox wraps the spawn, NOT the
 *     pre-execution gate — defense-in-depth, not substitute.
 *   - On degradation, the WARNING surfaces via the CLI's startup banner; the
 *     bash tool itself does NOT echo policy/profile internals into its stderr
 *     / output.
 */
export interface ShellSandboxSlot {
  /** Active policy chosen at startup (frozen for the run). */
  readonly policy: SandboxPolicy
  /** Wrapper-config passed through to {@link wrapShellArgv}. Tests inject
   *  `platform` + `sandboxExecPath` to drive branches deterministically. */
  readonly config: WrapShellArgvConfig
  /** Async argv-wrap function — Linux may need a one-time backend probe
   *  before it can assemble the wrapped argv. */
  readonly wrap: (argv: ReadonlyArray<string>, cwd: string) => Promise<WrappedShellArgv>
}

let installed: ShellSandboxSlot | undefined

/**
 * Install the CLI-resolved sandbox slot. Idempotent: a second install REPLACES
 * the slot (used by tests). Production code calls this ONCE at boot
 * (`apps/cli/index.ts`).
 *
 * Pass `undefined` to clear the slot — equivalent to {@link __resetShellSandbox}.
 */
export const installShellSandbox = (slot: ShellSandboxSlot | undefined): void => {
  installed = slot
}

/** Read the installed slot. `undefined` ⇒ legacy byte-identical passthrough. */
export const getShellSandbox = (): ShellSandboxSlot | undefined => installed

/** Test-only reset. Production code MUST NOT call this. */
export const __resetShellSandbox = (): void => {
  installed = undefined
}
