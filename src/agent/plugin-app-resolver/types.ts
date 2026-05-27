/**
 * ADR-0336 — Plugin + app resolver types.
 *
 * Local re-declaration of the read-only skill registry shape +
 * LOCAL MOCK of the ADR-0335 typed activation events. The mock
 * interfaces are STRUCTURALLY identical to the variants ADR-0335
 * will add to the canonical typed-event store; integration is a
 * one-line `type` alias swap when ADR-0335 lands.
 *
 * Pattern parity: this mock arrangement mirrors the R1 / ADR-0330
 * approach where `SkillRegistryReadOnly` was re-declared locally
 * instead of imported across slice boundaries.
 */

/**
 * Read-only skill registry surface. Structurally compatible with
 * `@/agent/mention-runner`'s `SkillRegistryReadOnly` so callers can
 * reuse the same fake registries across both slices.
 */
export interface SkillRegistryReadOnly {
  lookup(name: string): { readonly name: string; readonly description: string } | null
}

/**
 * LOCAL MOCK — ADR-0335 will add a `plugin_activation` variant to
 * the canonical typed-event store. This slice declares the shape
 * here so it can build typed event values without an import-time
 * dependency on the in-flight ADR-0335 slice. When ADR-0335 lands
 * this becomes:
 *
 *   import type { PluginActivationEvent as LocalPluginActivationEvent }
 *     from "@/agent/typed-events"
 */
export interface LocalPluginActivationEvent {
  readonly kind: "plugin_activation"
  readonly pluginId: string
  readonly trigger: "user" | "auto" | "system"
  readonly capabilities: readonly ("Interactive" | "Read" | "Write")[]
  readonly at: number
  readonly turnId?: string
}

/**
 * LOCAL MOCK — ADR-0335 sibling to {@link LocalPluginActivationEvent}.
 * Same swap pattern when ADR-0335 lands.
 */
export interface LocalAppActivationEvent {
  readonly kind: "app_activation"
  readonly appId: string
  readonly surface: "cli" | "web-tauri" | "cli-browser"
  readonly trigger: "user" | "auto" | "system"
  readonly at: number
  readonly turnId?: string
}
