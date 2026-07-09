/** WS-C terminal-chrome kernel — the single owner of CLI terminal chrome
 *  primitives (jul-10 UI/UX structural fixes).
 *
 *  Root cause this module removes: terminal chrome had NO single owner —
 *  timeline-panel saved the cursor with SCO `ESC[s`/`ESC[u` while status-bar
 *  used DEC `ESC7`/`ESC8` (UUX-5-02); input-lane and status-bar each set the
 *  terminal-global DECSTBM scroll region independently and fought over it
 *  (UUX-5-04); `onResize` handlers existed but ZERO SIGWINCH listeners did
 *  (UUX-5-03 / UUX-3-09). This kernel owns exactly three things:
 *
 *   1. **DEC-only cursor save/restore.** {@link DEC_SAVE_CURSOR} /
 *      {@link DEC_RESTORE_CURSOR} (DECSC/DECRC). SCO (`ESC[s`/`ESC[u`) is
 *      BANNED under `src/apps/cli` by a grep-gate test — SCO restore is
 *      unreliable on VSCode-integrated and legacy emulators, which makes the
 *      next stream write land at the chrome row instead of returning to the
 *      content (the " · 29.6k in · 33 out" suffix-leak class).
 *   2. **The scroll-region (DECSTBM) manager.** {@link acquireRegion} —
 *      exactly ONE active region owner at a time. A second acquire suspends
 *      the first (byte-free: the new DECSTBM overwrites the terminal-global
 *      state); releasing the active owner writes its release bytes and then
 *      RE-ESTABLISHES the most recent suspended owner. That is the fix for
 *      the lane-vs-status-bar fight: the lane's exit no longer leaves the
 *      status row unpinned until reinstall.
 *   3. **The singleton SIGWINCH registry.** {@link onTerminalResize} — one
 *      process-level listener regardless of subscriber count, installed
 *      lazily on first subscribe, removed with the last unsubscribe (no
 *      listener leak across REPL restarts). Non-TTY safe: when stdout AND
 *      stderr are both non-TTY no process listener is installed at all.
 *
 *  Stream policy (stated once, per the WS-C plan): chrome (status bar,
 *  timeline panel) paints on **stderr**; the mid-turn input lane rides
 *  **stdout** (it echoes where the in-turn stream paints). This kernel does
 *  not own streams — every region owner brings its own `write` sink, so the
 *  existing split is preserved while the DECSTBM *ordering* is centralized
 *  (the scroll region is terminal-global no matter which fd carries it).
 *
 *  Slice isolation: zero imports — pure leaf so status-bar, timeline-panel
 *  and the repl session-loop can all depend on it without cycles.
 */

// --- 1. DEC-only cursor save/restore -------------------------------------

/** DECSC — DEC private cursor save (`ESC 7`). The ONLY cursor-save chrome
 *  under `src/apps/cli` may use (SCO `ESC[s` is grep-gate banned). */
export const DEC_SAVE_CURSOR = "\x1b7"

/** DECRC — DEC private cursor restore (`ESC 8`). Pair of
 *  {@link DEC_SAVE_CURSOR}. */
export const DEC_RESTORE_CURSOR = "\x1b8"

/** Wrap a paint body in DECSC/DECRC so an overlapping stream write cannot be
 *  jumped to the chrome row. */
export const withDecCursor = (body: string): string => DEC_SAVE_CURSOR + body + DEC_RESTORE_CURSOR

// --- 2. Scroll-region (DECSTBM) manager ----------------------------------

/** What a region owner brings to {@link ScrollRegionManager.acquireRegion}.
 *  `establish`/`release` are THUNKS (not strings) so geometry is read at
 *  write time — a resume after resize re-pins against the CURRENT rows. */
export interface RegionOwnerSpec {
  /** Bytes that set this owner's DECSTBM region (and park the cursor).
   *  Called on acquire, on {@link RegionHandle.refresh}, and on resume. */
  readonly establish: () => string
  /** Bytes that undo the region (reset / erase). Called exactly once, when
   *  the owner is released while ACTIVE. A suspended owner's release is
   *  byte-free — its region is not on the terminal. */
  readonly release: () => string
  /** The owner's stream sink (status bar/timeline → stderr, lane → stdout).
   *  Failures are swallowed — a broken sink must not corrupt manager state. */
  readonly write: (chunk: string) => void
}

export interface RegionHandle {
  /** Re-write `establish()` IF this owner is currently active (e.g. after a
   *  resize). Suspended/released owners no-op — a suspended owner picks up
   *  fresh geometry when it is resumed (establish is a thunk). */
  readonly refresh: () => void
  /** Release the region. Active owner: write `release()` bytes, then resume
   *  the most recent suspended owner (re-establish its region). Suspended
   *  owner: silently drop from the stack. Idempotent. */
  readonly release: () => void
  /** True while this owner's region is the one on the terminal. */
  readonly isActive: () => boolean
}

export interface ScrollRegionManager {
  /** Acquire the (single) scroll region for `owner`. Any currently-active
   *  owner is suspended until this handle is released. */
  readonly acquireRegion: (owner: string, spec: RegionOwnerSpec) => RegionHandle
  /** Name of the owner whose region is currently on the terminal. */
  readonly activeOwner: () => string | undefined
}

interface RegionEntry {
  readonly owner: string
  readonly spec: RegionOwnerSpec
  released: boolean
}

/** Build an isolated manager (unit tests / hermetic composition). Production
 *  chrome shares {@link acquireRegion} — the module singleton — because the
 *  DECSTBM region is terminal-global across BOTH stdio streams. */
export const createScrollRegionManager = (): ScrollRegionManager => {
  // Bottom → top; the last entry's region is the one on the terminal.
  const stack: RegionEntry[] = []

  const safeWrite = (entry: RegionEntry, bytes: string): void => {
    try {
      entry.spec.write(bytes)
    } catch {
      // Intentional: chrome is a UX surface, never a control path. A closed
      // fd (EPIPE) must not corrupt the ownership stack.
    }
  }

  const top = (): RegionEntry | undefined => stack[stack.length - 1]

  const acquireRegion = (owner: string, spec: RegionOwnerSpec): RegionHandle => {
    const entry: RegionEntry = { owner, spec, released: false }
    // Suspending the previous top is byte-free: the new establish overwrites
    // the terminal-global DECSTBM state.
    stack.push(entry)
    safeWrite(entry, spec.establish())
    const isActive = (): boolean => !entry.released && top() === entry
    return {
      isActive,
      refresh: (): void => {
        if (isActive()) safeWrite(entry, spec.establish())
      },
      release: (): void => {
        if (entry.released) return
        const wasActive = isActive()
        entry.released = true
        const idx = stack.lastIndexOf(entry)
        if (idx !== -1) stack.splice(idx, 1)
        if (!wasActive) return // suspended — its region was never on screen
        safeWrite(entry, spec.release())
        const resumed = top()
        if (resumed !== undefined) safeWrite(resumed, resumed.spec.establish())
      },
    }
  }

  return {
    acquireRegion,
    activeOwner: (): string | undefined => top()?.owner,
  }
}

const sharedRegionManager = createScrollRegionManager()

/** Module-singleton {@link ScrollRegionManager.acquireRegion} — the one
 *  production chrome (status bar, timeline panel, input lane) shares. */
export const acquireRegion: ScrollRegionManager["acquireRegion"] = sharedRegionManager.acquireRegion

/** Singleton {@link ScrollRegionManager.activeOwner} (observability). */
export const activeRegionOwner: ScrollRegionManager["activeOwner"] = sharedRegionManager.activeOwner

// --- 3. Singleton SIGWINCH registry ---------------------------------------

export type ResizeUnsubscribe = () => void

/** Signature panels use to subscribe to terminal resizes (also the DI seam —
 *  timeline-panel / status-bar / lane accept an injectable `resize` of this
 *  shape defaulting to {@link onTerminalResize}). */
export type ResizeSubscribe = (cb: () => void) => ResizeUnsubscribe

const resizeCallbacks = new Set<() => void>()
let sigwinchInstalled = false

const sigwinchHandler = (): void => {
  // Snapshot: a callback that unsubscribes (or subscribes) mid-broadcast
  // must not perturb this delivery round.
  for (const cb of [...resizeCallbacks]) {
    try {
      cb()
    } catch {
      // One broken panel must not starve the others' resize handling.
    }
  }
}

/** TTY gate — a SIGWINCH listener is only meaningful when at least one stdio
 *  stream is a terminal. Checked at subscribe time (per-subscribe, so a test
 *  or late TTY attach can still install on a later subscribe). */
const anyStdioTty = (): boolean => process.stdout.isTTY === true || process.stderr.isTTY === true

/** Subscribe to terminal-resize (SIGWINCH). ONE process-level listener is
 *  shared by all subscribers; it is installed lazily and removed when the
 *  last subscriber unsubscribes (no leak across REPL restarts). Safe for
 *  non-TTY surfaces: when stdout AND stderr are both non-TTY, no process
 *  listener is installed (the callback simply never fires). The returned
 *  unsubscribe is idempotent. */
export const onTerminalResize: ResizeSubscribe = (cb) => {
  // Unique wrapper per SUBSCRIPTION (not per function): two subscribers
  // passing the same callback reference must not collapse into one Set
  // entry — otherwise the first unsubscribe would silently kill the second
  // subscriber (and uninstall the process listener under it).
  const entry = (): void => cb()
  resizeCallbacks.add(entry)
  if (!sigwinchInstalled && anyStdioTty()) {
    process.on("SIGWINCH", sigwinchHandler)
    sigwinchInstalled = true
  }
  let unsubscribed = false
  return (): void => {
    if (unsubscribed) return
    unsubscribed = true
    resizeCallbacks.delete(entry)
    if (resizeCallbacks.size === 0 && sigwinchInstalled) {
      process.removeListener("SIGWINCH", sigwinchHandler)
      sigwinchInstalled = false
    }
  }
}

/** Live subscriber count — leak-audit observability for tests. */
export const resizeSubscriberCount = (): number => resizeCallbacks.size
