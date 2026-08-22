import { readFileSync } from "node:fs"
import { renderDashboardPage } from "@/../tools/leaderboard-dashboard/page"
import { terminalBenchProjector } from "@/../tools/leaderboard-dashboard/projectors/terminal-bench"

const DATA = JSON.parse(readFileSync(process.argv[2]!, "utf8"))
const PAGE = renderDashboardPage({ tracePort: 4318 })
const esc = PAGE.match(/function esc\([^)]*\)\s*\{[^\n]*\}/)![0]
const sinks: Record<string, string> = {}
const node = (id: string) => ({
  set innerHTML(v: string) { sinks[id] = v },
  set textContent(v: string) { sinks[id] = v },
  get value() { return "" },
  set oninput(_: unknown) {}, set onchange(_: unknown) {}, set onclick(_: unknown) {},
})
const doc = { getElementById: (id: string) => node(id), querySelectorAll: () => ({ forEach() {} }) }
const src = ["var SUITE_VIEWS = {};", esc, terminalBenchProjector.client.script,
  "renderTbCards(); drawTbMatrix(); return { cards: null, scaffolds: tbScaffolds() };"].join("\n")
const extra = new Function("DATA", "document", src)(DATA, doc) as { scaffolds: string }
const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
process.stdout.write(`=== CARDS ===\n${strip(sinks.cards ?? "")}\n\n`)
process.stdout.write(`=== MATRIX ===\n${strip(sinks.tbtable ?? "")}\n\n`)
process.stdout.write(`=== OFFICIAL ===\n${strip(extra.scaffolds)}\n`)
