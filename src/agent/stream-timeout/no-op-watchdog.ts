/**
 * ADR-0200 — No-op pass-through watchdog.
 *
 * Default assembly choice. Yields the source iterator verbatim — same
 * shape as direct `for await (const ev of src)`. Used so EVERY caller
 * is free to assume `config.streamWatchdog` is always present without a
 * `?.` chain in the hot path.
 *
 * Plane-clean: imports the port only.
 */

import type { StreamWatchdog } from "./port"

export const noOpWatchdog = (): StreamWatchdog => ({
  wrap<T>(src: AsyncIterable<T>): AsyncIterable<T> {
    return src
  },
})
