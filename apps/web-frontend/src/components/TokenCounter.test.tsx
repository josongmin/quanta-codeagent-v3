import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { CostSurfaceViewWire } from "../types/protocol.session.generated"
import { initialTranscript } from "../ws/session-hooks"
import { TokenCounter } from "./TokenCounter"

type OnView = Extract<CostSurfaceViewWire, { status: "on" }>
const view = (over: Partial<OnView> = {}): OnView => ({
  status: "on",
  calls: 2,
  totalUsd: 1.25,
  estimatedUsd: 0,
  unpricedCalls: 0,
  promptTokens: 1_000,
  outputTokens: 100,
  cacheReadTokens: 250,
  cacheWriteTokens: 50,
  rootUsd: 1,
  subagentUsd: 0.25,
  continuityLost: false,
  ...over,
})
const render = (costView: CostSurfaceViewWire | null) =>
  renderToStaticMarkup(<TokenCounter usage={initialTranscript.tokenUsage} costView={costView} />)

describe("TokenCounter accounting state — actual rendered header", () => {
  it("explicit off renders off and never resurrects the legacy dollar total", () => {
    const markup = renderToStaticMarkup(
      <TokenCounter
        usage={{
          turns: 1,
          promptTokens: 9,
          completionTokens: 1,
          totalTokens: 10,
          costMicroUsd: 9_000_000,
        }}
        costView={{ status: "off" }}
      />,
    )
    expect(markup).toContain(">off</span>")
    expect(markup).not.toContain("$")
    expect(markup).not.toContain(">tok</span>")
  })

  it("unknown-only usage never presents $0 as its price, including the tooltip", () => {
    const markup = render(view({ totalUsd: 0, rootUsd: 0, subagentUsd: 0, unpricedCalls: 2 }))
    expect(markup).toContain("cost incomplete")
    expect(markup).toContain("unpriced calls: 2")
    expect(markup).not.toContain("$0")
  })

  it("mixed priced and unpriced calls render dollars as an incomplete floor", () => {
    const markup = render(view({ unpricedCalls: 1 }))
    expect(markup).toContain(">$1.25</span>")
    expect(markup).toContain("+1 unpriced")
    expect(markup).toContain("priced subtotal: $1.25")
  })

  it("labels estimated dollars separately from the total", () => {
    const markup = render(view({ estimatedUsd: 0.5 }))
    expect(markup).toContain(">~est</span>")
    expect(markup).toContain("estimated: $0.500")
    expect(markup).toContain(">$1.25</span>")
  })

  it("shows continuity loss after a new call", () => {
    const markup = render(view({ continuityLost: true }))
    expect(markup).toContain(">partial history</span>")
    expect(markup).toContain("prior totals lost")
  })

  it("shows continuity loss immediately after corrupt restore, before the next call", () => {
    const markup = render(
      view({
        calls: 0,
        promptTokens: 0,
        outputTokens: 0,
        totalUsd: 0,
        rootUsd: 0,
        subagentUsd: 0,
        continuityLost: true,
      }),
    )
    expect(markup).toContain(">partial history</span>")
    expect(markup).not.toContain("$0")
  })

  it("renders root/subagent split and cache information from the authority", () => {
    const markup = render(view())
    expect(markup).toContain("root $1.00 · subagents $0.250")
    expect(markup).toContain("cache read: 250")
    expect(markup).toContain("cache write: 50")
    expect(markup).toContain(">1.1k</span>")
  })

  it("escapes hostile model labels as text, never attributes or markup", () => {
    const markup = render(view({ modelSlug: '" onmouseover="alert(1)"><script>bad()</script>' }))
    expect(markup).toContain("&quot; onmouseover=&quot;")
    expect(markup).toContain("&lt;script&gt;")
    expect(markup).not.toContain("<script>")
    expect(markup).not.toContain('" onmouseover="')
  })

  it("hides a genuinely empty healthy book and an empty legacy book", () => {
    expect(render(view({ calls: 0 }))).toBe("")
    expect(render(null)).toBe("")
  })
})
