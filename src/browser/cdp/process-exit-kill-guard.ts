/**
 * Last-resort ownership for subprocesses when the host exits before async
 * teardown can run (for example, a fail-fast test worker). One process-level
 * listener owns every live child so concurrent browser sessions cannot grow
 * EventEmitter listeners without bound.
 */

export interface ProcessExitBoundary {
  add(listener: () => void): void
  remove(listener: () => void): void
}

export const createProcessExitKillGuard = (
  boundary: ProcessExitBoundary,
): ((kill: () => void) => () => void) => {
  const pending = new Set<() => void>()
  let listening = false

  const onExit = (): void => {
    listening = false
    boundary.remove(onExit)
    const kills = [...pending]
    pending.clear()
    for (const kill of kills) {
      try {
        kill()
      } catch {
        // The child already exited or cannot be signalled. Host exit continues.
      }
    }
  }

  return (kill: () => void): (() => void) => {
    pending.add(kill)
    if (!listening) {
      listening = true
      boundary.add(onExit)
    }

    let registered = true
    return () => {
      if (!registered) return
      registered = false
      pending.delete(kill)
      if (pending.size === 0 && listening) {
        listening = false
        boundary.remove(onExit)
      }
    }
  }
}

export const registerProcessExitKill = createProcessExitKillGuard({
  add: (listener) => process.once("exit", listener),
  remove: (listener) => process.off("exit", listener),
})
