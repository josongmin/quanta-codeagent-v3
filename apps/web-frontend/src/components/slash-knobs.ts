/**
 * Knobs settings data layer — talks to the daemon's `GET /api/knobs`
 * (read) and `POST /config` (write) endpoints. Pure helper module: no
 * React imports, so the grouping / filtering / fetch logic is unit-testable
 * without a DOM.
 *
 * Mirrors the `slash-llm-config.ts` / `slash-auth.ts` shape — pass an
 * `{ httpUrl, token }` endpoint derived from the WS URL (see
 * `httpUrlFromWsUrl`) and the helpers attach the Bearer header.
 *
 * Write surface is deliberately narrow: `/config` enforces a CLOSED
 * allowlist server-side (`CONFIG_ALLOWED_KEYS`). We mirror that allowlist
 * here as `CONFIG_WRITABLE_KEYS` so the UI can render non-allowlisted knobs
 * read-only instead of POSTing a request the daemon will reject with 400.
 * If the two drift, the worst case is a rejected POST surfaced as an error
 * toast — never a silent success.
 */

/** One knob row as returned by `GET /api/knobs`. */
export interface KnobEntry {
  readonly envKey: string
  readonly kind: string
  readonly default: unknown
  readonly describe: string
  readonly home: string
  readonly hotToggleable: boolean
  /** Current effective value. String values are redacted server-side. */
  readonly value: unknown
  /** Where the current value came from. */
  readonly source: string
  readonly isDefault: boolean
}

/** One group of knobs as returned by `GET /api/knobs`. */
export interface KnobGroup {
  readonly group: string
  readonly knobs: readonly KnobEntry[]
}

/** Full `GET /api/knobs` response envelope. */
export interface KnobsResponse {
  readonly total: number
  readonly groups: readonly KnobGroup[]
}

/** Endpoint descriptor — same shape as the LLM-config / auth endpoints. */
export interface KnobsEndpoint {
  /** Full HTTP base URL for the daemon, e.g. `http://127.0.0.1:4096`. */
  readonly httpUrl: string
  /** Bearer token from the WS auth handshake (same value). */
  readonly token?: string
}

/**
 * Closed allowlist of env keys the daemon's `POST /config` endpoint accepts.
 * Mirrors `CONFIG_ALLOWED_KEYS` in `src/apps/web-daemon/server.ts`. Knobs
 * whose `envKey` is NOT in this set render read-only even when the manifest
 * marks them `hotToggleable` — the toggle would 400.
 */
export const CONFIG_WRITABLE_KEYS: ReadonlySet<string> = new Set([
  "QUANTA_FAST",
  "QUANTA_SERVICE_TIER",
  "QUANTA_MODEL",
  "QUANTA_REASONING_EFFORT",
])

/** Sentinel the daemon emits for redacted string values. */
const REDACTED_DISPLAY = "[redacted]"

const baseUrl = (ep: KnobsEndpoint): string => ep.httpUrl.replace(/\/+$/, "")

const authHeaders = (ep: KnobsEndpoint): Record<string, string> => ({
  ...(ep.token !== undefined ? { authorization: `Bearer ${ep.token}` } : {}),
})

/** Fetch + validate the knobs manifest. Throws on network / shape errors so
 *  the caller can render an error state. */
export const fetchKnobs = async (
  ep: KnobsEndpoint,
  signal?: AbortSignal,
): Promise<KnobsResponse> => {
  const res = await fetch(`${baseUrl(ep)}/api/knobs`, {
    method: "GET",
    headers: authHeaders(ep),
    ...(signal !== undefined ? { signal } : {}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`knobs fetch failed (${res.status})${text.length > 0 ? `: ${text.slice(0, 120)}` : ""}`)
  }
  const json: unknown = await res.json()
  return parseKnobsResponse(json)
}

/** Narrow an unknown JSON payload into a `KnobsResponse`. Tolerant of
 *  missing optional fields; throws if the top-level shape is wrong. */
export const parseKnobsResponse = (json: unknown): KnobsResponse => {
  if (json === null || typeof json !== "object") {
    throw new Error("knobs response is not an object")
  }
  const obj = json as Record<string, unknown>
  const rawGroups = Array.isArray(obj.groups) ? obj.groups : []
  const groups: KnobGroup[] = rawGroups.map((g) => {
    const go = (g ?? {}) as Record<string, unknown>
    const rawKnobs = Array.isArray(go.knobs) ? go.knobs : []
    return {
      group: typeof go.group === "string" ? go.group : "(ungrouped)",
      knobs: rawKnobs.map(parseKnobEntry),
    }
  })
  const total = typeof obj.total === "number" ? obj.total : groups.reduce((n, g) => n + g.knobs.length, 0)
  return { total, groups }
}

const parseKnobEntry = (raw: unknown): KnobEntry => {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    envKey: typeof o.envKey === "string" ? o.envKey : "(unknown)",
    kind: typeof o.kind === "string" ? o.kind : "unknown",
    default: o.default,
    describe: typeof o.describe === "string" ? o.describe : "",
    home: typeof o.home === "string" ? o.home : "",
    hotToggleable: o.hotToggleable === true,
    value: o.value,
    source: typeof o.source === "string" ? o.source : "default",
    isDefault: o.isDefault === true,
  }
}

/**
 * POST a single env override to `/config`. Pass `value: null` to clear (the
 * daemon deletes the env key, reverting to its built-in default). Resolves
 * to an `{ ok, error? }` result rather than throwing so the UI can keep the
 * panel open and surface a row-level error.
 */
export const postKnobValue = async (
  ep: KnobsEndpoint,
  envKey: string,
  value: string | null,
): Promise<{ ok: boolean; error?: string }> => {
  try {
    const res = await fetch(`${baseUrl(ep)}/config`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ep) },
      body: JSON.stringify({ [envKey]: value }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return { ok: false, error: `HTTP ${res.status}${text.length > 0 ? `: ${text.slice(0, 120)}` : ""}` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** True when the manifest marks the knob hot-toggleable AND its env key is in
 *  the daemon's closed write allowlist. Anything else is read-only. */
export const isWritableKnob = (knob: KnobEntry): boolean =>
  knob.hotToggleable && CONFIG_WRITABLE_KEYS.has(knob.envKey)

/** True when the knob is a hot-toggleable boolean we can render as a switch. */
export const isToggleableBool = (knob: KnobEntry): boolean =>
  isWritableKnob(knob) && knob.kind === "bool"

/** Interpret a knob's current value as a boolean (for the toggle state). */
export const knobBoolValue = (knob: KnobEntry): boolean => {
  const v = knob.value
  if (typeof v === "boolean") return v
  if (typeof v === "string") {
    const s = v.trim().toLowerCase()
    return s === "1" || s === "on" || s === "true" || s === "yes"
  }
  if (typeof v === "number") return v !== 0
  return false
}

/**
 * Render a knob's current value for display. String values arrive already
 * redacted from the server when sensitive; we additionally map the literal
 * redaction sentinel to `[redacted]` and never attempt to un-redact.
 */
export const displayKnobValue = (knob: KnobEntry): string => {
  const v = knob.value
  if (v === null || v === undefined) return "(unset)"
  if (typeof v === "boolean") return v ? "on" : "off"
  if (typeof v === "string") {
    if (v.length === 0) return "(empty)"
    if (v === REDACTED_DISPLAY || v === "[REDACTED]" || v === "***") return REDACTED_DISPLAY
    return v
  }
  if (typeof v === "number") return String(v)
  return JSON.stringify(v)
}

/** Filter groups by a free-text query over envKey / describe / group.
 *  Returns groups with their knob lists narrowed; empty groups are dropped. */
export const filterKnobGroups = (
  groups: readonly KnobGroup[],
  query: string,
): readonly KnobGroup[] => {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return groups
  const result: KnobGroup[] = []
  for (const g of groups) {
    const groupMatches = g.group.toLowerCase().includes(q)
    const knobs = groupMatches
      ? g.knobs
      : g.knobs.filter(
          (k) =>
            k.envKey.toLowerCase().includes(q) ||
            k.describe.toLowerCase().includes(q),
        )
    if (knobs.length > 0) result.push({ group: g.group, knobs })
  }
  return result
}
