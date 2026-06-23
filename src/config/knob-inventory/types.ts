/** Knob-inventory entry contract — shared by the per-home sub-registries
 *  (god-module split). Pure types. */
export type InventoryKind = "bool" | "int" | "float" | "string" | "enum"
export type KnobHome = "runtime-config" | "runner-knobs" | "bench"

export interface KnobInventoryEntry {
  readonly envKey: `QUANTA_${string}`
  readonly kind: InventoryKind
  readonly default: boolean | number | string | undefined
  readonly group:
    | "host-gate"
    | "permission"
    | "memory"
    | "mcp"
    | "search"
    | "retrieval"
    | "diff"
    | "observability"
    | "llm"
    | "remote"
    | "sandbox"
    | "session-registry"
    | "web-daemon"
    | "bench"
    | "auth"
    | "scheduler"
    | "security"
    | "agent-feature"
    | "integration"
  readonly home: KnobHome
  readonly describe: string
  readonly readSite: string
}
