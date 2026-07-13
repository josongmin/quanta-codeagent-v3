/** Knob declaration contract — shared by the runtime-config-knobs registry
 *  and its per-category sub-registries (god-module split). Pure types. */
// `list` = a delimited-string env (`parseStringList`, split on `,:;\n`) whose
// runtime value is a `readonly string[]` defaulting to `[]` — declared distinct
// from `string` so the /knobs + web catalog render the true shape, and so the
// default-parity ratchet compares against the real `[]` default.
export type RcKind = "bool" | "int" | "float" | "string" | "enum" | "list"

export interface RuntimeConfigKnob {
  readonly envKey: `QUANTA_${string}`
  readonly kind: RcKind
  readonly default: boolean | number | string | readonly string[] | undefined
  readonly group: string
  readonly describe: string
}
