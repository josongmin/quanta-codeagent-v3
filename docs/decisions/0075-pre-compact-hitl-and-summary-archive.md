# ADR-0075 — Pre-Compact HITL + ConversationSummaryArchive (Cursor 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0011 (compaction summarizer LLM), ADR-0034 (session jsonl envelope: `event_msg:context_compacted` slot), ADR-0048 (response-in-progress event), Cursor compaction reverse-engineering (`reviews-cursor-agent/...` series).

## 맥락

기존 v3 compaction (`src/agent/compaction.ts` + `loop.ts maybeCompact`)은 **out-of-band**:

- proactive 임계 도달 → `compactIfNeeded`가 합성 `<conversation summary>` user message로 prefix 교체 → 끝.
- 사용자는 *언제* compact이 일어났는지 모르고, transcript에 마커도 없으며, 한 번 접힌 prefix를 시각화할 데이터 구조도 없다.
- 호스트(CLI/Web/Desktop)는 압축을 **거부하거나 미룰** 수 없다 — 임계 + 경계만 맞으면 무조건 진행.

Cursor의 compactor에는 두 가지 1급 시멘틱이 있다:

1. **`PreCompactRequestQuery`** — compaction 직전 호스트에 질의(`turnId`, `currentTokens`, `threshold`, `proposedKeep`, `proposedSummaryTokens`). 호스트는 `approve | defer_one_turn | force_now`로 답한다. UI가 "지금 30k 접을 텐데, 진행할까요?"를 1급으로 보여줄 수 있는 seam.
2. **`ConversationSummaryArchive`** — `summaries[]` 슬라이딩 윈도우. 매 압축마다 `{fromTurnId, toTurnId, summary, ts, tokens}` 한 행이 누적되어 세션 끝에 "context 역사"를 재구성할 수 있다.

v3 surface model(`surface-model`)은 CLI 단일이 아니므로, 두 메커니즘 모두 surface-비가용성 핑계로 보류할 수 없다.

## 결정

### D1. `AgentConfig.onPreCompact` — 호스트 HITL 콜백

신규 타입 `PreCompactRequestQuery` + `PreCompactDecision`:

```ts
type PreCompactRequestQuery = {
  turnId: string
  currentTokens: number
  threshold: number
  proposedKeep: number
  proposedSummaryTokens: number
}
type PreCompactDecision = "approve" | "defer_one_turn" | "force_now"
```

`AgentConfig.onPreCompact?: (q) => Promise<PreCompactDecision>`. 미설정 ⇒ legacy auto-approve.

**Seam 위치**: 콜백은 `compactIfNeeded`의 `preflight?` 옵션을 통해 invoke 된다 — 임계 + 경계가 모두 통과한 후에만 (즉 압축이 실제로 일어날 경우에만) 호스트 UI를 깨운다. 'one giant turn'이라 `findBoundary === 0`인 경우엔 콜백 호출 자체가 없다.

**Defer 시멘틱**: `defer_one_turn` ⇒ `{compacted:false}` 반환, 원본 messages 그대로. breaker가 무진전 사이클을 감시하므로 호스트가 무한 defer하면 자연스럽게 trip 된다.

**`force_now`는 approve와 동작 동일**: 루프는 둘을 1:1로 진행하되, 호스트가 emit/log에서 구분할 수 있도록 값을 보존한다.

**에러 처리**: 콜백이 throw하면 `maybeCompact`의 try/catch가 받아 `error` AgentEvent로 surface 후 이 턴 압축을 거른다 (fail-safe — 답을 못 받았으면 절대 prefix를 접지 않는다).

### D2. `ConversationSummaryArchive` — sliding-window 아카이브

신규 순수 모듈 `src/agent/conversation-summary-archive.ts`:

```ts
interface ConversationSummaryEntry {
  fromTurnId: string
  toTurnId: string
  summary: string
  ts: number
  tokens: number
}
interface ConversationSummaryArchive { summaries: ConversationSummaryEntry[] }

createArchive(): ConversationSummaryArchive
appendSummary(a, entry): ConversationSummaryArchive   // mutates + returns same ref
archivedTokens(a): number
```

**Clock-free**: `ts`는 호출자가 주입(루프는 `Date.now()` 1회만 호출). 테스트는 deterministic.

**Slice 격리**: `@/stream`/`@/llm`/`@/session` 무의존. 마커 emit은 루프 seam 책임.

**Default-OFF**: `AgentConfig.compaction.archive === true`일 때만 루프가 archive를 생성. 미설정 ⇒ no-allocation, no-emit, byte-identical.

### D3. `context_compacted` AgentEvent

신규 `AgentEvent` variant:

```ts
{
  type: "context_compacted"
  fromTurnId: string
  toTurnId: string
  summary: string
  ts: number
  tokens: number
}
```

- 기존 `recovery:{reason:"compact",detail:"proactive"}` 직후에 emit (legacy consumer는 byte-identical, 새 consumer는 풀 payload).
- `jsonl-recorder.ts KIND_MAP`에서 trajectory `recovery` kind로 매핑 (TrajectoryKind 미증설). `data.reason:"context_compacted"`로 legacy `reason:"compact"`와 grep-distinguish.
- `stdout.ts`에 dedicated `↺ context_compacted (from..to, Nt)` 한 줄 추가.
- `session/envelope.ts`의 `EventCustomSchema` (`kind:"custom", custom_kind:"context_compacted"`) 슬롯과 호환 — 추후 session jsonl 라이터가 이 AgentEvent를 받아 envelope record로 변환할 수 있다.

### D4. 루프 통합 (`loop.ts maybeCompact`)

순서:
1. 임계 + 경계 가드 (기존).
2. `onPreCompact` 호출 (있을 때만 — 미설정 ⇒ preflight option 자체를 빼서 `compactIfNeeded`가 await 없이 fast-path).
3. summary 생성 (기존).
4. `emitRecovery("compact","proactive")` (기존).
5. `breaker.recordProactive(before, after)` (기존).
6. `wm.replace(...)` (기존).
7. **신규** `archive !== undefined` 일 때만:
   - `extractSummaryText(result.messages[0])` — `<conversation summary>\n` wrapper 제거.
   - `appendSummary(archive, entry)`.
   - `config.stream.emit({type:"context_compacted", ...entry})`.

`turnId` 합성: `config.run?.turn` 우선, 없으면 루프의 turn counter로 `t${turn}`. `fromTurnId`는 직전 archive entry의 `toTurnId` (없으면 `"t0"`).

## 근거

- **HITL이 1급 seam인 이유**: compaction은 사용자의 history를 손실 압축하는 작업이다. legacy 자동 진행은 UX 마찰의 source가 됐다 (Cursor 흡수 노트). 호스트가 거부할 권리를 1급으로 제공해야 surface UI가 의미 있다.
- **`compactIfNeeded`에 preflight를 둔 이유**: 루프가 preflight를 부르고 compactIfNeeded를 부르는 2-step seam 대신, threshold/boundary 가드와 같은 자리에서 호스트 의사결정을 받으면 (a) 임계 미달 / 경계 0인 경우 절대 호스트가 깨지 않는다 (UI 노이즈 0), (b) unit test가 runAgent 없이 chain 전체를 검증 가능, (c) `proposedSummaryTokens` 휴리스틱이 prefix 계산과 co-located.
- **Archive를 별도 모듈로 둔 이유**: `compaction.ts`는 stateless (각 호출이 받은 messages만 본다) — archive는 across-compactions state. 합치면 compactIfNeeded가 mutable arg를 받거나 return해야 하고, 두 경우 모두 호출자가 매번 thread 해야 한다. `compaction-breaker.ts`와 같은 패턴 (작은 stateful collaborator, 루프 소유).
- **`context_compacted`를 trajectory `recovery` kind로 매핑한 이유**: 이번 흡수는 "마커 노출"이 목적, "새 retention/policy 분류" 도입이 아니다. `TrajectoryKind` 신규 값은 redaction policy + 모든 probe consumer로 ripple된다 — 압축 마커는 무진전 recovery family에 자연스럽게 속한다. payload는 `data`로 1급 JSON으로 가는다.

## 대안

- **HITL 없이 archive만 흡수**: 기각 — Cursor 흡수의 핵심 ROI는 호스트 거부권. archive 단독은 사후 관찰만 가능, 결정권 0.
- **archive를 `compaction-breaker.ts`에 합치기**: 기각 — breaker는 "thrash 감지" (size delta), archive는 "history 누적" (summary text). 책임 단위가 다르고, 합치면 breaker가 텍스트를 보유하게 되어 메모리 footprint가 결합된다.
- **신규 `TrajectoryKind: "context_compacted"`**: 기각 — `redactValue` policy / probe / Group E mapping 등 8군데 ripple. 본 흡수의 부수 비용이 큰 데 비해 marker grep은 `reason` 필드로 충분.
- **HITL을 `compactIfNeeded` 밖, `maybeCompact` 안에서 두 번 호출**: 기각 — threshold/boundary 결정이 compactIfNeeded 내부에 있어 루프에서 사전 평가가 중복된다. preflight in-place가 단일 진실.

## 결과·트레이드오프

- **얻은 것**:
  - `onPreCompact` HITL seam (3가지 결정 + fail-safe error 처리).
  - `ConversationSummaryArchive` 데이터 구조 + `context_compacted` 이벤트 마커.
  - 9 신규 unit + 8 신규 loop integration test (`compaction-precompact.test.ts`, `conversation-summary-archive.test.ts`, `compaction-archive-loop.test.ts`). 17 신규 test green; 26 기존 compaction-related test 회귀 0.
  - tsc clean / biome clean (cognitive complexity는 +1 — runAgent 사전부터 warn 영역).
- **비용**:
  - `AgentConfig` surface +2 필드 (`onPreCompact`, `compaction.archive`). 두 필드 모두 optional + default-OFF.
  - `AgentEvent` +1 variant — `stdout.ts`/`jsonl-recorder.ts`에 case 1개씩 추가.
  - `maybeCompact`/`runTurn`/`prepareTurnContext` 시그니처에 `archive`/`turn` 인자 thread (호출처 1개씩).

## 한계 (LIMITATIONS)

- (a) `turnId`는 현재 `t<turn-counter>` 합성. ADR-0034 envelope의 진짜 `turn_id`(uuid)는 별도 wiring follow-up — archive entry 키로 그 값을 받으려면 루프가 envelope 라이터와 직접 통신해야 한다 (현재는 슬라이스 격리 보존).
- (b) Archive에 **eviction / soft-cap 없음**: 세션 단위로 자연 한계 (RFC §6.3). 장기 세션에서 archive가 무한정 누적되는 시나리오를 가정한 retention 정책은 후속 ADR 대상.
- (c) `defer_one_turn` 무한 반복 방어는 `CompactionBreaker`에 의존 (no-progress 누적이 trip). HITL 전용 budget(`maxDeferrals`)은 미도입 — breaker가 충분히 cover.
- (d) **Session jsonl envelope 라이터 미배선**: `event_msg:context_compacted` 슬롯은 envelope.ts에 이미 있으나(EventCustomSchema), AgentEvent → envelope record 변환 라이터는 별도 작업. 현재 wiring은 stream consumer (CLI stdout / future jsonl recorder)까지만.

## 불변식 영향

- **byte-identical default**: `onPreCompact` + `compaction.archive` 모두 미설정 ⇒ 모든 emit/state/control-flow가 pre-ADR-0075와 비트 동등.
- **Fail-safe HITL**: 호스트 콜백 throw ⇒ 압축 거름(이번 턴만), error event surface, 다음 턴 재평가.
- **이벤트 순서 보존**: legacy `recovery:compact` emit이 항상 `context_compacted` emit보다 먼저 — 기존 trajectory consumer 영향 0.
- **슬라이스 격리 유지**: `@/agent` 내부 신규 모듈, 외부 슬라이스 의존 0 추가.
- **신규 npm dep 0**.
