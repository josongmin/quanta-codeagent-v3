import type { ShellExecEvent, ShellExecObserver } from "./shell-exec-types"

/**
 * Compose N observers into one — every observer fires per event, in argument
 * order. A throw from any single observer is SWALLOWED and the next observer
 * still fires; the producer (`runShell`) sees no throw either way. This keeps
 * the rule "shell event observation never breaks shell execution" intact even
 * when one consumer (e.g. a stderr writer to a closed TTY) faults.
 *
 * Use cases:
 *   - CLI streaming TUI + OTel chunk counter run side by side.
 *   - IDE host attaches its own renderer on top of the CLI's painter.
 *   - Tests attach a recording observer alongside a real one.
 *
 * Variadic + tolerant of zero arguments — `composeShellObservers()` is a
 * legal no-op observer the caller can use instead of `undefined` when the
 * surrounding code needs a value.
 */
export const composeShellObservers = (
  ...observers: readonly (ShellExecObserver | undefined)[]
): ShellExecObserver => {
  // Pre-filter undefined so the hot path inside the closure is a tight loop.
  const live = observers.filter((o): o is ShellExecObserver => o !== undefined)
  return (event: ShellExecEvent): void => {
    for (const o of live) {
      try {
        o(event)
      } catch {
        // Intentional: an observer must not break the surrounding shell run.
        // We deliberately do not log here — an observer that wants to surface
        // its own errors should do so internally (its choice of channel).
      }
    }
  }
}

/** Explicit no-op observer. Useful for tests / dry-runs where a callsite
 *  expects an observer but we don't want to trigger event allocation in the
 *  producer (NOTE: passing this still triggers allocation in `runShell` — to
 *  preserve byte-identical default-OFF, pass `undefined` instead).
 *
 *  This is provided for the rare case where the caller needs an observer
 *  REFERENCE (e.g. capturing the observer position in a struct) but wants
 *  no side effects. */
export const noopShellObserver: ShellExecObserver = () => undefined
