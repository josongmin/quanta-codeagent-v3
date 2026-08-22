/** Raw-line-reader key-event shape + canonical-chord rebuild, extracted from
 *  `raw-line-reader.ts`. Pure; no terminal / state coupling. */

export interface KeyEvent {
  readonly name?: string
  readonly ctrl?: boolean
  /** RFC-08 — node `readline.emitKeypressEvents` already populates `key.shift`;
   *  we widen the interface so the shift+tab (mode-cycle) guard can read it. */
  readonly shift?: boolean
  /** RFC-11 — alt/meta widened so `keyOf` can project meta chords for the
   *  keybinding remap. */
  readonly alt?: boolean
  readonly meta?: boolean
  readonly sequence?: string
}

/** RFC-11 / ADR-0447 — rebuild a `KeyEvent` from a canonical single-chord
 *  spec (`"ctrl+r"`, `"up"`). The keybinding remap uses this to dispatch a
 *  user-bound key AS IF the action's default key was pressed, so the existing
 *  if-chain's context logic is preserved. Pure; spec is always a valid single
 *  chord drawn from `CANONICAL_KEY_FOR_ACTION`. */
export const remapKeyEvent = (spec: string): KeyEvent => {
  const parts = spec.split("+")
  const name = parts[parts.length - 1] ?? ""
  const mods = new Set(parts.slice(0, -1))
  return {
    name,
    ...(mods.has("ctrl") ? { ctrl: true } : {}),
    ...(mods.has("alt") ? { alt: true } : {}),
    ...(mods.has("shift") ? { shift: true } : {}),
    ...(mods.has("meta") ? { meta: true } : {}),
  }
}
