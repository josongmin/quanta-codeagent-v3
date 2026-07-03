/**
 * B2 (jul-04) — ThreadDeeplinkBanner render + postMessage-guard tests.
 *
 * The route CORE is unit-tested in `../lib/thread-deeplink.test.ts`. Here we pin
 * the AFFORDANCE contract: given a resolved intent, the banner renders a VISIBLE
 * element naming the thread; given none, it renders nothing (byte-identical to
 * legacy — no stray chrome when there is no deeplink). We also pin the
 * `postMessage` payload guard (the Tauri-forwarded native deep-link seam).
 *
 * Rendered with `renderToStaticMarkup` (node env, no DOM) — the same pattern the
 * other component tests use. The `useState` initializer runs under SSR; the
 * `useEffect` (postMessage listener) does not, so the initial-intent seam
 * drives the render deterministically.
 */

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { isDeeplinkPostMessage, ThreadDeeplinkBanner } from "./ThreadDeeplinkBanner"

describe("B2 ThreadDeeplinkBanner — render affordance", () => {
  it("TB-01: with an intent, renders a visible banner naming the thread", () => {
    const markup = renderToStaticMarkup(
      <ThreadDeeplinkBanner initialIntent={{ threadId: "t-open-me" }} />,
    )
    expect(markup).toContain("Open thread")
    expect(markup).toContain("t-open-me")
    expect(markup).toContain("thread-deeplink-banner")
  })

  it("TB-02: with NO intent (null), renders nothing (no stray chrome)", () => {
    const markup = renderToStaticMarkup(<ThreadDeeplinkBanner initialIntent={null} />)
    expect(markup).toBe("")
  })

  it("TB-03: without onOpen, shows the honest 'not wired yet' note (no fake resume)", () => {
    const markup = renderToStaticMarkup(
      <ThreadDeeplinkBanner initialIntent={{ threadId: "t-x" }} />,
    )
    expect(markup).toContain("not wired yet")
    // No "Open" action button when there is no resume hook.
    expect(markup).not.toContain(">Open<")
  })

  it("TB-04: with onOpen, renders an Open action instead of the note", () => {
    const markup = renderToStaticMarkup(
      <ThreadDeeplinkBanner initialIntent={{ threadId: "t-y" }} onOpen={() => {}} />,
    )
    expect(markup).toContain(">Open<")
    expect(markup).not.toContain("not wired yet")
  })

  it("TB-05: the thread id is escaped as text content (no HTML injection)", () => {
    const markup = renderToStaticMarkup(
      <ThreadDeeplinkBanner initialIntent={{ threadId: "<script>x</script>" }} />,
    )
    // React escapes it; the raw tag must not appear verbatim.
    expect(markup).not.toContain("<script>x</script>")
    expect(markup).toContain("&lt;script&gt;")
  })
})

describe("B2 ThreadDeeplinkBanner — isDeeplinkPostMessage guard", () => {
  it("TB-06: accepts { kind:'quanta:deep-link', url }", () => {
    expect(isDeeplinkPostMessage({ kind: "quanta:deep-link", url: "quanta://threads/x" })).toBe(
      true,
    )
  })

  it("TB-07: rejects wrong kind / missing url / non-object", () => {
    expect(isDeeplinkPostMessage({ kind: "quanta:hotkey-capture", url: "x" })).toBe(false)
    expect(isDeeplinkPostMessage({ kind: "quanta:deep-link" })).toBe(false)
    expect(isDeeplinkPostMessage({ kind: "quanta:deep-link", url: 123 })).toBe(false)
    expect(isDeeplinkPostMessage(null)).toBe(false)
    expect(isDeeplinkPostMessage("quanta://threads/x")).toBe(false)
    expect(isDeeplinkPostMessage(undefined)).toBe(false)
  })
})
