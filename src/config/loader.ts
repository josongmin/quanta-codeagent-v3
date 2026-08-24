/**
 * Layered file reader for the central config slice (ADR-0497, jun-7-misc 05).
 *
 * Generalizes the single-key `settings-loader.ts` read-discipline to the full
 * layered schema. Per-layer parse is FAIL-SOFT, identical posture to
 * `settings-loader.ts:13,58-66,87-91` and `migration/external-config/persist.ts:281`:
 *   - missing file (ENOENT/ENOTDIR)        ⇒ skip the layer (absent is normal)
 *   - malformed JSON / non-object root     ⇒ skip the layer + ONE stderr warn
 *   - a real IO fault (EACCES, …)          ⇒ PROPAGATES (a required layer that
 *                                            cannot be read is a real fault)
 * NEVER throws on absent/malformed; NEVER half-applies a corrupt file (the
 * whole layer is dropped, never partially merged), so a corrupt higher layer
 * cannot clobber a valid lower layer.
 *
 * The filesystem read is injected as a {@link ReadTextPort} closed port so the
 * default-OFF byte-identity hellgate can assert ZERO reads when the knob is
 * off, and so the concrete `node:fs` IO is wired only at the composition root.
 */

import type {
  EndpointNetworkPolicy,
  EndpointSecretRef,
  EndpointWireApi,
  HookGroupSetting,
  HooksSettings,
  LayerBenign,
  LayerSecurity,
  McpSettings,
  OpenAIEndpointOptions,
  PermissionSettings,
  SettingsLayer,
  SettingsLayerName,
} from "./types"
import { ENDPOINT_SECRET_REFS } from "./types"

/** Closed-port file read: returns the text, or `undefined` for a missing file
 *  (ENOENT/ENOTDIR), or THROWS for a real IO fault (EACCES, …). The concrete
 *  `node:fs/promises` implementation is injected at the composition root. */
export type ReadTextPort = (path: string) => Promise<string | undefined>

/** Optional warn sink for a malformed-but-present layer. Injected (never a
 *  direct `process.stderr` reach inside the pure module). */
export type WarnSink = (message: string) => void

/** Discovery paths for the four layers. A layer with `undefined` path is not
 *  discovered (e.g. no managed path on this OS, or `--setting-sources` dropped
 *  it). */
export type LayerPaths = Readonly<Record<SettingsLayerName, string | undefined>>

const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

const asStringArray = (v: unknown): readonly string[] | undefined => {
  if (!Array.isArray(v)) return undefined
  // round-4 F7: parse-time TRIM parity with the hook-command parse
  // (`ho.command.trim().length > 0`, loader.ts:81). A whitespace-only
  // permission rule (`allow: ["  "]`) carries NO meaning today, but if a future
  // permission matcher trims-then-prefix-matches, a `"  "` rule could collapse
  // into an unexpected wildcard. Dropping whitespace-only rules at parse — the
  // SAME normalization the hook path already applies — keeps a whitespace rule
  // from ever becoming load-bearing. (Non-empty rules are carried verbatim; we
  // filter, we do not rewrite, so a legitimately-spaced rule like `Bash(ls a)`
  // is unaffected — only an ALL-whitespace token is dropped.)
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
  return out.length > 0 ? out : undefined
}

const asBoolean = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined)

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined

/** The command hooks inside ONE group. Only `{type:"command", command:<non-empty>}` survives —
 *  a non-object entry, a non-`command` type, a missing/non-string command, or a whitespace-only
 *  command is dropped. A non-array `hooks` value yields none. */
const parseCommandHooks = (raw: unknown): { type?: string; command?: string }[] => {
  const hooks: { type?: string; command?: string }[] = []
  for (const h of Array.isArray(raw) ? raw : []) {
    const ho = asObject(h)
    if (ho?.type === "command" && typeof ho.command === "string" && ho.command.trim().length > 0) {
      hooks.push({ type: "command", command: ho.command })
    }
  }
  return hooks
}

/** ONE hook group → a typed setting, or `undefined` when it is not an object or carries no usable
 *  command hook (an empty group is DROPPED, never carried as an empty shell). */
const parseHookGroup = (raw: unknown): HookGroupSetting | undefined => {
  const group = asObject(raw)
  if (group === undefined) return undefined
  const hooks = parseCommandHooks(group.hooks)
  if (hooks.length === 0) return undefined
  const matcher = asString(group.matcher)
  return { ...(matcher !== undefined ? { matcher } : {}), hooks }
}

/** Parse a `hooks` block (Claude shape: EventName → groups) into typed groups.
 *  Mirrors `settings-loader.ts` / `claude-code-config.ts` extraction. Only
 *  `{type:"command", command:<non-empty>}` hooks are carried. */
const parseHookEvents = (
  raw: unknown,
): Readonly<Record<string, readonly HookGroupSetting[]>> | undefined => {
  const events = asObject(raw)
  if (events === undefined) return undefined
  // NULL-PROTOTYPE accumulator (round-3 F6 defense-in-depth): an event name of
  // `__proto__` must be a safe own-key, never a reach into Object.prototype
  // (with a plain `{}`, `out["__proto__"] ?? []` is the prototype object → no
  // `.push` → TypeError; and `out["__proto__"] = …` mutates the prototype).
  const out: Record<string, HookGroupSetting[]> = Object.create(null)
  for (const [event, rawGroups] of Object.entries(events)) {
    if (!Array.isArray(rawGroups)) continue
    for (const rawGroup of rawGroups) {
      const group = parseHookGroup(rawGroup)
      if (group === undefined) continue
      const bucket = out[event] ?? []
      bucket.push(group)
      out[event] = bucket
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const WIRE_APIS: ReadonlySet<string> = new Set<EndpointWireApi>(["chat", "responses"])
const NETWORK_POLICIES: ReadonlySet<string> = new Set<EndpointNetworkPolicy>([
  "public_https",
  "loopback_local",
])
const SECRET_REFS: ReadonlySet<string> = new Set<string>(ENDPOINT_SECRET_REFS)

/** Coerce a value to a member of the fixed symbolic-ref allowlist, or
 *  `undefined` (which the caller treats as a REJECTION, not "absent"). */
const asSecretRef = (v: unknown): EndpointSecretRef | undefined =>
  typeof v === "string" && SECRET_REFS.has(v) ? (v as EndpointSecretRef) : undefined

/** A string→string map with all NON-empty string values (query params).
 *  `null` = present-but-malformed (reject the endpoint); `undefined` = absent. */
const asStringMap = (v: unknown): Readonly<Record<string, string>> | null => {
  const obj = asObject(v)
  if (obj === undefined) return null
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(obj)) {
    if (typeof val !== "string" || val.length === 0) return null // any non-string ⇒ reject
    out[k] = val
  }
  return out
}

/** Validate a `headerRefs` block: every value must be an allowlisted symbolic
 *  ref (no raw values, no cross-provider env names). `null` = present-but-
 *  invalid (reject the endpoint); a map (possibly empty) = valid. */
const parseHeaderRefs = (v: unknown): Readonly<Record<string, EndpointSecretRef>> | null => {
  const hr = asObject(v)
  if (hr === undefined) return null
  const refs: Record<string, EndpointSecretRef> = {}
  for (const [header, refRaw] of Object.entries(hr)) {
    const ref = asSecretRef(refRaw)
    if (ref === undefined) return null // any non-allowlisted value ⇒ reject endpoint
    refs[header] = ref
  }
  return refs
}

/** Parse the four REQUIRED endpoint fields (baseUrl/wireApi/model/networkPolicy)
 *  into a base record, or `undefined` when any is missing/out-of-set. Also
 *  refuses a raw `headers` block (a secret-value smuggling vector). */
const parseEndpointCore = (
  obj: Record<string, unknown>,
): Pick<OpenAIEndpointOptions, "baseUrl" | "wireApi" | "model" | "networkPolicy"> | undefined => {
  if ("headers" in obj) return undefined // static header VALUES could smuggle a token
  const baseUrl = asString(obj.baseUrl)
  const model = asString(obj.model)
  if (baseUrl === undefined || model === undefined) return undefined
  if (typeof obj.wireApi !== "string" || !WIRE_APIS.has(obj.wireApi)) return undefined
  if (typeof obj.networkPolicy !== "string" || !NETWORK_POLICIES.has(obj.networkPolicy))
    return undefined
  return {
    baseUrl,
    model,
    wireApi: obj.wireApi as EndpointWireApi,
    networkPolicy: obj.networkPolicy as EndpointNetworkPolicy,
  }
}

/**
 * Parse ONE named OpenAI endpoint profile (RFC05-0). Returns the typed record
 * or `undefined` (DROP the whole endpoint — fail-closed) when ANY field is
 * missing/out-of-set. The load-bearing anti-exfil guards:
 *   - `wireApi`/`networkPolicy` must be in their closed unions;
 *   - `authRef` (if present) must be in {@link ENDPOINT_SECRET_REFS} — an
 *     arbitrary env name like `ANTHROPIC_API_KEY` is REJECTED (audit A1);
 *   - `headerRefs` values must all be symbolic refs (no raw values, no
 *     cross-provider env names);
 *   - a raw `headers` block (static header VALUES, which could smuggle a bearer
 *     token) is REJECTED outright — only symbolic `headerRefs` are allowed.
 *   - unknown keys are ignored (the whole shape is re-built field-by-field).
 */
const parseOneEndpoint = (raw: unknown): OpenAIEndpointOptions | undefined => {
  const obj = asObject(raw)
  if (obj === undefined) return undefined
  const core = parseEndpointCore(obj)
  if (core === undefined) return undefined

  const out: { -readonly [K in keyof OpenAIEndpointOptions]: OpenAIEndpointOptions[K] } = {
    ...core,
  }
  if (obj.authRef !== undefined) {
    const ref = asSecretRef(obj.authRef)
    if (ref === undefined) return undefined // present-but-not-allowlisted ⇒ reject
    out.authRef = ref
  }
  if (obj.headerRefs !== undefined) {
    const refs = parseHeaderRefs(obj.headerRefs)
    if (refs === null) return undefined // present-but-invalid ⇒ reject
    if (Object.keys(refs).length > 0) out.headerRefs = refs
  }
  if (obj.query !== undefined) {
    const q = asStringMap(obj.query)
    if (q === null) return undefined // present-but-malformed ⇒ reject
    if (Object.keys(q).length > 0) out.query = q
  }
  return out
}

/** Parse the `openaiEndpoints` id→profile map (RFC05-0). Each id whose profile
 *  fails validation is DROPPED (fail-closed); a valid sibling survives. Returns
 *  `undefined` when nothing valid remains. */
const parseOpenAIEndpoints = (
  raw: unknown,
): Readonly<Record<string, OpenAIEndpointOptions>> | undefined => {
  const obj = asObject(raw)
  if (obj === undefined) return undefined
  // NULL-PROTOTYPE accumulator: an endpoint id of `__proto__` must be a safe
  // own-key, never a reach into Object.prototype (parity with parseHookEvents).
  const out: Record<string, OpenAIEndpointOptions> = Object.create(null)
  for (const [id, rawEp] of Object.entries(obj)) {
    if (id.trim().length === 0) continue
    const ep = parseOneEndpoint(rawEp)
    if (ep !== undefined) out[id] = ep
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * A section's parse TABLE: one reader per OPTIONAL field of `T`, keyed by that field's name.
 *
 * The `-?` in the mapped type is the drift guard — adding a field to `PermissionSettings` /
 * `HooksSettings` / `McpSettings` / `LayerSecurity` / `SettingsLayer` without adding its reader
 * here is a COMPILE error, not a silently-dropped setting. Each reader takes the whole raw object
 * (not just `raw[key]`) because one field — `hooks.events` — legitimately reads two shapes.
 */
type FieldRules<T> = {
  readonly [K in keyof Required<T>]-?: (raw: Record<string, unknown>) => T[K] | undefined
}

/** The plain "read this key and coerce it" reader, which is all but one field needs. */
const field =
  <V>(key: string, coerce: (v: unknown) => V | undefined) =>
  (raw: Record<string, unknown>): V | undefined =>
    coerce(raw[key])

/**
 * Assemble ONE section from its table: run every reader, keep the fields that produced a value,
 * and return `undefined` when NOTHING survived.
 *
 * That last rule — "a section with no surviving field is ABSENT, never an empty shell" — is the
 * one the pre-split `parseSettingsLayer` spelled out five separate times (once per sub-object,
 * once for the security band, once for the benign band). It is written here exactly once, so a
 * new section cannot accidentally start carrying `{}` past the trust gate. Key insertion order
 * follows the table, which is what keeps the parsed layer byte-stable for snapshot round-trips.
 */
const collectSection = <T extends object>(
  raw: Record<string, unknown>,
  rules: FieldRules<T>,
): T | undefined => {
  const out: Record<string, unknown> = {}
  for (const [key, read] of Object.entries(rules)) {
    const value = (read as (r: Record<string, unknown>) => unknown)(raw)
    if (value !== undefined) out[key] = value
  }
  return Object.keys(out).length > 0 ? (out as T) : undefined
}

/** A NESTED section: descend into `raw[key]` (which must be an object) and collect it there. */
const nested =
  <T extends object>(key: string, rules: FieldRules<T>) =>
  (raw: Record<string, unknown>): T | undefined => {
    const obj = asObject(raw[key])
    return obj === undefined ? undefined : collectSection(obj, rules)
  }

const PERMISSION_FIELDS: FieldRules<PermissionSettings> = {
  allow: field("allow", asStringArray),
  deny: field("deny", asStringArray),
  ask: field("ask", asStringArray),
  allowManagedPermissionRulesOnly: field("allowManagedPermissionRulesOnly", asBoolean),
}

const HOOKS_FIELDS: FieldRules<HooksSettings> = {
  // The one non-plain reader: `hooks` accepts BOTH the nested `{ events: {...} }` shape and a
  // bare Claude event map sitting directly under `hooks`.
  events: (raw) => parseHookEvents(raw.events ?? raw),
  allowManagedHooksOnly: field("allowManagedHooksOnly", asBoolean),
}

const MCP_FIELDS: FieldRules<McpSettings> = {
  enabledServers: field("enabledServers", asStringArray),
  // E2 — denylist (tightening; enforced by the launch-policy filter).
  deniedServers: field("deniedServers", asStringArray),
  // E1-sub — managed-non-overridable MCP (mirrors allowManagedHooksOnly).
  allowManagedMcpServersOnly: field("allowManagedMcpServersOnly", asBoolean),
}

/** The SECURITY band — every field here is capability-granting and therefore trust-gated. */
const SECURITY_FIELDS: FieldRules<LayerSecurity> = {
  permissions: nested("permissions", PERMISSION_FIELDS),
  hooks: nested("hooks", HOOKS_FIELDS),
  mcp: nested("mcp", MCP_FIELDS),
  openaiEndpoints: field("openaiEndpoints", parseOpenAIEndpoints),
}

/** The BENIGN band — grants no capability, so it survives an untrusted layer. */
const BENIGN_FIELDS: FieldRules<LayerBenign> = {
  model: field("model", asString),
}

/** The layer itself is the same shape one level up: two bands, each absent when empty. */
const LAYER_FIELDS: FieldRules<SettingsLayer> = {
  security: (raw) => collectSection(raw, SECURITY_FIELDS),
  benign: (raw) => collectSection(raw, BENIGN_FIELDS),
}

/** Parse one already-read JSON text into a typed {@link SettingsLayer}.
 *  Malformed text / non-object root ⇒ `undefined` (caller skips the layer).
 *  Unknown keys are DROPPED — nothing un-discriminated survives. Exported so a
 *  host (or test) can reuse the exact parse without a filesystem round-trip.
 *
 *  A well-formed object root that carries NOTHING recognized parses to `{}` — a
 *  PRESENT but empty layer, which is distinct from the `undefined` a malformed
 *  file returns (that one makes the caller warn and skip). */
export const parseSettingsLayer = (text: string): SettingsLayer | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const root = asObject(parsed)
  if (root === undefined) return undefined
  return collectSection(root, LAYER_FIELDS) ?? {}
}

/** Read + parse all four layers, fail-soft per layer. Returns a partial map of
 *  the layers that were present-and-parseable. A layer whose path is
 *  `undefined` is skipped (not discovered). ENOENT/ENOTDIR ⇒ skipped silently;
 *  malformed ⇒ skipped + ONE warn; a real IO fault propagates. */
export const readLayers = async (
  paths: LayerPaths,
  read: ReadTextPort,
  warn: WarnSink,
): Promise<Partial<Record<SettingsLayerName, SettingsLayer>>> => {
  const out: Partial<Record<SettingsLayerName, SettingsLayer>> = {}
  for (const layer of ["managed", "user", "project", "local"] as const) {
    const path = paths[layer]
    if (path === undefined) continue
    const text = await read(path) // a real IO fault (EACCES) propagates here
    if (text === undefined) continue // missing ⇒ skip
    const parsed = parseSettingsLayer(text)
    if (parsed === undefined) {
      // malformed-but-present ⇒ skip the whole layer, never half-apply
      warn(`[quanta] central config: skipped malformed ${layer} layer settings file`)
      continue
    }
    out[layer] = parsed
  }
  return out
}
