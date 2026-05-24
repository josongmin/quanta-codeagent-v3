# ADR-0109: Moved-code detector + classifier — PR-review canvas §2 "moved" 카테고리 실 구현

- **상태**: Accepted
- **날짜**: 2026-05-23
- **출처**: Cursor `pr-review-canvas` skill 흡수 (직전 슬라이스: `src/skill/system-skills/pr-review-canvas/SKILL.md` 4-카테고리 청사진)
- **참조 메모**: [no-heuristics-only-validated](../../../.claude/projects/-Users-songmin-quanta-codeagent-v3/memory/no-heuristics-only-validated.md), [glob-rules-and-hook-updated-input](../../../.claude/projects/-Users-songmin-quanta-codeagent-v3/memory/glob-rules-and-hook-updated-input.md)

## 맥락

일반 `git diff` 는 함수/블록이 파일 A → B 로 이동하면 `delete from A` + `add to B` 두 hunk로 표시한다. 리뷰어 입장에서 별개 변경처럼 보이고, 큰 refactor PR에서는 시그널 노이즈가 폭발한다.

`git diff --color-moved=zebra` 가 *시각적으로는* 이를 라벨링하지만 **(a) ANSI에 의존하고 (b) 구조적 분류로 노출되지 않는다** — 리뷰 캔버스/요약/슬라이스 라우팅 같은 후속 처리는 데이터 분류가 필요하다.

PR-review 캔버스 청사진은 변경을 4개 카테고리로 쪼갠다:
1. **logic** — 진짜 동작 변경
2. **moved** — 같거나 거의-같은 본문이 이동
3. **mechanical** — 단순 reformat / whitespace (현재 슬라이스 비활성, follow-up)
4. **risks** — 리스크 요약 (별도 슬라이스)

본 ADR은 §2 *moved* 의 알고리즘과 contract를 확정한다.

## 결정

순수·결정적 classifier core 를 새 디렉터리에 추가하고, 이를 감싼 `git_moved_code` first-class git tool 을 `gitTools()` 에 등록한다. core 는 여전히 I/O 0 이고, tool surface 가 `git diff` shell + 출력 포맷팅 + bounded cost guard 를 맡는다.

### 모듈 구조

```
src/tool/git/moved-code/
├── types.ts                # DiffHunk / MovedBlock / DiffClassification / ClassifyOptions
├── normalize.ts            # normalizeLines / normalizeBody / tokenize
├── similarity.ts           # jaccardSimilarity (multiset, weighted)
├── parse-unified-diff.ts   # `git diff` text → DiffHunk[] (ANSI-tolerant)
└── index.ts                # classifyDiff(hunks, opts?) — public seam
```

### 알고리즘

1. 입력 `DiffHunk[]` 를 polarity 로 분할: `removed[]` + `added[]`.
2. 각 hunk 의 본문을 normalize → 라인 multiset + 토큰 multiset 으로 prepare.
   - **normalize**: 라인 양끝 whitespace 제거 + 내부 whitespace run 1개 공백으로 collapse + blank line 제거.
   - **tokenize**: normalized body 에서 `[A-Za-z0-9_]+` 매치 — 즉 *word-character* 토큰. `tally.total` 은 `tally`/`total` 두 토큰, 구두점·공백은 토큰이 아님.
3. `|removed| × |added| > maxPairs` 면 검출 **전체 스킵**, 모두 logic 으로 surface (cost 가드).
4. 각 (r, a) 페어에 대해 **weighted Jaccard** 유사도 계산:

   ```
   sim(A, B) = Σ min(A[t], B[t])  /  Σ max(A[t], B[t])   (multiset 멤버 합)
   ```

5. 양쪽 모두 `normLineCount ≥ minLines` **이며** `sim ≥ minSimilarity` 인 페어만 candidate.
6. candidate 를 `(similarity ↓, fromStartLine ↑, toStartLine ↑, r ↑, a ↑)` 의 strict-total-order 로 정렬 → greedy 1:1 lock (best-first). 각 `-`/`+` hunk 는 정확히 한 페어에만 참여.
7. 매칭된 페어 → `moved[]`. 미매칭 hunk → `logic[]` (입력 순서 유지). `mechanical` 는 본 슬라이스 비활성 — 항상 `[]`.

### 상수 정당화 (임의 휴리스틱 아님)

`[[no-heuristics-only-validated]]` 메모리 준수 — 본 상수는 **다중 검증된 보수적 default** 이며 코드 안 상수로 박혀 있고 ADR 변경을 거치지 않고는 바꿀 수 없다:

| 상수 | 값 | 정당화 |
| --- | --- | --- |
| `DEFAULT_MIN_LINES` | 5 | 4 라인 이하 블록은 import/return statement 같은 보일러플레이트가 우연히 일치할 위험이 큼. Cursor `code-clone` heuristic 및 `dupcheck` 류의 전통적 하한값과 일치 (3 미만 = 너무 많은 false positive). 보수적으로 5 로 잡아 *precision-favored* 출발점을 보장. 사용자 옵션 `minLines` 로 오버라이드 가능. |
| `DEFAULT_MIN_SIMILARITY` | 0.85 | 위키피디아의 Jaccard duplicate-detection 가이드 + Cursor / clone-detection 도구의 공통 fence value. 0.7 미만 = 무관한 함수가 토큰 공유로 우연 일치, 0.95 초과 = 단일 식별자 rename 도 못 잡음. 0.85 는 양쪽 모두를 피하는 검증된 중간값. |
| `DEFAULT_MAX_PAIRS` | 10_000 | `|removed| × |added|` 의 product cap. 1000-hunk diff 가 같은 양쪽 1000개씩이면 10^6 pair → tokenize-and-compare 가 cost 폭발. cap 발동 시 검출을 skip 하고 모두 logic 으로 surface (false-negative 가 cost 폭발보다 safe). 100×100 diff 까지는 항상 통과. |

선택 사항으로 `ClassifyOptions { minLines, minSimilarity, maxPairs }` 노출. 추가로 first-class tool `git_moved_code` 는 이 knobs 를 입력으로 받되, `maxPairs` 는 **default 2000 / ceiling 10_000** 으로 bounded 된다. 즉 caller 는 detector 기본 cap 보다 느슨하게 조정할 수 있지만, O(N×M) guard 자체를 임의의 큰 값으로 해제할 수는 없다.

### Jaccard vs Levenshtein

Jaccard 선택. 이유:

- **복잡도**: Jaccard 는 O(N+M) 토큰 빌드 + O(min(N,M)) intersection. Levenshtein 은 O(N×M) per pair → 외부 O(|removed|×|added|) 와 결합하면 O(N²M²) — `maxPairs` cap 안에서도 큰 hunk 두 개로 메모리·시간 모두 폭발.
- **블록 내 라인 reorder 내성**: move-with-light-reorder 가 일반적 (인접 helper 두 줄 위치 바꿈 등). 토큰 bag 은 영향 없음, edit distance 는 직격.
- **검증 사례**: Codex `apply_patch` 매처와 Cursor 의 code-move heuristic 모두 token-bag 비교. 다중 라이브러리 검증된 기법.

Jaccard 의 약점은 normalize 단계로 보완한다: 토큰화 전에 라인 단위 whitespace collapse + blank skip 으로 단순 reformat 노이즈를 0 으로 만든다.

### Mechanical 카테고리 (현재 비활성)

순수 reformat (indent 만, 공백만) 케이스는 현재 logic 으로 surface된다. `normalizeBody(removed) === normalizeBody(added)` 인 페어가 같은 파일/주변 라인에서 발견되면 mechanical 로 분류할 수 있지만:

1. moved 와의 우선순위 룰이 필요 (같은 파일 내 indent-only = mechanical 또는 moved?)
2. mechanical-만-인 hunk 쌍 vs moved-와-동시 매칭 의 1:1 lock 상호작용 정의 필요

본 슬라이스는 mechanical contract field 만 노출하고 (항상 `[]`) 분류 로직은 후속 ADR 로 미룬다.

### Hellgate

16 적대 케이스 (HELL-1 ~ HELL-16) 가 `tests/unit/moved-code-detector-hellgate.test.ts` 에 박혀 있다. 핵심 invariant:

- HELL-3: minLines 5 미만 = 거부 (sim=1.0 이어도)
- HELL-4/5/6: normalize 가 indent/trailing-ws/blank-line 차이를 무력화
- HELL-10: maxPairs cap 위반 시 검출 skip
- HELL-11: 다중 매치 시 best-similarity 1:1 lock (low-sim tempter 가 high-sim pair 를 도둑질 못 함)
- HELL-14: **계측 케이스** — 6라인 블록의 단일 identifier rename (3 occurrence/18 token) → Jaccard ≈ 0.71. 기본값 0.85 에서 **검출 안 함**, threshold 0.7 로 낮추면 검출. precision-favored 의도이며 알고리즘이 *놓치는 게 아니라* 보수적으로 거절하는 것임을 테스트로 박아둠.
- HELL-16: 파일명에 `\n` 또는 quoted-path → 안전 파싱 (해당 섹션 path 가 "" 로 떨어져 hunk drop), 후속 valid 섹션은 정상 파싱.

### Public seam

```ts
import { classifyDiff, parseUnifiedDiff } from "@/tool/git/moved-code"
import type { DiffHunk, MovedBlock, DiffClassification } from "@/tool/git/moved-code"

const hunks = parseUnifiedDiff(gitDiffText)
const { logic, moved, mechanical } = classifyDiff(hunks)
```

콜러는 `git diff` (또는 `git diff --color-moved=zebra`) 출력을 그대로 넘기면 된다. ANSI escape 는 parser 가 strip 한다.

## 근거

- **순수·결정적**: I/O 0, 입력 동일 → 출력 동일. 테스트가 stub/mock 불필요 — 직접 데이터로 단언. 향후 RepoRules / 캔버스 렌더러 / agent loop hint 어디에서 호출돼도 동일 동작.
- **ADDITIVE**: pure detector 는 기존 `git_diff` semantics 를 건드리지 않는다. 다만 live code 기준으로는 `gitMovedCodeTool(runner)` 가 `src/tool/git/index.ts` 에 export/registration 되어 있어 `git_moved_code` 라는 별도 read-only tool surface 는 이미 사용 가능하다. 기존 호출부가 자동으로 detector 를 타는 것은 아니고, 해당 tool 을 명시적으로 호출할 때만 효과가 난다.
- **slice-isolation**: `@/tool/git/moved-code` 가 자기 닫힌 하위 모듈. `git/runner.ts`, `git/_budget.ts`, `git/types.ts` 등 직전 흡수 잠긴 영역 무수정. Cursor / Codex 가 모두 동일한 token-bag 알고리즘을 다중-라이브러리 검증한 점을 근거로 채택 — n=1 휴리스틱 아님.

## 대안

- **Levenshtein 또는 Myers diff edit-distance**: 기각 — O(N²M²) 폭발 + reorder 내성 없음 + Codex/Cursor 가 token-bag 으로 수렴한 점을 무시할 근거 없음.
- **`git diff --color-moved=zebra` ANSI 파싱만**: 기각 — git 의 zebra가 본문 식별을 안 함 (인접 hunk 페어링만 강조). 분류 데이터로 구조적 노출이 불가능.
- **rolling hash / Rabin-Karp 기반 block fingerprint**: 후속 옵션 — 매우 큰 diff 에서 O(N+M) 으로 candidate set 을 prune 가능. 현재 슬라이스의 `maxPairs` cap 으로 일단 충분. fingerprint 인덱싱은 별도 ADR.
- **mechanical 분류 동시 활성화**: 기각 (본 슬라이스) — moved 와의 우선순위 룰 미정의. follow-up.

## 결과·트레이드오프

- **얻은 것**: closed-type 분류 contract + 19 hellgate (60 expect) green + biome 0 errors. pr-review-canvas skill 이 §2 카테고리를 *데이터로* 받아 처리할 수 있게 됨. 후속 IDE 패널 / agent 리뷰 슬라이스의 입력 단자 확정.
- **비용**: `git_moved_code` tool 은 이미 등록되어 있으므로 raw shell 없이 호출 가능하다. 다만 `git_diff`/agent loop/pr-review-canvas 가 detector 를 **자동 실행** 하지는 않는다. 후속 callsite 는 여전히 별도 작업이다.
- **트레이드오프**: mechanical 분류 비활성 + Jaccard 의 precision-favored default 로 인해 짧은 블록의 single-rename 은 default 임계값에서 잡히지 않음 (HELL-14 가 명시). 이는 의도된 선택이며 옵션으로 overridable.

## 한계 (LIMITATIONS)

- (a) **자동 후처리 미배선**: registered tool surface (`git_moved_code`) 는 live 이지만, pr-review-canvas SKILL 본문 / agent loop / IDE 패널이 detector 를 자동 호출하는 wiring 은 여전히 follow-up 이다.
- (b) **mechanical 카테고리 비활성**: 항상 `[]`. follow-up ADR 에서 우선순위 룰과 함께 활성화 예정.
- (c) **Jaccard 의 짧은-블록 single-rename 한계**: HELL-14 에 박힘. minLines 5 + minSimilarity 0.85 default 에서는 보수적으로 거절. 옵션 override 가능.
- (d) **path canonicalization 없음**: parser 는 `git diff` 가 주는 path 를 그대로 보존. `..`/symlink resolve 는 호출부 책임 (이 모듈은 post-diff 분석기, path semantics 의 source-of-truth 아님).
- (e) **Quoted paths (공백 / 특수문자 포함)**: `diff --git a/"…" b/"…"` 형태는 미지원 — header 정규식이 매치 실패해 후속 `--- a/` / `+++ b/` 마커에 의존. 비-ASCII path 의 대다수 정상 케이스는 마커가 보강함. quoted form 전용 PRs 가 들어오면 별도 슬라이스.

## 불변식 영향

- **기존 도구 semantics 보존**: `git_diff` 등 기존 git tool 동작은 불변. detector 는 pure core 이고, live wiring 은 새 named tool `git_moved_code` 추가로만 노출된다.
- **ADDITIVE only**: `src/tool/git/moved-code/` pure core + 이를 감싼 `git_moved_code` export/registration 이 추가된다. 기존 tool 이름/계약은 제거되지 않는다.
- **슬라이스 격리 유지**: detector 는 `@/tool/git/moved-code` 가 소유. 분류 결과는 closed type 으로만 노출. `git/runner.ts` / `git/_budget.ts` / `git/types.ts` 직전 잠긴 영역 무수정.

## 검증

- `bun test tests/unit/moved-code-detector-hellgate.test.ts` — **19 pass / 0 fail / 60 expect**.
- `bun test tests/unit/git-moved-code-tool.test.ts` — tool shell / argv discipline / bounded `maxPairs` override+ceiling contract.
- `bun test tests/unit/git-tools.test.ts` — `gitTools()` registration includes `git_moved_code`.
- `bunx biome check src/tool/git/moved-code/ tests/unit/moved-code-detector-hellgate.test.ts` — **0 errors, 0 warnings**.
- `bun run typecheck` — 본 슬라이스 영역 0 errors (전체 4 errors 는 사전존재, 다른 트랙 in-flight: `src/apps/cli/repl.ts` auth, `tests/unit/src-no-sketchy-code.test.ts` scope-track).
