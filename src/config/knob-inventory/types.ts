/** Knob-inventory entry contract — shared by the per-home sub-registries
 *  (god-module split). Pure types. */
export type InventoryKind = "bool" | "int" | "float" | "string" | "enum"
export type KnobHome = "runtime-config" | "runner-knobs" | "bench"
export type KnobReadAuthority =
  | "startup-seed"
  | "runtime-config"
  | "injected-env"
  | "composition-gate"
  | "runner-knob"
  | "bench"
  | "credential-exempt"

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
  /** Target typed owner — not proof a typed field currently exists. */
  readonly home: KnobHome
  /** Current temporal read authority. Distinct from {@link home}. */
  readonly readAuthority: KnobReadAuthority
  readonly describe: string
  readonly readSite: string
}

/** Source declaration before read-authority classification. */
export type KnobDeclaration = Omit<KnobInventoryEntry, "readAuthority">
