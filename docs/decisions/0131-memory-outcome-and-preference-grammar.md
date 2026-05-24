# ADR-0131 — Memory hygiene: 4-state outcome enum + preference phrase grammar + 10% phase2 promotion

- **Status**: Proposed (2026-05-24, W1 of [[0130-extracted-source-absorption-roadmap]])
- **Related**: [[no-heuristics-only-validated]] (inflation 방지 강경 지침), [[extracted-source-novel-findings-2026-05-24]] R4+R6 (Codex memory schema)
- **References**: `/.extracted_source/userdata/codex/memories/{MEMORY.md, raw_memories.md, memory_summary.md, rollout_summaries/, extensions/chronicle/}` (live Codex memory corpus, 30 sessions across May 4–24)

## Problem

우리 메모리 시스템(`~/.claude/projects/.../memory/MEMORY.md` + 개별 .md)은 **outcome state 명시 안 함** + **사용자 phrase는 자유 형식**으로 저장. 이 자유도 때문에:

1. **Inflation 발생**: "X feature 80% done" 같은 percentage가 들어가서 후속 세션이 추측. [[no-heuristics-only-validated]] 위반 잠재.
2. **Preference signal 휘발**: 사용자가 "코드 레벨로만"이라고 명시한 정확한 quote가 paraphrase되어 의미 dilute. 후속 agent가 phrase 인식 못 함.
3. **메모리 promotion 기준 없음**: 모든 entry가 동등 weight. 어떤 entry가 reusable knowledge로 격상되는지 불명확.

Codex 메모리 corpus (R4+R6에서 분석, 10+ 실제 rollout)는 이 3 문제를 다음 패턴으로 푼다:

1. **4-state outcome enum**: `success | partial | uncertain | fail` (분포: partial 75% / success 15% / uncertain 10% / fail 1% — **partial이 dominant**, inflation 안 됨)
2. **Preference signal grammar**: `"when the user said '<quote>'"` + `"when the user asked X"` + `"when X corrected the method once, this repeated ask is strong evidence..."` — 정확한 quote 보존 + correction repetition을 confidence proxy로
3. **stage1→phase2 promotion**: `selected_for_phase2 = 1` flag, sample에서 **10% 엄격 promotion**. raw_memories.md (unmerged) → MEMORY.md (merged scoped) 머지

## Decision

`~/.claude/projects/.../memory/` schema에 다음 3 seam 추가, default-OFF:

### 1. Outcome enum frontmatter field (memory file당 1개)

```markdown
---
name: my-memory-slug
description: ...
metadata:
  type: project | feedback | reference | user
  outcome: success | partial | uncertain | fail   # NEW, optional
  outcome_evidence: file:line or URL              # NEW, required if outcome present
---
```

- `outcome: partial` (default if absent) — inflation 방지 safe default
- `success` only when narrow lane closed + evidence anchor (file:line OR commit SHA)
- `uncertain` when claim made but not verified (corresponds to [[no-heuristics-only-validated]] "측정 먼저")
- `fail` when proof contradicts (rare, ~1% of Codex sample)

### 2. Preference phrase grammar (body convention, not schema)

feedback type memory body에 다음 형식 권장 (강제 아님, lint 경고):

```markdown
**When the user said** `"코드 레벨로만"` ← exact quote, Korean/English original
**They meant**: narrow to source/tests/gates, exclude docs
**Evidence**: ../sessions/2026-05-23-...md L42-L51 (3 corrections same week)
**Confidence**: high (3 repetitions) | medium (2) | low (1)
```

- Quote는 **paraphrase 금지** — copy literal
- Confidence는 **count-based** (subjective scoring 금지, [[no-heuristics-only-validated]])
- Korean/English 모두 보존 (예: "병렬로" / "in parallel" 둘 다 trigger)

### 3. Memory promotion pipeline (manual, no auto)

- `raw_*.md` (prefix) = unmerged thread-by-thread (Codex의 raw_memories.md 패턴)
- `MEMORY.md` index = merged scoped-by-project (현재 우리 시스템 그대로)
- **Promotion criteria** (manual review checklist, target ~10% pass rate):
  - [ ] outcome != fail
  - [ ] preference phrase exact quote 있음 OR file:line evidence 있음
  - [ ] cross-session reuse 가능 (single-incident 메모는 stay raw)
  - [ ] 후속 agent에게 useful (현 작업만 위함이면 skip)

Auto-promotion은 deferred (sample size 부족, manual review가 더 안전).

## Alternatives considered

1. **Percentage-based outcome** (e.g., "80% done"): rejected. inflation 직격탄. Codex가 4-state enum 쓰는 이유 = "percent grace = inflation"
2. **ML-based phrase clustering**: rejected. [[no-heuristics-only-validated]]와 충돌 (검증된 신호만). 또한 sample size 부족.
3. **Auto-promotion based on usage_count**: rejected for now. Codex의 `usage_count` field는 있지만, auto-trigger 기준이 불명확. manual review 먼저, auto는 evidence 축적 후.
4. **Frontmatter required**: rejected. opt-in이 채택률 높음. 강제 시 기존 메모리 mass rewrite 필요.

## Invariants preserved

1. 기존 메모리 파일 **하나도 mutation 안 함** (frontmatter 신규 field는 optional). [[codex-absorption-complete]] byte-identical 정신.
2. memory loader (현재 turn마다 MEMORY.md 로드)는 신규 field 무시 가능 — backward compat.
3. [[no-heuristics-only-validated]]: outcome enum은 fixed-set (4 values), preference confidence는 count-based, promotion은 manual checklist — 모두 검증된 기준.
4. multi-surface ([[surface-model]]): memory 시스템은 surface-agnostic (Codex memory도 CLI/Desktop 공통). 우리 CLI/Web/Embedded browser 모두 동일 schema 사용.

## Tradeoffs

- **Manual promotion = slow**: Codex는 stage1 job이 비동기 처리 (R3 finding: `memory_consolidate_global` / `memory_stage1` jobs with watermark). 우리는 처음엔 manual. auto는 V2 (sample size 후).
- **Frontmatter linting overhead**: outcome enum + evidence 강제 시 작성 친화성 ↓. opt-in이라 부담 적지만 dev이 무시할 위험. mitigation: lint warning, error 아님.
- **Korean phrase 정확성**: 사용자가 typo 또는 변형하면 phrase grammar가 무용. mitigation: phrase 매칭은 substring + lowercase + whitespace-normalized, 정확 일치 강요 X.

## Out of scope (deferred)

- **Auto stage1→phase2 promotion pipeline** with worker pool (Codex의 `jobs` 테이블) — 우리 sample size 충분히 모인 후 V2 ADR
- **Memory summary auto-generation** (Codex의 `memory_summary.md`) — V2
- **Cross-session phrase corpus indexing** (전체 memory에서 phrase 추출 → 색인) — V2 후보
- **Chronicle-style screen-capture context** — [[no-heuristics-only-validated]]와 충돌, 영구 deferred ([[0130-extracted-source-absorption-roadmap]] negative invariant 2)

## Validation (post-implementation)

이 ADR이 accepted되어 구현되면 검증할 지표:

- [ ] 신규 memory file 중 outcome field 채택률 ≥ 50% (4주 후)
- [ ] outcome = success 비율이 Codex 분포 (15%)와 유사 — 더 높으면 inflation 의심
- [ ] preference phrase grammar 채택 feedback memory의 phrase 정확 quote 비율 ≥ 80%
- [ ] memory recall test (smoke battery 신규 case) 신규 schema가 기존 동작 break 안 함
