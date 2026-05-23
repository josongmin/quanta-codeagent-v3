/** Byte-stable string comparator for deterministic ordering.
 *
 *  Unlike `String.prototype.localeCompare`, the result does NOT depend on the
 *  host locale / ICU collation, so any list sorted with `byteCompare` is
 *  byte-identical across machines and locales. This is REQUIRED for anything
 *  whose ordering reaches the model-facing prompt, the persisted transcript,
 *  or a replay-compared payload — locale-dependent ordering silently breaks
 *  the byte-identical replay + prompt-cache invariant.
 *
 *  Use this (not `localeCompare`) for sorting names/ids/paths in src/. */
export const byteCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
