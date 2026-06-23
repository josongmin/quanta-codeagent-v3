/** Knob declaration contract — shared by the runtime-config-knobs registry
 *  and its per-category sub-registries (god-module split). Pure types. */
export type RcKind = "bool" | "int" | "float" | "string" | "enum"

export interface RuntimeConfigKnob {
  readonly envKey: `QUANTA_${string}`
  readonly kind: RcKind
  readonly default: boolean | number | string | undefined
  readonly group: string
  readonly describe: string
}
