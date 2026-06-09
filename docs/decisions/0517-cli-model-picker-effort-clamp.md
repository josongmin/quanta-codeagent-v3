# ADR-0517: `/model` interactive picker + model↔effort clamp (Codex `validateEffort` mirror)

- **상태**: Proposed
- **날짜**: 2026-06-09
- **슬라이스**: `src/apps/cli/slash/model-picker.ts`(NEW — 순수 코어) · `src/apps/cli/slash/model-cmd.ts`(NEW — SlashCommand 본체) · `src/apps/cli/repl/ctx-adapters/model-adapter.ts`(NEW — ctx-adapter). 기존 seam 확장: `src/apps/cli/slash-contract.ts`(`SlashContext.model` 슬롯) · `src/apps/cli/slash/registry-surface.ts`(`modelCmd` 등록) · `src/apps/cli/repl/surface-compose.ts`(`buildModelAdapterWire` 배선).
- **게이트**: 무-신규-게이트. `/model`은 surface 슬롯(`ctx.model`)이 바인딩되어야만 동작 — 슬롯이 없으면 "not wired" + exit 0(byte-identical). 슬롯 바인딩은 sticky-model 저장소(ADR-0462/ADR-0212) 가용성에 종속.
- **관련**:
  - 확장: ADR-0462(sticky-model SET surface — 본 ADR이 `/sticky-model <mode> <modelId>`의 명시적 2-인자 폼을 보완하는 **mode-implicit 인터랙티브 picker + 후보 리스트**를 추가; 동일 `StickyModelStore` 인스턴스 재사용으로 SET 일관) · ADR-0212(fs-backed sticky-model store + resolver — 저장 백엔드)
  - 재사용(신축 금지): `@/llm/provider-metadata`(`resolveModelWindow`/`resolveModelEffortSupport`/`ModelEffortSupport`/`ReasoningEffort` — per-model 메타 SSOT) · `@/agent`(`EffortLevel` 표준 vocabulary) · `@/agent/sticky-model`(`StickyModelStore`) · `@/shared`(`AGENT_PROMPT_MODES`)
  - SOTA 레퍼런스(`.extracted_source/`): Claude Code CLI picker(`_cli-symbols.txt:145230` — per-model context-window inline + "Default (recommended)" 배지 + capability blurb) · Codex `validateEffort`(`use-model-settings-DhE-8qP1.js:106` — 모델 전환 시 reasoning effort를 새 모델의 `supportedReasoningEfforts`로 재검증/클램프)

## Context

`/model`(또는 그에 준하는 모델 전환)과 `/effort`(reasoning-effort 전환)는 독립 명령이었다. 두 명령이 직교로 동작하면 **비-reasoning 모델에 high reasoning-effort가 그대로 박혀 있는 비일관 상태**가 만들어진다 — `/effort high` 후 `/model gpt-4o`를 하면, gpt-4o는 reasoning을 지원하지 않는데도 세션 effort는 `high`로 남는다. 다음 턴은 무의미하거나(메타가 무시) 잘못된(공급자 400) 요청을 던진다.

추가로, ADR-0462가 들인 `/sticky-model`은 **명시적 `<mode> <modelId>` 2-인자**만 받고 후보 리스트를 렌더하지 않는다. 사용자는 어떤 모델 id가 선택 가능한지, 각 모델의 context-window/max-output/추천 여부를 모른 채 정확한 슬러그를 외워서 쳐야 했다. 경쟁사(Claude Code)는 picker에서 per-model 메타를 inline으로 보여준다.

## Decision

**(A) 순수 코어 `model-picker.ts`** — SlashContext 없이 unit-test 가능한 3개 순수 함수:
- `formatModelLine(meta, current)`: 후보 1행 렌더. 현재-마커 컬럼 + id + 존재하는 메타 세그먼트(`400k ctx · 128k out · (recommended) · most capable`)만 `·`로 조인. **메타 부재 필드는 placeholder 없이 OMIT**(graceful degrade, plan §14) — 메타 전무 모델은 bare id로 렌더.
- `pickModel(requested, candidates)`: 정확매치 → 대소문자무시매치 → `UnknownModelError`(silent fallback 없음 — `/effort` 패리티). 입력 trim 선처리.
- `clampEffortForModel(modelId, currentEffort, support)` — **본 ADR의 correctness 핵심(Codex `validateEffort` 미러)**: `support===undefined`(un-tabled 모델) ⇒ CONSERVATIVE all-supported(절대 클램프 안 함 — spurious downgrade 금지) · 현재 effort가 `support.supportedEfforts`에 있으면 no-op · 없으면 `support.defaultEffort`로 클램프 + 누락 tier/새 tier를 명명한 1줄 notice. 메타 슬러그→`EffortLevel` 변환은 `Record<ReasoningEffort, EffortLevel>` **컴파일-체크 EXHAUSTIVE 테이블**(`as` 캐스트 제거 — 한 union에서 tier를 빼고 다른 곳에 안 빼면 본 파일이 빌드 에러)을 통과.

**(B) 명령 본체 `model-cmd.ts`** — `/effort` 구조를 그대로 미러. no-arg ⇒ 현재 모델(`*` 마킹) + 모든 후보 + `use:` 힌트 렌더; 1-arg ⇒ `resolveChosen` → `model.set` → `applyEffortClamp`(effort 와이어와 모델 effort 메타가 둘 다 있을 때만 reconcile — 보수적); arity/unknown은 exit 1. `ctx.model===undefined` ⇒ "not wired" + exit 0. tab-complete = 후보 id prefix 필터. 자체 `*-cmd.ts` 모듈에 격리되어 `model-picker` import이 ADR-0306 fence 하에서 허용(registry는 opaque `SlashCommand`로만 가져감).

**(C) ctx-adapter `model-adapter.ts`** — surface의 모델 사실을 `SlashContext.model` 슬롯에 투영. `current()`는 host getter(있으면 승) → per-mode **SYNC SHADOW**(이 adapter 자신의 `set()`이 갱신 — async sticky store는 sync getter로 못 읽으므로 in-surface set을 즉시 반영) → boot model 순. `candidates()`는 boot+retry 후보를 provider-metadata SSOT로 enrich(window/output/recommended/hint). `set(id)`은 **ADR-0462가 쓰는 동일 `StickyModelStore`**를 CURRENT 모드 키로 persist(mode-implicit) — `/model`과 `/sticky-model`이 한 저장소에 수렴, 루프 consume side(ADR-0462)가 둘 다 관측. `effortSupport(id)`는 (B)의 클램프 입력을 resolve.

## Consequences

- **(+)** `/model gpt-4o` 한 번으로 모델 전환과 effort 일관성이 함께 잡힌다 — 비-reasoning 모델에 high effort가 남는 비일관 상태가 구조적으로 제거(Codex 패리티).
- **(+)** picker가 per-model context/output/추천/capability를 inline으로 노출 → 사용자가 슬러그를 외울 필요 없음(Claude Code 패리티). 메타 부재는 graceful degrade라 신규 모델도 bare-id로 안전.
- **(+)** `as` 캐스트 제거 + EXHAUSTIVE 테이블로 effort↔model union 드리프트가 컴파일 에러로 잡힘.
- **(−/수용)** `current()`의 sync shadow는 in-surface set만 반영하고 host getter가 없을 때만 권위 — async store가 진짜 SSOT이므로 cross-surface 동시 set은 다음 turn host resolve에서 수렴(의도된 eventual-consistency).
- **(−/수용)** 웹/IDE surface 미배선 — 슬롯 바인딩이 CLI surface-compose에만 있음. web picker는 후속(slash 서버 라우팅 stub은 실행 안 함).

### Alternatives considered

1. **`/effort`에 모델-aware 가드만 추가** — effort 명령이 모델 전환을 모르므로 `/model` 후 stale effort를 못 잡음. 클램프는 모델 전환 시점에 걸려야 한다(거부).
2. **`/sticky-model` 확장으로 picker 흡수** — `/sticky-model`은 명시적 `<mode>` 인자라 mode-implicit UX와 충돌하고, 후보 리스트/effort 클램프를 끼우면 단일 명령이 비대해짐. 별도 mode-implicit `/model`로 분리하되 **동일 store 재사용**으로 일관성 확보(채택).
3. **per-model 힌트를 하드코딩 테이블로** — 드리프트 위험. `deriveHint`가 provider-metadata SSOT(`reasoning`/window)에서 순수 유도하고 신호 부재 시 omit(채택).
