# ADR-0051 — Sectioned system prompt default ON (Claude Desktop `systemPromptSectionCache` 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0003 (cache 레버), ADR-0004 (시스템 prompt byte-stability),
  [[claude-desktop-1-7196-catalog]] §systemPromptSectionCache,
  [[cc-v2-sota-absorption]]

## 맥락

Claude Desktop 1.7196.3 catalog는 `systemPromptSectionCache` 패턴을 보고한다:
하나의 30–50 KiB 시스템 prompt를 단일 cached 블록으로 보내는 대신,
`base + project_md + session_ctx + user_append` 4개의 named, byte-stable
section으로 나눠 각각 `cache_control` breakpoint를 부여. Anthropic API는 최대
4개 breakpoint를 허용하므로 정확히 cap에 맞춘다.

장점: project policy(`CLAUDE.md`) 또는 user-supplied prefix(`~/CLAUDE.md`)가
변경될 때, 전체 prefix를 invalidate하지 않고 변경된 뒤의 section만 다시
계산. base는 영구히 warm 상태로 유지.

v3는 ADR-0003에서 단일 cached SystemBlock prefix를 채택했었다. 이는 단일 정적
prompt 시나리오에는 충분하지만, repo-local 규칙(`repoRules.body`)이 활성화된
세션에서는 매 세션마다 prefix가 바뀌어 cache 재사용 불가. Claude Desktop의
4-section 패턴은 정확히 이 문제를 해결한다.

## 결정

### D1. `prompt-sections.ts` 모듈 신설

새 슬라이스: `src/agent/prompt-sections.ts`. 다음을 export:

- `MAX_CACHE_BREAKPOINTS = 4` (Anthropic cap).
- `PromptSection { name, text, cache }` — named span.
- `buildSectionedSystemBlocks(sections)` — `PromptSection[] → SystemBlock[]`.
- `defaultPromptSections(basePrompt)` — legacy 1-section preset.
- `fourSectionPreset({ base, projectMd?, sessionCtx?, userAppend? })` —
  4-section preset. 누락/빈 input은 collapse(빈 블록 없음).
- `validateSectionsCacheBudget(sections)` — fail-soft cache cap 검사.

### D2. `buildTurnContext` auto-wire

`repoRules.body` 또는 `userAppend` 또는 `sessionCtx` 중 하나라도 non-empty면
4-section preset 활성. 셋 다 없으면 **byte-identical 단일 SystemBlock** —
legacy 호출자(bench, e2e 등)는 prefix가 단 1바이트도 변하지 않음.

`TurnContextInput`에 두 필드 추가:
- `sessionCtx?: string` — caller-supplied STATIC 컨텍스트(tool inventory hash,
  install id 등). 동적 데이터(date, cwd, plan notice)는 여기 들어가지 **않음**.
- `userAppend?: string` — user-supplied STATIC prefix(예: 글로벌 `~/CLAUDE.md`).

### D3. Fail-soft budget validation

`validateSectionsCacheBudget`는 `{ok:false, cachedCount, limit}`을 반환하지만
buildTurnContext는 **그래도 send**. provider가 실제로 400을 던지면 surface.
dev mode 경고 책임은 caller에게.

### D4. 동적 reminder의 repoRules 블록은 그대로 유지

기존 `buildDynamicContext`는 여전히 repoRules를 trailing `<system-reminder>`에
labelled block으로 렌더링한다. 캐시된 `project_md` section과 의도적으로 중복:
- cached section은 cache 재사용을 위해 byte-stable한 raw body.
- dynamic reminder block은 `"## Repo-local rules (from <entrypoint>)"`
  label과 함께 다른 contextual data(memory, working state) 옆에서 LLM이
  authority로 인지하도록.

향후 토큰 절감이 필요하면 dynamic reminder의 repoRules 렌더를 drop할 수 있다
(별도 ADR).

## 결과

- 신규 파일: `src/agent/prompt-sections.ts` (98 lines).
- 변경 파일: `src/agent/prompt.ts` (TurnContextInput에 2 필드 + buildTurnContext
  분기 추가; 기존 import 1개 추가).
- 신규 테스트: `tests/unit/agent/prompt-sections.test.ts` (13 tests / 35 expects).
- 갱신 테스트: `tests/unit/prompt-dynamic.test.ts` — 기존 "repoRules block
  does NOT shift the cached system prefix" 불변을 isRetired, 대신 "base
  section은 byte-stable, project_md는 별도 cached section"로 갱신.
- typecheck: green. lint: green (신규 파일/변경 파일 0 errors). bun test
  tests/unit: 2813 pass / 0 fail.

## Negative invariants

본 ADR로 invariant 되는 것:

- **N1**. 동적 데이터(today's date, cwd, plan notice)는 **절대** `sessionCtx`에
  들어가면 안 됨. 동적 데이터는 trailing `<system-reminder>` user message
  로만 ride.
- **N2**. `cache_control` breakpoint는 최대 4. `fourSectionPreset` 외에 추가
  cached section을 도입하려면 별도 ADR + `MAX_CACHE_BREAKPOINTS` 증가
  검토.
- **N3**. section ORDER는 cache prefix의 일부. `base → project_md → session_ctx
  → user_append` 순서는 절대 reorder 금지.
