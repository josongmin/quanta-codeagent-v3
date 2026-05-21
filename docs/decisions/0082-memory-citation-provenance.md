# ADR-0082: memory_citation provenance surface

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0003 (cache-prefix system / per-turn reminder-tail), ADR-0021 (L3 WorkingState), `src/agent/memory.ts` recallContext, `src/memory/ranking.ts` weighted-sum 스코어.

## 맥락

v3는 long-term memory recall (`recallContext`)이 매 턴 trailing `<system-reminder>`
user message로 합쳐지지만, 어떤 record가 **실제로 프롬프트 윈도우에 들어갔는지**
재구성할 surface가 없다. 디버깅·trajectory 분석·"이 record가 영향을 줬나" 질문에
답하려면 placement provenance가 필요한데, 모델이 본문에서 record를 인용했는지
사후-스캔하는 휴리스틱은 금지(루팅 힌트와 답 사이에 1:1 대응이 없고, 회피해야 할
"usually works" 패턴).

따라서 "cited"의 정의를 **prompt-window placement** 단일 기준으로 못 박는다.

## 결정

### D1. 닫힌 `where` enum

`MemoryCitation.where: "system_prompt" | "reminder_tail" | "tool_result_injection"`.

- `system_prompt` — system prompt body로 folded (v3는 현재 미사용; 미래 surface 대비).
- `reminder_tail` — trailing `<system-reminder>` user message (오늘 quanta의 유일한 placement seam).
- `tool_result_injection` — synthetic tool_result observation (Codex side-conversation 류; v3는 현재 미사용).

오늘 모든 v3 메모리 citation은 `reminder_tail`이다. 미래 seam 추가 시 enum이 강제로 분기를 깨우므로 누락 없이 stamp 된다.

### D2. Provenance signal — `RecallDeps.onPlaced`

`src/agent/memory.ts`의 `recallContext`에 best-effort `onPlaced(placed: readonly PlacedRecord[])` 콜백을 추가한다. limit 예산을 통과해 렌더링 블록에 folded 된 entry들만 발화하며(즉 `store.recall` 결과 = placed 집합), 각 row는:

```ts
interface PlacedRecord {
  readonly recordId: string
  readonly score: number      // src/memory/ranking.ts `scoreEntry` (weighted-sum)
  readonly tokensApprox: number  // chars(truncate(text))/4
}
```

콜백 throw는 swallowed (observability never breaks recall). 0건 recall ⇒ 콜백 미발화.

### D3. Loop accumulator + surface

`runAgent`(`src/agent/loop.ts`)는 `cfg.store` 가 wired 된 경우에만 run-scoped `MemoryCitation[]` 을 할당하고, `prepareTurnContext` → `resolveMemoryContext`로 sink를 plumb 한다. sink 콜백이 `where: "reminder_tail"` 을 stamp 해서 `AgentOutcome.memoryCitations` 에 append-only로 누적한다.

- **append-only across run**: 한 record가 N turn에 걸쳐 placed 되면 N row 발생 (해당 record가 N턴 동안 anchored 됐다는 신호).
- **OMIT 정책**: store 미설정 OR (store wired였지만 전체 run에서 recall 0건) ⇒ outcome에서 필드 자체 omit. legacy reader는 `reason/turns/messages`만 읽으므로 byte-identical.

### D4. Score 노출 — `scoreEntry` 익스포트

`src/memory/ranking.ts`에 `scoreEntry(entry, query, now)` pure 헬퍼를 추가하고 `@/memory` 에서 익스포트. `rankEntries`가 내부에서 쓰는 `scoreOf`와 1:1 동일한 weighted-sum이므로 placement 순위 결정 점수와 citation 점수가 같은 값. double-ranking 비용 0.

## 근거

- **휴리스틱 금지 — placement = provenance**: assistant response를 스캔해 "인용 여부"를 추정하는 NLP 매칭은 false-positive/negative 불가피. 프롬프트 윈도우에 들어간 사실은 deterministic, observable.
- **default-OFF byte-identical**: `cfg.store` 미설정 시 accumulator 미할당, sink 미생성, `recallContext` 호출 자체 없음 ⇒ 기존 모든 콜러 byte-identical.
- **score 신뢰**: `rankEntries`의 정렬 키와 동일 산식. cross-turn 비교는 query가 변하므로 informational only, intra-turn 비교는 정확.

## 대안

- **A. assistant text scan**: 기각(휴리스틱).
- **B. metric counter only**: 기각 — 어떤 record가 영향을 줬는지 식별할 수 없어 trajectory가 빈약.
- **C. recallContext 시그니처 변경 (string|null → 구조체)**: 기각 — 7 unit + 다수 e2e 테스트가 string 반환에 의존. `onPlaced` 콜백이 비차폐 add-on.

## 결과·트레이드오프

- **얻은 것**: 7 tests pass (4 unit + 3 integration), trajectory/triage가 "이 record가 N턴 prompt-window에 anchored 됐다"는 신호를 직접 읽을 수 있음.
- **비용**: `MemoryEntry.id` 당 N citations (N=anchored turns). 100턴 5-recall full session ⇒ 최대 500 rows × {recordId,score,where,tokensApprox} ~= 수 KB. acceptable.

## 한계 (LIMITATIONS)

- (a) `system_prompt` / `tool_result_injection` placement seam은 현재 v3에 없음. enum은 미래 surface 대비.
- (b) recall reinforcement (accessCount/importance bumps)는 다음 recall 점수를 변동시키므로, 같은 run의 동일 record 동일-쿼리 cross-turn 점수는 strict equal이 아님 (best-effort/append-only 의도와 일치).
- (c) `tokensApprox` 는 entry.text의 chars/4 — block 헤더("- (kind) ")와 `formatBlock` 의 `\n` 비용은 미반영. relative 비교용으로만 사용.

## 불변식 영향

- **byte-identical default**: `cfg.store` 미설정 시 outcome shape 변경 0.
- **슬라이스 격리 유지**: `@/memory` 에 `scoreEntry` 추가; `@/agent` 는 콜백 plumbing.
- **휴리스틱 금지 유지**: response scan 없음. placement만.
- **에러삼킴 금지 보존**: `onPlaced` throw는 best-effort swallow의 기존 패턴 (RecallStats `emitStats` 와 동일 정책).
