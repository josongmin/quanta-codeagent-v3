/**
 * Browser slice — bounded network ring buffer (S1 strengthen, network capture).
 *
 * STRUCTURALLY CLONED from `./console-buffer.ts`: same dual bound (entry COUNT +
 * total metadata BYTES), same oldest-drop eviction, same `dropped` counter, same
 * pure/no-IO contract. A page that fires thousands of requests must never grow
 * this without bound.
 *
 * ★ METADATA ONLY. Each captured entry carries method/url/status/mime/size and
 * NOTHING ELSE. `Network.enable` streams request/response HEADERS and (with
 * extra opt-in) bodies — we deliberately never capture them: {@link
 * buildNetworkEntry} projects each CDP `Network.*` event down to the closed
 * {@link NetworkEntry} shape AT THE SOURCE, so cookies / auth tokens / PII are
 * structurally absent from the buffer, not merely redacted after the fact. This
 * is the leak guard, enforced in code rather than prose.
 *
 * Pure (no IO / no timers); the adapter pushes projected entries in and reads
 * them out. Unit-tested directly with synthetic events — no browser needed.
 */

import type { NetworkEntry } from "../types"

export interface NetworkBuffer {
  push(entry: NetworkEntry): void
  /** Snapshot the current entries + total dropped count. `clear` drains the
   *  buffer and resets the dropped counter. */
  drain(clear: boolean): { readonly entries: readonly NetworkEntry[]; readonly dropped: number }
}

export interface NetworkBufferOpts {
  /** Max retained entries (default 200 — mirrors the console buffer). */
  readonly maxEntries?: number
  /** Max total metadata bytes across retained entries (default 65536). */
  readonly maxBytes?: number
}

/** Cap the retained `mime` (server Content-Type) at the source. A real mimeType
 *  is short (`application/json; charset=utf-8`); the value is server-controlled
 *  and unbounded by CDP, so — like url/method — it must not enter the buffer at
 *  arbitrary length. Applied in {@link buildNetworkEntry} so the cap holds for
 *  EVERY producer path, and counted by {@link entryBytes} below. */
const MIME_CAP = 256

/** Approximate the retained-bytes footprint of ONE entry from its string fields
 *  (method + url + mime) plus a small fixed allowance for the numeric fields.
 *  Bodies / headers are never present; every retained string field IS counted
 *  here so the byte cap can never be defeated by page/server content (a long
 *  server mimeType is bounded both by MIME_CAP at the source and by this cap). */
const entryBytes = (e: NetworkEntry): number =>
  Buffer.byteLength(e.method, "utf8") +
  Buffer.byteLength(e.url, "utf8") +
  (e.mime !== undefined ? Buffer.byteLength(e.mime, "utf8") : 0) +
  24

export const createNetworkBuffer = (opts: NetworkBufferOpts = {}): NetworkBuffer => {
  const maxEntries = opts.maxEntries ?? 200
  const maxBytes = opts.maxBytes ?? 65_536
  let entries: NetworkEntry[] = []
  let bytes = 0
  let dropped = 0

  const evictOldest = (): void => {
    const e = entries.shift()
    if (e === undefined) return
    bytes -= entryBytes(e)
    dropped += 1
  }

  return {
    push(entry: NetworkEntry): void {
      entries.push(entry)
      bytes += entryBytes(entry)
      // Evict by either bound. Keep at least the just-pushed entry even if it
      // alone exceeds the byte cap (so a single huge url is still visible once,
      // not silently swallowed) — only drop it if there is something older.
      while (entries.length > maxEntries && entries.length > 0) evictOldest()
      while (bytes > maxBytes && entries.length > 1) evictOldest()
    },
    drain(clear: boolean) {
      const snapshot = entries.slice()
      const out = { entries: snapshot, dropped }
      if (clear) {
        entries = []
        bytes = 0
        dropped = 0
      }
      return out
    },
  }
}

const asObj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined

const str = (v: unknown): string => (typeof v === "string" ? v : "")
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)

/**
 * Project a CDP `Network.*` event param object down to the closed metadata-only
 * {@link NetworkEntry}. ★ THIS IS THE LEAK GUARD — it reads ONLY method / url /
 * status / mimeType / encodedDataLength and never touches `headers`, `postData`,
 * `body`, `cookies`, or any other field, so a body/header/token can never reach
 * the buffer even if the page/CDP puts it in the event. Malformed / absent
 * params degrade to empty metadata; never throws (slice no-throw contract).
 */
export const buildNetworkEntry = (method: string, params: unknown): NetworkEntry => {
  const p = asObj(params)
  switch (method) {
    case "Network.requestWillBeSent": {
      const req = asObj(p?.request)
      return { method: str(req?.method), url: str(req?.url) }
    }
    case "Network.responseReceived": {
      const res = asObj(p?.response)
      const out: NetworkEntry = { method: "", url: str(res?.url) }
      const status = num(res?.status)
      const mime = res?.mimeType
      return {
        ...out,
        ...(status !== undefined ? { status } : {}),
        ...(typeof mime === "string" ? { mime: mime.slice(0, MIME_CAP) } : {}),
      }
    }
    case "Network.loadingFinished": {
      const size = num(p?.encodedDataLength)
      return { method: "", url: "", ...(size !== undefined ? { size } : {}) }
    }
    case "Network.loadingFailed":
    default:
      // A failure event carries only an errorText (page-derived, unbounded) — we
      // do NOT surface it here; `status` is simply absent and the entry marks a
      // failed exchange with no url. Keeps the buffer strictly metadata.
      return { method: "", url: "" }
  }
}
