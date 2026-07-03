/**
 * B2 (jul-04) — web-frontend thread deeplink route resolver test.
 *
 * The browser cannot receive a custom `quanta://` scheme URI, so the web
 * fallback is a plain `?thread=<id>` / `#thread=<id>` param on the SPA URL (a
 * shared/handoff link). This mirrors the `@/scheduler/deeplink-route` core in
 * the main package (the web-frontend is a separate build root and cannot import
 * `src/`), so the SAME contract is pinned on both sides.
 *
 * `resolveThreadRouteFromLocation` reads a location-like object (so it is unit-
 * testable without a real `window`) and returns `{ threadId } | null`.
 */

import { describe, expect, it } from "vitest"
import {
  resolveThreadRouteFromLocation,
  resolveThreadRouteFromUri,
  THREAD_WEB_PARAM,
  type ThreadRouteIntent,
} from "./thread-deeplink"

const loc = (over: Partial<{ search: string; hash: string; href: string }>): {
  readonly search: string
  readonly hash: string
  readonly href: string
} => ({ search: "", hash: "", href: "http://localhost:5173/", ...over })

describe("B2 web — resolveThreadRouteFromLocation (query/hash)", () => {
  it("WD-01: ?thread=<id> query ⇒ { threadId }", () => {
    expect(resolveThreadRouteFromLocation(loc({ search: "?thread=t-1" }))).toEqual({
      threadId: "t-1",
    })
  })

  it("WD-02: #thread=<id> hash ⇒ { threadId }", () => {
    expect(resolveThreadRouteFromLocation(loc({ hash: "#thread=t-2" }))).toEqual({
      threadId: "t-2",
    })
  })

  it("WD-03: query wins over hash when both present", () => {
    expect(
      resolveThreadRouteFromLocation(loc({ search: "?thread=q", hash: "#thread=h" })),
    ).toEqual({ threadId: "q" })
  })

  it("WD-04: percent-encoded id decodes", () => {
    expect(resolveThreadRouteFromLocation(loc({ search: "?thread=a%2Fb%20c" }))).toEqual({
      threadId: "a/b c",
    })
  })

  it("WD-05: THREAD_WEB_PARAM is the shared key", () => {
    expect(THREAD_WEB_PARAM).toBe("thread")
    expect(
      resolveThreadRouteFromLocation(loc({ search: `?${THREAD_WEB_PARAM}=k` })),
    ).toEqual({ threadId: "k" })
  })
})

describe("B2 web — rejects non-thread / empty (no throw)", () => {
  it("WD-06: no thread param ⇒ null", () => {
    expect(resolveThreadRouteFromLocation(loc({ search: "?ws=x&token=y" }))).toBeNull()
    expect(resolveThreadRouteFromLocation(loc({}))).toBeNull()
  })

  it("WD-07: empty thread param ⇒ null", () => {
    expect(resolveThreadRouteFromLocation(loc({ search: "?thread=" }))).toBeNull()
    expect(resolveThreadRouteFromLocation(loc({ hash: "#thread=" }))).toBeNull()
  })

  it("WD-08: malformed search/hash ⇒ null (defensive, no throw)", () => {
    expect(resolveThreadRouteFromLocation(loc({ search: "???", hash: "###" }))).toBeNull()
  })
})

describe("B2 web — resolveThreadRouteFromUri (native quanta:// + fallback)", () => {
  it("WD-09: quanta://threads/{id} ⇒ { threadId } (Tauri OS deep-link payload)", () => {
    expect(resolveThreadRouteFromUri("quanta://threads/native")).toEqual({ threadId: "native" })
  })

  it("WD-10: quanta://threads/{encoded} round-trips url-unsafe ids", () => {
    // buildThreadDeeplink("a/b c") === "quanta://threads/a%2Fb%20c"
    expect(resolveThreadRouteFromUri("quanta://threads/a%2Fb%20c")).toEqual({ threadId: "a/b c" })
  })

  it("WD-11: web fallback URL also accepted by the uri resolver", () => {
    expect(resolveThreadRouteFromUri("http://localhost:5173/?thread=u-1")).toEqual({
      threadId: "u-1",
    })
    expect(resolveThreadRouteFromUri("http://localhost:5173/#thread=u-2")).toEqual({
      threadId: "u-2",
    })
  })

  it("WD-12: foreign scheme / garbage / non-string ⇒ null", () => {
    expect(resolveThreadRouteFromUri("quanta://inbox/x")).toBeNull()
    expect(resolveThreadRouteFromUri("https://threads/x")).toBeNull()
    expect(resolveThreadRouteFromUri("not a uri")).toBeNull()
    expect(resolveThreadRouteFromUri("")).toBeNull()
    expect(resolveThreadRouteFromUri(undefined as unknown as string)).toBeNull()
  })

  it("WD-13: intent shape is exactly { threadId }", () => {
    const intent: ThreadRouteIntent | null = resolveThreadRouteFromUri("quanta://threads/s")
    expect(intent).not.toBeNull()
    if (intent !== null) expect(Object.keys(intent)).toEqual(["threadId"])
  })
})
