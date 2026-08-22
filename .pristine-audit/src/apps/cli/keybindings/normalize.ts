/**
 * RFC-11 / ADR-0447 — key spec normalization + runtime keypress projection.
 *
 * Two pure functions:
 *   - `normalizeKeySpec(raw)` — config side. Parses a user-authored spec such
 *     as `"Ctrl+X Ctrl+E"`, `"ctrl+r"`, `"up"` into a canonical lower-case
 *     token (single chord) or space-joined sequence (multi-chord). Returns
 *     `null` on any malformed token (unknown key name, empty token, bad
 *     modifier) — Codex `KeybindingsSpec` "invalid keybinding" parity. The
 *     caller drops the entry + warns.
 *   - `keyOf(key)` — runtime side. Projects a `node:readline` keypress event
 *     into the SAME canonical single-chord token so the loaded map can be
 *     looked up. A chord SEQUENCE (`"ctrl+x ctrl+e"`) is resolved by the
 *     reader's pending-prefix state machine, never here.
 *
 * "duplicate modifier" detection: a single chord token like `ctrl+ctrl+e`
 * has the SAME modifier twice ⇒ rejected (Codex `:5710`).
 *
 * Slice posture: pure. No `node:*`, no `@/...`.
 */

/** Key names node's `readline.emitKeypressEvents` emits that we accept as a
 *  bindable base key (the modifier-less part of a chord). Plus single
 *  printable letters `a..z` and digits `0..9` for `ctrl+<x>` style chords. */
const NAMED_KEYS: ReadonlySet<string> = new Set<string>([
  "return",
  "escape",
  "tab",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "backspace",
  "delete",
  "space",
])

const MODIFIERS: ReadonlySet<string> = new Set<string>(["ctrl", "alt", "shift", "meta"])
/** Canonical modifier emission order so `shift+ctrl+x` and `ctrl+shift+x`
 *  normalize identically. */
const MODIFIER_ORDER: readonly string[] = ["ctrl", "alt", "shift", "meta"]

const isBaseKey = (token: string): boolean => {
  if (NAMED_KEYS.has(token)) return true
  // single printable letter or digit (the base of a ctrl/alt chord or a bare
  // letter binding)
  return token.length === 1 && /[a-z0-9]/.test(token)
}

/** Normalize ONE chord token (`"ctrl+x"`, `"up"`). Returns the canonical
 *  form or `null` on any defect. Sets `dup` when the same modifier appears
 *  twice (the caller maps that to the "duplicate modifier" warning). */
const normalizeChord = (chord: string): { spec: string } | { error: "invalid" | "duplicate" } => {
  const parts = chord.split("+").map((p) => p.trim().toLowerCase())
  if (parts.some((p) => p === "")) return { error: "invalid" }
  const mods: string[] = []
  let base: string | null = null
  const seenMods = new Set<string>()
  for (const part of parts) {
    if (MODIFIERS.has(part)) {
      if (seenMods.has(part)) return { error: "duplicate" }
      seenMods.add(part)
      mods.push(part)
      continue
    }
    // a non-modifier token is the base key — exactly one allowed
    if (base !== null) return { error: "invalid" }
    if (!isBaseKey(part)) return { error: "invalid" }
    base = part
  }
  if (base === null) return { error: "invalid" }
  const orderedMods = MODIFIER_ORDER.filter((m) => seenMods.has(m))
  return { spec: [...orderedMods, base].join("+") }
}

export type NormalizeResult = { spec: string } | { error: "invalid" | "duplicate" }

/** Config-side parse. Whitespace separates chords in a SEQUENCE
 *  (`"ctrl+x ctrl+e"`); each chord is normalized independently. */
export const normalizeKeySpec = (raw: string): NormalizeResult => {
  if (typeof raw !== "string") return { error: "invalid" }
  const chords = raw
    .trim()
    .split(/\s+/)
    .filter((c) => c.length > 0)
  if (chords.length === 0) return { error: "invalid" }
  const specs: string[] = []
  for (const chord of chords) {
    const r = normalizeChord(chord)
    if ("error" in r) return r
    specs.push(r.spec)
  }
  return { spec: specs.join(" ") }
}

/** Runtime-side projection of a keypress event into a single canonical chord
 *  token matching `normalizeKeySpec`'s output for one chord. */
export interface KeyEventLike {
  readonly name?: string | undefined
  readonly ctrl?: boolean | undefined
  readonly alt?: boolean | undefined
  readonly meta?: boolean | undefined
  readonly shift?: boolean | undefined
}

export const keyOf = (k: KeyEventLike): string | null => {
  const name = k.name
  if (name === undefined || name === "") return null
  const base = name.toLowerCase()
  // Only project keys that could be a bindable base. (Printable inserts and
  // unknown sequences return null ⇒ the reader falls back to its char-insert
  // path, byte-identical.)
  if (!isBaseKey(base)) return null
  const mods: string[] = []
  if (k.ctrl === true) mods.push("ctrl")
  if (k.alt === true || k.meta === true) mods.push("alt")
  // shift is intentionally NOT projected onto letter keys (the printable char
  // already carries the case); it is meaningful only for named keys like
  // shift+tab, which RFC-08 owns directly — we leave that to the existing
  // backtab guard and never route it through the keymap.
  const ordered = MODIFIER_ORDER.filter((m) => mods.includes(m))
  return [...ordered, base].join("+")
}
