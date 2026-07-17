/**
 * Subagent message delivery-mode vocabulary (RFC jul-18 — subagent message
 * delivery modes). A dependency-free shared leaf so every layer that must name
 * a delivery mode — the `followup_task` tool schema, the `@/agent` delivery
 * controller, the child control endpoint, and observability — imports ONE
 * canonical union instead of re-declaring string literals.
 *
 * Two ORTHOGONAL axes (RFC §3.1). They are deliberately separate types: a
 * caller expresses *when the model receives the message* (`mode`) independently
 * of *whether an idle child should be scheduled* (`activation`).
 *
 *   - {@link DeliveryMode}     — queue | steer | interrupt
 *   - {@link ActivationPolicy} — passive | ensure-turn
 *
 * The legacy root-thread policy (`src/agent/inbound-mode.ts`) still names
 * Codex-style steer `weave` at its CLI/config boundary; that module maps
 * `weave → steer` before policy evaluation (RFC §1.2). This leaf owns ONLY the
 * canonical vocabulary + strict parsing + two-way drift guards — never policy,
 * so there is no second fallback table (RFC §7 static rail).
 */

/** When the target child's model receives the message. */
export type DeliveryMode = "queue" | "steer" | "interrupt"

/** Whether an idle child should be scheduled a fresh turn for this delivery. */
export type ActivationPolicy = "passive" | "ensure-turn"

/** All delivery modes enumerated — tests assert exhaustive coverage without
 *  `as const` gymnastics; the drift guard below pins union⇔array both ways. */
export const ALL_DELIVERY_MODES = ["queue", "steer", "interrupt"] as const satisfies readonly DeliveryMode[]

/** All activation policies enumerated (drift-guarded below). */
export const ALL_ACTIVATION_POLICIES = [
  "passive",
  "ensure-turn",
] as const satisfies readonly ActivationPolicy[]

// Drift guards: outer annotation removed so `[number]` is the literal tuple;
// Assert proves every union member is listed. New member → build error.
type _AssertMode<T extends true> = T
export type _DeliveryModeDriftGuard = _AssertMode<
  DeliveryMode extends (typeof ALL_DELIVERY_MODES)[number] ? true : false
>
export type _ActivationPolicyDriftGuard = _AssertMode<
  ActivationPolicy extends (typeof ALL_ACTIVATION_POLICIES)[number] ? true : false
>

/**
 * STRICT parse: an unknown/raw string is `undefined`, NEVER silently normalized
 * to `"queue"` (RFC §3.2 — "raw/unknown mode is rejected at the schema
 * boundary; it never normalizes to queue"). The caller turns `undefined` into a
 * typed `invalid_input` rejection; this leaf does not invent a fallback.
 */
export const parseDeliveryMode = (raw: unknown): DeliveryMode | undefined =>
  typeof raw === "string" && (ALL_DELIVERY_MODES as readonly string[]).includes(raw)
    ? (raw as DeliveryMode)
    : undefined

export const parseActivationPolicy = (raw: unknown): ActivationPolicy | undefined =>
  typeof raw === "string" && (ALL_ACTIVATION_POLICIES as readonly string[]).includes(raw)
    ? (raw as ActivationPolicy)
    : undefined

export const isDeliveryMode = (raw: unknown): raw is DeliveryMode =>
  parseDeliveryMode(raw) !== undefined
