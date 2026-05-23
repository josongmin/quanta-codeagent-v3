# ADR-0112: `git_review_diff` — isolated diff reviewer sub-agent (Claude Desktop `reviewDiff` 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**: ADR-0011(subagent slice + `SubagentRunner` port), ADR-0036(plan-mode mutating table + `git_diff`/`git_status` 등 read-only 분류), ADR-0078(`classifySource` 등 ToolContext duck-typed 시밤), ADR-0093(`PlanMutator` mirror in ToolContext), ADR-0103(PR thread blame), ADR-0104(gh PR typed tools)
- **참조**: `src/tool/git/review-diff.ts`(구현), `src/tool/types.ts`(ReviewerRunner mirror + ToolContext seam), `src/tool/git/index.ts`(barrel + factory), `src/agent/mode.ts`(MUTATING_TOOL_TABLE — `git_review_diff: null`), `tests/unit/tool/git-review-diff.test.ts`(18 cases), `tests/integration/git-review-diff-e2e.test.ts`(real git + scripted reviewer 4 cases)

## 맥락

Claude Desktop 1.7196.3의 `reviewDiff` IPC 패턴 — PR diff를 받아 line-by-line 리뷰 comment를 **격리된 sub-agent**가 생성하고, 메인 세션 컨텍스트는 그대로. 이 패턴이 가져오는 두 가지 이득:

1. **컨텍스트 오염 0**: 리뷰는 보통 수십 turn 분량의 diff 탐색 + 파일 read + grep을 동반한다. 메인 루프에서 직접 수행하면 한 PR 리뷰만으로 컨텍스트 윈도우의 30~50%를 소모. 격리 sub-agent는 자기 내부 turn만 소비하고 부모에게는 **단일 tool_result** 만 돌려준다.
2. **read-only 강제**: 리뷰 posture는 본질적으로 findings-first(파일 수정 금지). sub-agent를 `taskKind:"review"` + read-only `toolFilter`(`read`/`grep`/`glob`)로 강제 핀하면 reviewer LLM의 정렬 우발사고로도 mutation이 일어날 수 없다.

v3 현재 상태:

- `src/subagent/agent-tool.ts`에 일반 `agent` tool(임의 task posture)은 있다. 하지만 "diff-only reviewer" 전용 도구는 없음 — LLM이 매 호출마다 자유 형식 prompt를 짜야 하고, REVIEW 모드 notice / read-only 필터 / diff 추출까지 모두 매번 재구성.
- `src/tool/git/diff.ts`는 unified-diff 텍스트만 반환 — 리뷰는 LLM이 메인 컨텍스트에서 처리.

본 ADR은 두 슬라이스를 잇는 **single-purpose tool**을 도입한다: `git_review_diff`가 diff 추출 + REVIEW seed 구성 + 격리 sub-agent 호출을 한 호출로 봉합한다.

## 결정

### 도구 contract — `git_review_diff`

`src/tool/git/review-diff.ts`:

```ts
input  = { base?: string, head?: string, paths?: string[], focus?: string }
output = ToolResult with .structured: { summary: string, findings: ReviewFinding[] }
```

- 기본 범위: `git diff origin/main...HEAD` (3-dot — base에서 분기한 이후의 변경만).
- `base`/`head` 모두 leading-`-` reject(no `git diff --output=...` smuggling) — `git_diff` tool의 보안 posture 그대로.
- `paths` ⇒ `git diff <range> -- <paths…>`.
- `focus` ⇒ reviewer seed에 verbatim 주입(예: `look for null dereferences`).

### 격리 메커니즘 — `ToolContext.reviewerAgent` 시밤

`@/tool` ↔ `@/subagent` slice fence(RFC §3.1)를 보존하기 위해 `SubagentRunner`의 **duck-typed mirror**(`ReviewerRunner`)를 `src/tool/types.ts`에 선언:

```ts
export type ReviewerRunner = (req: ReviewerRequest) => Promise<ReviewerResult>
export interface ReviewerRequest {
  prompt: string
  depth: number
  taskKind?: "read" | "edit" | "review"
  toolFilter?: readonly string[]
  signal?: AbortSignal
}
```

dispatch 시밤(composition root in `@/agent`)이 concrete `SubagentRunner`를 이 narrow port에 어댑팅. tool은 `ctx.reviewerAgent`만 호출. 시밤 미부착 ⇒ deterministic `ok:false`("reviewer port not attached"); throw 없음, byte-identical for opt-out sessions.

### Posture 핀

- `isReadOnly: () => true`
- `isConcurrencySafe: () => true` (sub-agent 자체가 격리; 동일 cwd 동시 호출도 read-only diff만 보므로 안전)
- `hitlTier: () => "none"` (mutation 없음)
- mode-mutating-table: `git_review_diff: null` ⇒ plan/review/audit 모드 모두 admissible

### Reviewer seed prompt 구조

```
REVIEW_NOTICE(slice-local copy of REVIEW_NOTICE from @/agent/prompt)
[focus 섹션 — optional]
## Diff under review
```diff
<diff text, 50KB cap with truncation marker>
```
## Output shape
Return JSON: {summary, findings: [{file, line?, severity, what, why?, impact?}]}
```

- `50_000` byte cap(매칭 `git_diff` MAX_OUTPUT) 초과 시 truncation marker + 보이는 부분만 review.
- Reviewer가 JSON으로 응답 ⇒ opportunistic 파싱(fenced block 추출 fallback) ⇒ `structured: ReviewReport`.
- Reviewer가 free text 응답 ⇒ verbatim surface + `structured.findings: []`.

### Tool filter — `["read", "grep", "glob"]`

`src/subagent/agent-tool.ts`의 `deriveToolFilter("review")`는 lsp/diagnostics를 포함하지만, 본 도구는 **diff만 보고 결정하는** 가벼운 리뷰가 목표이므로 셋만으로 좁힌다. 더 무거운 리뷰가 필요하면 호출자가 일반 `agent` 도구를 쓸 수 있다(겹치는 영역이 아니라 보완 관계).

### Empty diff fast path

`git diff` stdout이 비면 reviewer 호출을 건너뛰고 `(no diff to review)` + `findings: []`를 즉시 반환. 빈 PR에서 LLM token이 새지 않게.

## 한계

- **Reviewer LLM 비용**: 격리 sub-agent도 결국 LLM 호출이다. 큰 diff는 sub-agent 내부에서 추가 read/grep으로 multi-turn이 될 수 있다. budget(`maxTurns`/`maxTokens`)을 sub-agent request에 싣는 후속이 가능하지만 현 ADR 범위는 vanilla call.
- **JSON 파싱은 opportunistic**: schema 강제 안 함. reviewer가 거부하거나 free text로 응답하면 `findings: []`로 fallback. 호출자가 `summary` 텍스트만 봐도 의미 있다.
- **3-dot range만**: `base..head`(2-dot, symmetric difference 아님) 모드는 미지원. `paths`로 scope만 좁히는 단일 사용 패턴 우선.
- **`ctx.reviewerAgent` 미부착 운영 가능**: 호스트가 시밤을 와이어링 안 했다면 도구가 `ok:false`만 반환. registry에서 도구를 제외하는 fail-closed는 mode-table 정책상 부담이 크므로 채택하지 않음(다른 게이트가 이미 LLM에 `ok:false`로 응답하는 패턴 일관).

## 흐름

```
agent loop ── tool_use git_review_diff{base,head,paths,focus}
                    │
                    ▼
              gitReviewDiffTool.execute
                    │
                    ├── safeRun(GitRunner, ["diff", "<base>...<head>", "--", paths...])
                    │       └── stdout empty? → ok:true + (no diff to review), return
                    │
                    ├── buildReviewerPrompt(REVIEW_NOTICE + focus + diff + JSON-shape ask)
                    │
                    ▼
              ctx.reviewerAgent({prompt, depth+1, taskKind:"review",
                                  toolFilter:["read","grep","glob"], signal})
                    │
                    │  ── (isolated sub-agent loop runs N turns,
                    │       calling only read/grep/glob with its OWN history)
                    │
                    ▼
              tryParseReport(finalText) → ReviewReport | null
                    │
                    ├── parsed   → renderReport + structured: ReviewReport
                    └── unparsed → finalText verbatim + structured.findings: []

   main loop history grows by exactly ONE tool_result.
```

## 검증

- `tests/unit/tool/git-review-diff.test.ts` — 18 cases, FakeRunner + FakeReviewer:
  schema / metadata(hitlTier `"none"`) / argv 구성(default `origin/main...HEAD`, 명시 base+head, paths after `--`, leading-`-` reject) / signal propagation / empty-diff fast path(reviewer 미호출) / reviewer 호출 시 depth+1 + taskKind + toolFilter + diff/focus 주입 / JSON parsing happy path / non-JSON fallback / reviewer failure → ok:false / spawn-error → ok:false / 시밤 미부착 → 결정적 ok:false.
- `tests/integration/git-review-diff-e2e.test.ts` — real `git` in tmpdir + scripted reviewer, 4 cases: two-commit repo end-to-end(parsed report 받음 + 메인 history 1-result만 자람) / paths scope(스코프 파일 변경 없으면 reviewer 미호출) / empty diff / reviewer 미부착.
- `tests/unit/mode-mutating-table.test.ts` — 등록된 모든 tool name이 mutating table에 entry 있어야 한다는 cross-check: `git_review_diff: null` 추가로 통과.

## 호환성

- 새 tool — 기존 호출자에 변경 없음. tool registry 추가만.
- `ToolContext.reviewerAgent`는 optional + duck-typed; 미부착 호스트 byte-identical.
- mode-mutating-table에 `null` entry 추가 — `git_diff`/`git_status` 등과 동일 분류.

## 향후 작업

1. agent slice composition root에서 `SubagentRunner` → `ReviewerRunner` 어댑터 와이어링(현 ADR 범위 밖, 단일 import 라인).
2. reviewer budget(`maxTurns`/`maxTokens`)을 `git_review_diff` input에 노출 — 큰 diff에서 토큰 폭주 가드.
3. `ReviewReport.findings`를 PR comment surface(ADR-0103 PR thread blame과 결합)로 직접 발행하는 alternate output mode.
