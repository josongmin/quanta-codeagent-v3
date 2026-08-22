#!/usr/bin/env bun
/**
 * Generator for the Jun-20 bug-bash audit doc.
 *
 * SSOT is `docs/bugbash/jun-20-bugbash.findings.json`. This script renders the
 * human-facing markdown from it, and — crucially — RE-DERIVES every citation's
 * line number from the pinned commit (`git show <commit>:<file>` → locate the
 * unique `anchor`). Line numbers are never hand-typed, so they cannot silently
 * go stale; `tests/unit/bugbash-doc-integrity-hellgate.test.ts` independently
 * re-derives and fails if doc and data ever disagree.
 *
 *   bun tools/bugbash/gen-bugbash-doc.ts          # regenerate the doc + refresh derived lines
 */
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..", "..")
const JSON_PATH = join(REPO, "docs/bugbash/jun-20-bugbash.findings.json")
const DOC_PATH = join(REPO, "docs/bugbash/jun-20-bugbash.md")

type Sev = "high" | "med" | "low" | "none"
type Finding = {
  id: number
  severity: Sev
  original_severity: string
  category: string
  cluster: string
  title: string
  file: string
  line_at_audit: string
  anchor: string
  anchor_line: number | null
  why: string
  evidence: string
  verdict: string
  verifier_note: string
}
type Data = {
  audited_commit: string
  audited_commit_short: string
  branch: string
  worktree_dirty: boolean
  worktree_note: string
  workflow_run: string
  counts: { total_surfaced: number; actionable: number; none_retained: number }
  findings: Finding[]
}

const SEV_EMOJI: Record<Sev, string> = { high: "🔴", med: "🟠", low: "🟡", none: "⚪" }
const CLUSTER_NAME: Record<string, string> = {
  "closure-core": "Closure engine core",
  "evidence-plan": "Fault-evidence + verification-plan",
  "repair-drivers": "Repair orchestrator + eval drivers",
  "verify-bundle-wip": "Verification-bundle + verify-signal (WIP)",
  "remote-bench": "Remote bench / EC2 / pool",
  "lsp-prewarm": "LSP / pyright / prewarm",
  "knobs-config": "Knobs + config + presets",
  "leaderboard-cli": "Leaderboard / analyze / CLI",
  "infra-perm": "Observability / permission / sandbox",
}

function blobAtPin(commit: string, file: string): string {
  return execFileSync("git", ["show", `${commit}:${file}`], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
}
/** 1-based line of the UNIQUE anchor in the pinned blob; throws if 0 or >1. */
function deriveLine(commit: string, file: string, anchor: string): number {
  const lines = blobAtPin(commit, file).split("\n")
  const hits: number[] = []
  for (let i = 0; i < lines.length; i++) if (lines[i]?.includes(anchor)) hits.push(i + 1)
  if (hits.length !== 1)
    throw new Error(`anchor "${anchor}" hit ${hits.length} lines in ${file}@${commit.slice(0, 8)}`)
  return hits[0] as number
}

const data = JSON.parse(readFileSync(JSON_PATH, "utf8")) as Data

// 1) Re-derive every line from the pinned commit (SSOT for line numbers).
for (const f of data.findings) f.anchor_line = deriveLine(data.audited_commit, f.file, f.anchor)

// 2) Re-tally counts from the array so they cannot drift.
data.counts.total_surfaced = data.findings.length
data.counts.actionable = data.findings.filter((f) => f.severity !== "none").length
data.counts.none_retained = data.findings.filter((f) => f.severity === "none").length
writeFileSync(JSON_PATH, `${JSON.stringify(data, null, 2)}\n`)

const cite = (f: Finding) => `${f.file}:${f.anchor_line}`
const c = data.counts
const out: string[] = []
const W = (s = "") => out.push(s)

W("# Jun-20 Bug Bash — 6/16~6/17 변경 파일 적대 어딧")
W()
W("> 9-클러스터 병렬 어딧 워크플로우 결과. 6/16~6/17 커밋 52개 + 미커밋 WIP 대상.")
W("> 각 finding은 독립 skeptic verifier로 적대 재검증함.")
W(
  `> **${c.total_surfaced}건 surfaced = ${c.actionable} actionable + ${c.none_retained} none-retained**`,
)
W(
  "> (raw 37 → 적대 검증으로 4건 false-positive 드롭 → 33 surfaced. 그중 2건은 검증이 corrected_severity=none으로 깎은 retained-note라 actionable 아님.)",
)
W("> 살아남은 HIGH 0개 (검증이 high 4건 중 2건을 med로 강등, 2건을 FP/none으로 기각).")
W()
W("## Snapshot (재현 기준)")
W()
W("| 항목 | 값 |")
W("|------|----|")
W(`| Audited commit | \`${data.audited_commit_short}\` (\`${data.audited_commit}\`) |`)
W(`| Branch | \`${data.branch}\` |`)
W(`| Worktree at audit | dirty WIP (그 후 위 커밋으로 커밋됨) |`)
W(`| Worktree now (pin) | clean = \`${!data.worktree_dirty}\` |`)
W(`| Workflow run | \`${data.workflow_run}\` |`)
W()
W(
  `> 모든 \`file:line\` 인용은 **위 핀 커밋 기준**으로 유도됨 (\`git show ${data.audited_commit_short}:<file>\` 에서 unique anchor 탐색).`,
)
W(
  "> 라인은 손으로 적지 않고 SSOT JSON의 anchor에서 파생되며, `tests/unit/bugbash-doc-integrity-hellgate.test.ts` 가 doc↔코드 정합을 강제한다.",
)
W(`> ${data.worktree_note}`)
W()
W("## 요약")
W()
W("| 등급 | 개수 | 의미 |")
W("|------|------|------|")
const medN = data.findings.filter((f) => f.severity === "med").length
const lowN = data.findings.filter((f) => f.severity === "low").length
W(`| 🟠 MED | ${medN} | actionable |`)
W(`| 🟡 LOW | ${lowN} | actionable |`)
W(
  `| ⚪ NONE | ${c.none_retained} | retained-note (검증이 by-design/consequence-반증으로 기각; 참고용) |`,
)
W(`| **actionable 합** | **${c.actionable}** | |`)
W()

// index
W("## 인덱스")
W()
W("| # | 등급 | 분류 | 인용 (pinned) | 제목 |")
W("|---|------|------|------|------|")
for (const f of data.findings) {
  W(
    `| [${f.id}](#${f.id}) | ${SEV_EMOJI[f.severity]} ${f.severity} | ${f.category} | \`${cite(f)}\` | ${f.title.replace(/\|/g, "\\|")} |`,
  )
}
W()

W("## 재발 패턴 (테마)")
W()
W(
  "- **observe-only / built-not-wired**: 게이트·escalation·메트릭이 *기록만* 하고 강제하지 않음 (#1, #9, #14, #28). 메모리의 `wired≠engages theater class`와 직결.",
)
W(
  "- **apps-driver vs runner-driver split-brain**: 두 드라이버가 drift (#6, #5, #27). split-brain 막으려 만든 쌍이 정작 split-brain.",
)
W(
  "- **transient 실패를 영구 상태로 캐시 / fail-open**: 일시 오류를 영구 'dead'로 (#4 LSP, #5 SG describe).",
)
W("- **brittle 문자열 파싱**: regex 채점·extractor가 edge에서 조용히 오판 (#10, #29, #30).")
W()
W("---")
W()
W("## 상세")
W()
for (const f of data.findings) {
  W(`<a id="${f.id}"></a>`)
  W(`### ${f.id}. ${SEV_EMOJI[f.severity]} ${f.title}`)
  W()
  W(
    `- **등급**: ${f.severity.toUpperCase()} (어딧 원래값 \`${f.original_severity}\`) · **분류**: \`${f.category}\` · **검증 verdict**: \`${f.verdict}\``,
  )
  W(
    `- **위치 (pinned ${data.audited_commit_short})**: \`${cite(f)}\` — anchor: \`${f.anchor.replace(/`/g, "\\`")}\``,
  )
  W(`- **클러스터**: ${CLUSTER_NAME[f.cluster] ?? f.cluster}`)
  W(`- **어딧 당시 인용(참고, drift 있을 수 있음)**: \`${f.file}:${f.line_at_audit}\``)
  W()
  W("**영향 (왜 문제인가)**")
  W()
  W(f.why)
  W()
  W("**증거**")
  W()
  W("```")
  W(f.evidence)
  W("```")
  W()
  W("**검증 노트 (skeptic)**")
  W()
  W(f.verifier_note)
  W()
  W("---")
  W()
}

writeFileSync(DOC_PATH, out.join("\n"))
console.log(
  `wrote ${DOC_PATH}\n  ${c.total_surfaced} surfaced = ${c.actionable} actionable + ${c.none_retained} none-retained · pin ${data.audited_commit_short}`,
)
