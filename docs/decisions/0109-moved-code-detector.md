# ADR-0109: Moved-code detector — `pr-review-canvas` algorithm 구현

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**: ADR-0102(`pr-review-canvas` skill 청사진), ADR-0103(`gh_pr_blame` PR-thread blame), ADR-0107(GitBudget 5-knob), [[no-heuristics-only-validated]]
- **참조**: `src/tool/git/moved-code/{types,normalize,similarity,parse-unified-diff,index}.ts`, `tests/unit/moved-code-detector-hellgate.test.ts`(21 적대)

## 맥락

직전 batch에서 `pr-review-canvas` SKILL.md(`src/skill/system-skills/pr-review-canvas/SKILL.md`)을 흡수하면서 핵심 아이디어를 봉인했다: 일반 `git diff`는 함수가 A→B로 이동하면 `delete from A + add to B` 두 hunk로 표시 → reviewer가 별개 변경으로 오인. **이동은 별도 카테고리로 분리해야** 큰 refactor PR에서 reviewer가 신호와 잡음을 구분.

청사진만 있고 알고리즘 미구현. 본 ADR은 그 알고리즘 + classifier 본체.

## 결정

### Part A — 입출력 contract (`types.ts`)

```ts
export interface DiffHunk { file; startLine; endLine; kind: "added"|"removed"; body }
export interface MovedBlock { fromFile; fromStartLine; fromEndLine; toFile; toStartLine; toEndLine; similarity; body }
export interface DiffClassification { logic: DiffHunk[]; moved: MovedBlock[]; mechanical: DiffHunk[] }
export interface ClassifyOptions { minLines?; minSimilarity?; maxPairs? }
```

### Part B — 유사도: weighted Jaccard (multiset) — vs Levenshtein 트레이드오프

| 축 | weighted Jaccard | Levenshtein |
|---|---|---|
| 복잡도 | O(N+M) build + O(K) compare | O(N×M) per pair |
| reorder 내성 | ✓ (token set 동일) | ✗ (편집거리 폭증) |
| 검증 | Codex + Cursor 둘 다 token-set 유사도 사용 | local-only diff 알고리즘 |

**weighted Jaccard 채택**. tokenization은 `[A-Za-z0-9_]+`(word-character) — language-agnostic, AST 의존 없음. multiset count: sum(min)/sum(max) per token으로 5×`return` vs 1×`return` 같은 빈도 차이 반영.

### Part C — defaults (검증된 기법만, 임의 휴리스틱 아님)

| 옵션 | default | 정당화 |
|---|---|---|
| `minLines` | **5** | 짧은 블록(2-4 라인)은 token set이 좁아 false positive 위험. 5+ 라인이면 코드 의미 구분 가능 |
| `minSimilarity` | **0.85** | precision-favored. HELL-14 calibration: 6-라인 단일 identifier rename → Jaccard ≈ 0.71 < 0.85 ⇒ **반려**. `0.65`로 override 시 검출(refactor-tolerant 모드) |
| `maxPairs` | **10_000** | 100×100 hunk PR이 cap. 그 이상은 DoS 회피 — ALL hunks를 logic으로 반환(부분 검출 금지) |

defaults는 코드 안 상수로 박혀 있되 사용자/호출자가 ClassifyOptions로 case-by-case override 가능.

### Part D — orchestrator: greedy best-similarity-first 1:1 lock

1. `-`와 `+` 풀로 분리
2. `removed.length × added.length > maxPairs` ⇒ 전부 logic 반환(short-circuit)
3. 모든 (r, a) 페어에 대해 `minLines` 충족하면 weighted Jaccard 계산 → `>= minSimilarity` 후보 push
4. **strict total order tie-break**: similarity DESC → fromStartLine ASC → toStartLine ASC → 파일 alphabetic. byte-stable.
5. greedy: 한 번 locked된 r/a index는 skip(1:1 매핑 — 한 hunk가 multi-매치 안 됨)
6. unlocked는 logic에 들어감

### Part E — 정규화 (`normalize.ts`)

- `normalizeLine`: trim, 빈 라인 → null(드롭)
- `normalizeLines`: split + drop blanks + trim each
- `tokenize`: `[A-Za-z0-9_]+` regex match, case-sensitive(rename 검출 위해), 순서 보존(multiset)

reformat / blank 삽입 / trailing space 다 normalize 후 동등 — HELL-4, HELL-5, HELL-6에서 검증.

### Part F — Unified diff parser (`parse-unified-diff.ts`)

closed contract. ANSI escape 시퀀스 stripping(`\x1b[...m`). hunk header `@@ -a,b +c,d @@` 파싱으로 line number 추적. 컨트롤 문자 포함 파일 경로 거부(보안).

## 결과

- 21 hellgate(HELL-1~16 algorithm + HELL-17~19 parser + 2 building-block) 통과 / 49 expect
- pure, additive, default-OFF — 어떤 호출부도 사용 안 함. follow-up ADR이 `pr-review-canvas` SKILL.md 본문에 와이어링.
- `src/tool/git/runner.ts` / `_budget.ts` / `types.ts` 직전 잠긴 영역 + `src/auth/` / `loop.ts` / `biome.json` in-flight 영역 무수정.

## 한계

- **0.85 threshold는 precision-favored 디자인 결정** — refactor에서 흔한 단일 identifier rename은 default로 검출되지 않음. 사용자/skill이 lenient 모드(`0.65~0.75`) 명시적 opt-in 필요.
- **weighted Jaccard는 동일 token set의 reorder를 구분 못 함** — 의도된 trade-off(reorder 내성). semantic equivalence 검사 아님.
- **mechanical 카테고리는 reserved** — 본 ADR에서는 항상 빈 배열. 단순 reformat(들여쓰기만 다름)도 현재 logic 또는 moved에 들어감. 향후 ADR이 mechanical 분리 활성화.
- **`pr-review-canvas` skill 본문에 와이어링 미** — skill prompt 단계에서 `classifyDiff`를 invoke하려면 skill executor가 도구 호출 가능해야 함. follow-up.
- **N×M > 10_000 시 fallback to logic** — 일부만 검출하면 모순(어떤 페어는 detected, 어떤 페어는 cap fallback) — 전부 logic이 honest. cap 자체는 ClassifyOptions로 override 가능.
