# ADR-0149: Engineering-task skill bundle (4 system skills — debug / test / explain / refactor)

> **Renumbered 2026-05-24** from ADR-0134 due to collision with `0134-skill-scope-tiering.md`. User entry kept the original number; this slice moved to 0149.

- **상태**: Accepted
- **날짜**: 2026-05-24
- **소스 분석**: Cursor cursor-team-kit (CTK) engineering-task skills (~12 cataloged); quanta absorbs 4 highest-ROI first.
- **관련 ADR**: ADR-0111 (CTK git-skill bundle — sibling absorption; this round is the engineering-task complement), ADR-0040 (bundled system-skills layout), ADR-0045 (progress-audit precedent — discipline skill shipped with binary), ADR-0122 (rewind skill — most recent pattern reference).
- **참조**: `src/skill/system-skills/{debug-error,add-tests,explain-code,extract-function}/{SKILL.md,index.ts}`(4 × 2개), `tests/unit/system-skills-new-bundle-hellgate.test.ts`(12-case smoke + hellgate).

## 맥락

ADR-0111이 흡수한 CTK 8 git skills는 **git workflow** 슬라이스를 덮는다 (PR babysit / merge-conflict / CI loop / PR review canvas …). CTK 카탈로그에는 **engineering-task** 슬라이스도 있다 — 코드 작성/디버깅/리팩토링/설명같이 git과 무관한 일상 엔지니어링 행위에 대한 SOTA 프롬프트. 이쪽은 아직 미흡수.

엔지니어링 태스크 중 ROI 최상위 4개를 우선 흡수:

| 스킬 | 한 줄 책무 |
|---|---|
| `debug-error` | 실패 테스트/스택트레이스/예외를 evidence-first로 진단 (반드시 read → reproduce → bisect → hypothesize → patch+reverify) |
| `add-tests` | 대상 함수 읽기 + 엣지케이스 명시 + 프로젝트 컨벤션 매칭 + 실제 실행 후에야 done 선언 |
| `explain-code` | 파일/함수 설명 시 메모리/이름 기반 추측 금지; READ FIRST + callers + history + tiered explanation |
| `extract-function` | 코드 블록 → 함수 추출 시 caller-survey 선행 + intent name + boolean-flag = code smell + 회귀 검증 |

공통 패턴: 각 스킬은 5개의 P0 룰 + 절차(Procedure) + outcome enum을 가진다. CTK git-skill 흡수와 정확히 동일한 shape.

가장 기깔난 단일 룰은 **debug-error의 P0 #4 "Reproduce locally BEFORE editing"** — "A fix unverified is a hypothesis" 한 줄이 LLM의 가장 흔한 실패 모드(증상 추측만으로 패치)를 차단한다.

## 결정

엔지니어링 4개 스킬을 quanta 시스템 스킬(`src/skill/system-skills/<name>/SKILL.md`)로 흡수한다. 각 스킬은:

1. **Prompt-only — 코드 의존성 0.** SKILL.md 본문이 전부. 새로운 도구를 도입하지 않으며, `allowedTools`는 이미 존재하는 도구(Bash/Read/Grep/Edit + 슬라이스 도구)만 참조.
2. **frontmatter 표준화** (ADR-0111과 동일):
   - `name` (디렉토리와 일치 — router-drift prevention)
   - `description` (트리거 발화 포함)
   - `userInvocable: true`
   - `allowedTools: [...]` (strict 6-field 시그니처)
   - `tools: [...]` (lenient mirror — discoverSkills() 런타임 enforcement 경로)
   - `category: skill` / `stability: stable`
3. **본문 구조** (consistency invariant — hellgate가 픽함):
   - "When this skill activates" — 3-4 트리거 발화
   - "## P0 rules" — 정확히 5개 (rule numbering preserved)
   - "## Procedure" — 5-6 step 절차
   - 도메인별 추가 섹션 (debug-error의 "Common error families", add-tests의 "What to test", explain-code/extract-function 도 동일 패턴)
   - "## Outcome enum" — 종료 상태들 + "complete" 단어 금지 (CTK 패턴 계승)
4. **라우터 seam — `<name>/index.ts`** (ADR-0111 / ADR-0122와 byte-identical 패턴):
   - `<NAME>_SKILL_NAME` 상수 (SKILL.md `name:`와 동일, 드리프트 시 hellgate 실패)
   - `<Name>Trigger` 인터페이스 (literal `name` type)
   - `trigger<Name>()` — `{ name: "<skill-id>" }` 반환 (외부 라우터용 typed entry)
   - `find<Name>Skill()` — discoverSystemSkills() lookup
5. **default-OFF**: 시스템 스킬 슬라이스의 일반 정책 — description match 또는 명시적 invoke 없이는 활성 안 됨. `kind: "system"` 필터로 라우터 책임.

### 스킬별 요약

**`debug-error`** — 트리거: "debug this error" / "what does this error mean" / "fix this stack trace" / "why is this failing". P0 5개의 핵심은 (1) 실제 에러 텍스트 verbatim 인용 → (2) stack frame의 file:line을 Read → (3) `git log` 으로 최근 변경 확인 → (4) 로컬 재현 → (5) 모든 주장에 file:line + 관찰값 인용. "A fix unverified is a hypothesis"가 키 슬로건.

**`add-tests`** — 트리거: "add tests" / "write tests for" / "test coverage for" / "what should I test in". P0 5개의 핵심은 (1) 대상 함수 Read 선행 → (2) 엣지케이스를 명시적으로 enumerate → (3) `package.json` + 기존 테스트로 프레임워크 일치 → (4) 가능하면 real fixture, mock은 외부 의존성만 → (5) 새 테스트 실행 후에야 done. "A test that doesn't run is not a test"가 키 슬로건.

**`explain-code`** — 트리거: "explain this code" / "what does X do" / "walk me through this" / "how does this work". P0 5개의 핵심은 (1) READ FIRST (파일명/메모리 추측 금지) → (2) `lsp_references`로 callers 발견 → (3) `git log` / `git_blame`으로 history → (4) tiered explanation (1-문장 purpose → data flow → edge cases) → (5) 모든 주장에 file:line. "READ FIRST — don't summarize from memory or filename"이 키 슬로건.

**`extract-function`** — 트리거: "extract this into a function" / "refactor to function" / "pull this out" / "DRY this up". P0 5개의 핵심은 (1) `lsp_references` / `grep`으로 모든 caller survey 선행 → (2) intent-name (구현이 아니라 의도) → (3) subject-first 매개변수, boolean flag = code smell → (4) docstring의 "and" = SRP 위반, 분리 → (5) typecheck + test로 회귀 검증. "Extraction without caller-survey is premature abstraction"이 키 슬로건.

## 트레이드오프

**가져간 것**:
- 4개 즉시 가용한 일상 엔지니어링 스킬 (각 SKILL.md ~120-150 lines, 직접 작성 시 4 × 수 시간의 SOTA prompt design 분량).
- "evidence-first + cite file:line" 행위 양식의 LLM-side 강제 — 메모리/이름 기반 추측의 가장 흔한 LLM 실패 모드 차단.
- ADR-0111 CTK git 클러스터와 byte-identical 라우터 패턴 — 새로운 와이어업 코드 0, 기존 `discoverSystemSkills()` 경로가 자동 등록.

**의도적으로 안 가져간 것**:
- "1 mega-skill `engineer` with all 4" — description 매칭 정확도가 떨어져서 LLM이 어떤 사이드(디버깅 vs 리팩토링 vs 설명)를 활성화할지 신뢰 못 함. 단일 스킬 = 단일 트리거 의도.
- 코드 동봉 스킬 (e.g. 정적 분석을 자동 실행하는 babysit-style 루프) — 시스템 스킬 정신은 prompt-only; behavior는 본문이 LLM에게 시키는 일.
- Tier1 builder 게이팅 — 시스템 스킬은 always-available (`kind: "system"` 필터가 라우터 책임). 게이트는 description 매칭 + 사용자 invoke만.
- CTK 카탈로그의 나머지 ~8 엔지니어링 스킬 (rename-symbol / add-types / profile-perf / audit-deps …) — ROI 측정 후 다음 라운드. 한 번에 전부 흡수하면 description-매칭 노이즈가 커진다.

## 가드레일 (4 스킬 공통)

| 가드 | 적용 스킬 | 근거 |
|---|---|---|
| READ FIRST (파일 / 함수 / 에러텍스트) | 4개 전부 | 메모리/이름 기반 추측 = LLM의 가장 흔한 실패 모드 |
| cite file:line on every claim | 4개 전부 | 검증 가능성; "uncited claim is a guess" |
| verify before "done" (test / typecheck / repro) | debug-error, add-tests, extract-function | "A fix unverified is a hypothesis" |
| caller-survey before extracting | extract-function | "Extraction without caller-survey is premature abstraction" |
| `complete` 단어 금지 | 4개 전부 | 각 스킬은 outcome enum 선언, implicit "done" 차단 (ADR-0111 계승) |

## 테스트

| 테스트 | 책무 |
|---|---|
| `tests/unit/system-skills-new-bundle-hellgate.test.ts` (본 ADR) | 12-case: SKILL.md frontmatter (×4) + router descriptor (×4) + 본문 P0/Procedure header invariant + discoverSystemSkills() 포함 / unique-name |
| `tests/unit/skill-git-bundle.test.ts` (ADR-0111) | 회귀 — 기존 8 CTK 스킬이 그대로 등록되는지 |

## 향후 통합

- 카탈로그 다음 라운드 후보 (ROI 측정 후): `rename-symbol`, `add-types`, `profile-perf`, `audit-deps`, `simplify-condition`, `inline-variable` 등 — Cursor CTK + Codex의 엔지니어링 카탈로그에 모두 존재.
- LLM-eval of skill-trigger accuracy — 4개 description의 트리거 발화가 실제로 모델 라우팅에서 잡히는지 (false positive / false negative) 측정. 트리거 워딩이 P0 #5 "cite file:line" 같은 룰의 효과를 좌우.
- slash-command 라우터 (`src/apps/cli/slash-commands.ts`)가 정착되면 `/debug-error` / `/add-tests` / `/explain-code` / `/extract-function`를 `trigger<Name>()` 시드 그대로 와이어업.

## 결과

- 4 SKILL.md (`src/skill/system-skills/<name>/SKILL.md`) — 각 ~120-150 line, 5 P0 + Procedure + Outcome enum.
- 4 router seam (`src/skill/system-skills/<name>/index.ts`) — ADR-0111 / ADR-0122 패턴과 byte-identical.
- `src/skill/system-skills/index.ts` + `src/skill/index.ts` 배럴 4개 항목 알파벳 위치 추가 (기존 순서 보존).
- 12-case 스모크+hellgate 테스트 1개 신규.
- 기존 `discoverSystemSkills()` 자동 등록 (별도 와이어업 0).
- `disable-model-invocation` 의도적 omit (description 매칭 활성화 — ADR-0111 계승).
