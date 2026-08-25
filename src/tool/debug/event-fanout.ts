/**
 * W5 — the event fan-out shared by the two protocol clients.
 *
 * {@link DapClient} (Content-Length-framed DAP over stdio) and {@link CdpClient}
 * (one JSON message per WebSocket frame) decode completely different wire
 * formats, but once a message is known to be an EVENT they did the identical
 * thing, spelled twice verbatim: notify every persistent subscriber (a throwing
 * subscriber must not break the read loop), then drain and clear the one-shot
 * waiters armed for that key. That tail lives here once so the two clients
 * cannot drift apart on the parts that are genuinely the same — the delivery
 * ORDER (subscribers before waiters), the swallow, and the "waiters are one-shot,
 * so an event with none armed is dropped rather than queued" rule.
 *
 * Deliberately NOT shared: everything above it. Response correlation keys on
 * `request_seq` for DAP and `id` for CDP, and the two carry different optional
 * payload shapes — pretending those are one thing is how a protocol client gets
 * subtly wrong.
 */

/** Both clients' subscriber and resolver types erase to this. */
export type FanoutHandler = (payload: unknown) => void

/** Register `handler` under `key`, minting the Set on first use. A Set (not an
 *  array) is the contract: subscribing the SAME function twice fires it once. */
export const addHandler = (
  handlers: Map<string, Set<FanoutHandler>>,
  key: string,
  handler: FanoutHandler,
): void => {
  let set = handlers.get(key)
  if (set === undefined) {
    set = new Set()
    handlers.set(key, set)
  }
  set.add(handler)
}

/** Arm a ONE-SHOT waiter for `key`. Several waiters may be armed at once; they
 *  all resolve on the next occurrence and are then cleared together. */
export const armWaiter = (
  waiters: Map<string, FanoutHandler[]>,
  key: string,
  resolve: FanoutHandler,
): void => {
  const arr = waiters.get(key) ?? []
  arr.push(resolve)
  waiters.set(key, arr)
}

/** Deliver one event: persistent subscribers first (in registration order, each
 *  isolated by its own try so a buggy one cannot break the read loop), then the
 *  armed one-shot waiters, which are removed BEFORE they are resolved. */
export const fanOutEvent = (
  handlers: Map<string, Set<FanoutHandler>>,
  waiters: Map<string, FanoutHandler[]>,
  key: string,
  payload: unknown,
): void => {
  for (const h of handlers.get(key) ?? []) {
    try {
      h(payload)
    } catch {
      // A buggy subscriber must not break the read loop.
    }
  }
  const arr = waiters.get(key)
  if (arr !== undefined && arr.length > 0) {
    waiters.delete(key)
    for (const resolve of arr) resolve(payload)
  }
}
