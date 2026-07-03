/**
 * B2 (jul-04) HELLGATE — deeplink ROUTE resolver. The pure consumer that was
 * missing: `parseThreadDeeplink` had ZERO callers, so a `quanta://threads/{id}`
 * emitted by `threads_handoff` was un-openable. This resolver is the surface-
 * agnostic entry point every host (Tauri OS deep-link event, web `window.location`)
 * funnels an incoming address through to obtain a typed `{ threadId }` route intent.
 *
 * Contract under test (RED-first):
 *   - Native scheme `quanta://threads/{id}` ⇒ `{ threadId }` (reuses parseThreadDeeplink).
 *   - Web fallback `?thread=<id>` (query) ⇒ `{ threadId }`.
 *   - Web fallback `#thread=<id>` (hash)  ⇒ `{ threadId }`.
 *   - Non-thread / malformed / empty inputs ⇒ `null` (never throws).
 *   - Round-trip: resolveThreadRoute(buildThreadDeeplink(id)) === { threadId: id }.
 *   - Precedence: an explicit native scheme wins over a query param when both present.
 *
 * Pure: no window, no DOM, no clock. Takes a plain string (a URI or a URL). The
 * host supplies `window.location.href` / the OS event payload.
 */

import { describe, expect, test } from "bun:test"
import { buildThreadDeeplink } from "@/scheduler/deeplink"
import {
  resolveThreadRoute,
  type ThreadRouteIntent,
  THREAD_WEB_PARAM,
} from "@/scheduler/deeplink-route"

describe("B2 resolveThreadRoute — native quanta:// scheme", () => {
  test("RT-01: quanta://threads/{id} ⇒ { threadId }", () => {
    expect(resolveThreadRoute("quanta://threads/abc123")).toEqual({ threadId: "abc123" })
  })

  test("RT-02: round-trips buildThreadDeeplink for url-unsafe + unicode ids", () => {
    for (const id of ["abc123", "a/b c?d#e", "한글-id", "with%20pct", "t-42"]) {
      const uri = buildThreadDeeplink(id)
      expect(resolveThreadRoute(uri)).toEqual({ threadId: id })
    }
  })
})

describe("B2 resolveThreadRoute — web fallback URL", () => {
  test("RT-03: ?thread=<id> query param ⇒ { threadId }", () => {
    expect(resolveThreadRoute("http://localhost:5173/?thread=t-99")).toEqual({ threadId: "t-99" })
  })

  test("RT-04: #thread=<id> hash param ⇒ { threadId }", () => {
    expect(resolveThreadRoute("http://localhost:5173/#thread=t-hash")).toEqual({
      threadId: "t-hash",
    })
  })

  test("RT-05: THREAD_WEB_PARAM is the exported query/hash key (no magic string drift)", () => {
    expect(THREAD_WEB_PARAM).toBe("thread")
    const url = `http://localhost:5173/?${THREAD_WEB_PARAM}=t-key`
    expect(resolveThreadRoute(url)).toEqual({ threadId: "t-key" })
  })

  test("RT-06: percent-encoded query id is decoded (URLSearchParams semantics)", () => {
    // %2F is '/', space encoded as %20 — a raw thread id with url-unsafe chars.
    expect(resolveThreadRoute("http://localhost:5173/?thread=a%2Fb%20c")).toEqual({
      threadId: "a/b c",
    })
  })

  test("RT-07: query wins when both query and hash carry a thread (query is canonical)", () => {
    expect(resolveThreadRoute("http://localhost:5173/?thread=q-id#thread=h-id")).toEqual({
      threadId: "q-id",
    })
  })
})

describe("B2 resolveThreadRoute — precedence: native scheme beats web fallback", () => {
  test("RT-08: a quanta:// scheme is honored even if the string also looks URL-ish", () => {
    // The native prefix match happens first; there is no query on a quanta:// URI
    // but a defensive input that appends one must still resolve the SCHEME id.
    expect(resolveThreadRoute("quanta://threads/native-id?thread=other")).toEqual({
      threadId: "native-id?thread=other",
    })
    // ^ parseThreadDeeplink treats everything after the prefix as the (encoded)
    //   id; a raw '?' is not percent-decoded away, so this documents that a
    //   native URI is opaque past the prefix (the emitter always encodes).
  })
})

describe("B2 resolveThreadRoute — rejects non-thread / malformed (no throw)", () => {
  test("RT-09: foreign scheme ⇒ null", () => {
    expect(resolveThreadRoute("quanta://inbox/abc")).toBeNull()
    expect(resolveThreadRoute("https://threads/abc")).toBeNull()
  })

  test("RT-10: empty native id ⇒ null", () => {
    expect(resolveThreadRoute("quanta://threads/")).toBeNull()
  })

  test("RT-11: web URL with no thread param ⇒ null", () => {
    expect(resolveThreadRoute("http://localhost:5173/?ws=ws://x&token=y")).toBeNull()
    expect(resolveThreadRoute("http://localhost:5173/")).toBeNull()
  })

  test("RT-12: empty thread param (?thread=) ⇒ null (blank id is not a route)", () => {
    expect(resolveThreadRoute("http://localhost:5173/?thread=")).toBeNull()
    expect(resolveThreadRoute("http://localhost:5173/#thread=")).toBeNull()
  })

  test("RT-13: garbage / non-uri / empty string ⇒ null", () => {
    expect(resolveThreadRoute("not a uri")).toBeNull()
    expect(resolveThreadRoute("")).toBeNull()
  })

  test("RT-14: non-string input ⇒ null (defensive; hosts pass untyped event payloads)", () => {
    expect(resolveThreadRoute(undefined as unknown as string)).toBeNull()
    expect(resolveThreadRoute(null as unknown as string)).toBeNull()
    expect(resolveThreadRoute(123 as unknown as string)).toBeNull()
  })

  test("RT-15: a malformed URL that is neither a quanta URI nor parseable ⇒ null (no throw)", () => {
    // A bare '#thread=x' with no origin is not a valid absolute URL; the resolver
    // must still recover the hash id without throwing on the URL ctor.
    expect(resolveThreadRoute("#thread=bare-hash")).toEqual({ threadId: "bare-hash" })
    // ...but a truly unparseable blob is null, not an exception.
    expect(resolveThreadRoute("http://[::bad::url")).toBeNull()
  })
})

describe("B2 ThreadRouteIntent — typed shape", () => {
  test("RT-16: the intent is exactly { threadId } (no leaked internals)", () => {
    const intent: ThreadRouteIntent | null = resolveThreadRoute("quanta://threads/t-shape")
    expect(intent).not.toBeNull()
    if (intent !== null) {
      expect(Object.keys(intent)).toEqual(["threadId"])
    }
  })
})
