/** H19 — inbound resource/prompt notification routing (server → client, no
 *  reply obligation).
 *
 *  A server that supports subscriptions emits NOTIFICATIONS (a `method` WITHOUT
 *  an `id`) when its resources/prompts change:
 *   - `notifications/resources/updated`     — a subscribed resource changed
 *     (params carry `{ uri }`);
 *   - `notifications/resources/list_changed` — the resource LIST changed;
 *   - `notifications/prompts/list_changed`   — the prompt LIST changed.
 *
 *  These feed an OPTIONAL observer. When no observer is wired the notifications
 *  are ignored gracefully (byte-identical to not handling them at all), exactly
 *  like the pre-H19 client which dropped all inbound notifications.
 */

/** A parsed inbound resource/prompt notification. A closed union so observers
 *  branch without string-matching the method. */
export type McpResourceNotification =
  | { readonly kind: "resource_updated"; readonly uri: string }
  | { readonly kind: "resource_list_changed" }
  | { readonly kind: "prompt_list_changed" }

/** Optional sink for resource/prompt change notifications. Total + no-throw is
 *  the contract; the router never awaits it. */
export interface McpResourceObserver {
  onNotification(event: McpResourceNotification): void
}

export const RESOURCE_UPDATED_METHOD = "notifications/resources/updated"
export const RESOURCE_LIST_CHANGED_METHOD = "notifications/resources/list_changed"
export const PROMPT_LIST_CHANGED_METHOD = "notifications/prompts/list_changed"

/** Returns true iff `method` is one of the three notifications we route. */
export const isResourceNotificationMethod = (method: string): boolean =>
  method === RESOURCE_UPDATED_METHOD ||
  method === RESOURCE_LIST_CHANGED_METHOD ||
  method === PROMPT_LIST_CHANGED_METHOD

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** DoS bound — maximum characters retained from an inbound `resource_updated`
 *  notification `uri`. A hostile server can emit a multi-megabyte `uri` on a
 *  subscribed resource; we keep only the bounded prefix so the notification is
 *  never a large retain (no OOM). 8192 sits well above any realistic resource
 *  URI (cf. common 2048-byte URL limits) while bounding the worst case. */
export const RESOURCE_UPDATED_MAX_URI_CHARS = 8192

/** Parse a known notification method + params into a typed event, or null when
 *  the method is unknown or the `resource_updated` params lack a `uri`. An
 *  oversized `uri` is length-capped (bounded prefix) rather than retained. */
export const parseResourceNotification = (
  method: string,
  params: unknown,
): McpResourceNotification | null => {
  if (method === RESOURCE_UPDATED_METHOD) {
    const uri = asRecord(params)?.uri
    if (typeof uri !== "string" || uri === "") return null
    // DoS bound: keep only the bounded prefix of an oversized uri (no large
    // retain). `slice` on an over-cap string returns a new bounded string.
    const bounded =
      uri.length > RESOURCE_UPDATED_MAX_URI_CHARS
        ? uri.slice(0, RESOURCE_UPDATED_MAX_URI_CHARS)
        : uri
    return { kind: "resource_updated", uri: bounded }
  }
  if (method === RESOURCE_LIST_CHANGED_METHOD) return { kind: "resource_list_changed" }
  if (method === PROMPT_LIST_CHANGED_METHOD) return { kind: "prompt_list_changed" }
  return null
}

/** Route an inbound notification to `observer` (when present). Never throws: an
 *  observer that throws is swallowed so a buggy sink can never crash the
 *  transport's message pump. Absent observer ⇒ no-op. */
export const routeResourceNotification = (
  observer: McpResourceObserver | undefined,
  method: string,
  params: unknown,
): void => {
  if (observer === undefined) return
  const event = parseResourceNotification(method, params)
  if (event === null) return
  try {
    observer.onNotification(event)
  } catch {
    // Defensive: the observer contract is total, but a throwing custom impl
    // must not propagate into the transport message loop.
  }
}
