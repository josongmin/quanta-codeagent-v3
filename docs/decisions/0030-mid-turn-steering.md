# ADR-0030 — Mid-turn steering + NonSteerableTurnKind

- **Status**: Accepted
- **Date**: 2026-05-21
- **Related**: ADR-0015 (Codex foundation / TurnContext),
  ADR-0018 (mode enum: plan/review/audit),
  ADR-0023 (SOTA Codex integration, byte-identical),
  ADR-0029 (Reviewer 3-tier + 8-state outcome),
  Codex 메모 [[codex-feature-catalog-2026-05-21]] §4 (Thread / Plan /
  Mid-turn steer),
  [[codex-desktop-build-2867-round-2]] R3-4 (Mid-turn steer + injection).

## Context

v3의 현 ReAct 루프(`src/agent/loop.ts`)는 turn 안에서 추가 입력을 받을 수
있는 채널이 없다. 사용자가 turn 도중에 "한 가지 더 봐줘"를 보내려면 (a)
현재 turn을 abort하고 (b) 새 turn을 열어야 한다. abort/restart는 컨텍스트
파괴와 부분 진척 손실을 동반한다 — 모델이 streaming 중이라면 partial
assistant turn이 잘려나가고, 이미 dispatch된 tool 결과가 다음 turn의
seed로 자동 흘러들지 않는다.

Codex Desktop build 2867 (codex-rs 0.130.0) 분석에서 다음 모델이 확인되었다:

- `core-skills/src/injection.rs` — turn이 진행 중일 때 user input을
  conversation의 user-message 슬롯에 *주입*해 다음 step에서 모델이 보게 한다.
  Turn boundary를 끊지 않고 컨텍스트를 보존한다.
- `expectedTurnId` — surface(CLI/Web/Desktop)가 본 turn id와 실제 active
  turn id를 비교하는 optimistic concurrency 키. mismatch면 race로 간주하고
  거부한다.
- `ActiveTurnNotSteerable { turn_kind }` — `review` / `compact` /
  `standalone` 같은 내부 turn은 사용자 주입을 거부한다. 각 kind는 자신의
  의미론적 invariant(review verdict purity, summarizer determinism,
  subagent isolation)를 가지므로 임의 user 메시지를 받으면 그 invariant가
  깨진다.
- 8가지 closed rejection reason — telemetry로 release 단위 trend를 본다.

기존 quanta v3는 (i) cancellation-only 모델, (ii) turn type 라벨 부재
(`AgentMode`는 dispatch-side mutation 게이트이지 turn intent label이 아님)
두 결함을 동시에 노출하므로, SOTA++ 보강이 필요하다.

## Decision

1. `src/agent/turn-kind.ts` (신규): `TurnKind = "main" | "review" |
   "compact" | "standalone"` enum + `NON_STEERABLE_KINDS` 명시 set +
   `isSteerable(kind)` 진리표 + `TurnHeader { turnId, kind, startedAt,
   threadId }` 컨스트럭터. 모든 invariant violation은
   `TurnHeaderInvalidError`로 throw — 폴백/sentinel 없음.
2. `src/agent/steering.ts` (신규): `steer(request, state, config)` 순수
   결정 함수. `SteerRequest`(expectedTurnId, input, submittedAt) +
   `ActiveTurnState`(currentTurn, isInterrupted) +
   `SteerConfig`(maxInputBytes)을 받아 `SteerOutcome` discriminated union
   (`accepted | rejected`)을 반환. 8개 `SteerRejectionReason`은 closed
   literal set으로 모든 거부 사유를 enumerate한다 — telemetry 친화.
3. 프로그래밍 수준 invariant 위반(non-string input, NaN timestamp,
   non-positive maxInputBytes 등)은 `SteerInputInvalidError`로 throw해
   호출자에게 "버그"로 surface한다. 폴리시 수준 거부와 분명히 분리된다.
4. 결정 순서는 documented이며 deterministic:
   `interrupted → no_active_turn → expected_turn_mismatch →
   non_steerable_{review|compact|standalone} → empty_input →
   input_too_large → accepted`. 한 요청이 여러 invariant를 위반할 때 항상
   첫 번째 위반이 우선 — replay/trajectory 재현 가능.
5. ADR-0018의 `AgentMode`와 본 ADR의 `TurnKind`는 **직교 축**이다.
   `AgentMode`(`default|plan|review|audit`)는 dispatch에서 mutating tool
   허용 여부를 결정하는 *권한 모드*이고, `TurnKind`는 한 turn의 *의도
   형상*(user-facing vs internal compaction / verifier / subagent task)을
   분류한다. 같은 `AgentMode.review`라도 turn은 user-facing `main`일 수
   있고(예: 사용자가 review 모드로 질문), 내부 `review` turn일 수 있다
   (예: closeout 직전 자동 검증 pass).

## Trade-offs

- **추가 모듈 2개 + ADR 1개**: 결정 경계가 작고 명시적이라 비용 작음.
  Reviewer 모듈(ADR-0029)의 패턴을 그대로 따른다 — pure 모듈 + 단위
  테스트 + 후속 PR에서 결선.
- **휴리스틱 없음**: 모든 거부 사유는 closed enum literal로 인코드,
  byte 길이는 `TextEncoder`로 deterministic하게 측정 (per-char 휴리스틱
  없음).
- **clock 외부 주입**: 모듈 내부에서 `Date.now()` 호출 없음 →
  trajectory replay/snapshot 결정성 보장.
- **default OFF**: surface 코드가 `steer()`를 호출하지 않으면 기존 루프와
  byte-identical. 결선 자체가 후속 PR로 분리되어 본 PR은 기존 1300+
  테스트에 0 영향.

## Codex reference 매핑

| Codex 구성요소                          | quanta 대응                                    |
|-----------------------------------------|------------------------------------------------|
| `core-skills/src/injection.rs`          | `src/agent/steering.ts` `steer()`              |
| `expectedTurnId` optimistic concurrency | `SteerRequest.expectedTurnId` + 결정 순서 #3   |
| `ActiveTurnNotSteerable { turn_kind }`  | `non_steerable_{review,compact,standalone}` 3종 |
| 8 closed rejection reasons              | `SteerRejectionReason` enum (8 literal)        |
| review/compact/standalone non-steerable | `NON_STEERABLE_KINDS` set (turn-kind.ts)       |
| Conversation injection (next-step view) | `SteerInjection { role:"user", content, ... }` |

Codex의 단일 `standalone_turn` reason은 본 ADR에서 의도적으로
`non_steerable_standalone` + `non_steerable_review` +
`non_steerable_compact` 3분할로 확장했다. 표면(CLI/Web/Tauri)이 "어떤 종류의
내부 turn이 거부했는가"를 즉시 알 수 있어 UX/telemetry 신호가 더 풍부하다.
원래 enum 총량(8)은 보존된다 — `standalone_turn` 1개를 3개로 쪼개고,
중복되던 `interrupted`+`empty_input`+`input_too_large`+`no_active_turn`+
`expected_turn_mismatch`가 그대로 5개.

## Integration seam (구현 X — 후속 PR)

본 슬라이스는 `turn-kind.ts` + `steering.ts` + 단위 테스트 + ADR만
포함한다. `src/agent/loop.ts` / `dispatch.ts` / `mode.ts`는 **본 PR에서
수정하지 않는다**. 다음 PR에서 아래 위치에 결선한다:

- **파일**: `src/agent/loop.ts` (현 940 LOC 전후).
- **Turn header 생성 지점**: `runAgent()`의 main turn loop —
  `for (let turn = 1; turn <= cfg.maxTurns; turn++)` 블록 진입 직후
  (현 1015-1027행 부근). `stream.emit({type:"turn_start", turn})` 직전에
  `const header = makeTurnHeader({turnId: ULID(), kind: "main", startedAt:
  caller-clock, threadId: cfg.sessionId ?? "default"})`를 만들어 turn-
  scoped state로 보관한다. Compaction/verifier 같은 내부 turn은 별도
  진입점에서 `kind: "compact"` / `"review"`로 생성한다.
- **Active turn state 노출**: `runAgent` scope 안에서 `let currentTurn:
  TurnHeader | null = null` + `let isInterrupted = false`를 유지하고,
  CLI/Web/Tauri surface가 외부에서 읽을 수 있는 read-only snapshot 메서드
  (`getActiveTurnSnapshot(): ActiveTurnState`)를 노출한다. 위치는
  `runAgent` 반환 시점이 아니라 turn-진행 중에도 호출 가능해야 하므로
  `AgentConfig`에 `activeTurnRef?: { current: ActiveTurnState }`를
  추가하는 형태(주입형 ref)가 byte-identical OFF 경로를 보장한다 —
  주입이 없으면 호출자가 steer를 발행할 채널이 없으므로 본 슬라이스의
  zero-impact 보장이 유지된다.
- **Steer 호출 지점**: surface 측 (CLI input REPL / Web WS handler /
  Tauri IPC). 사용자가 turn 도중 메시지를 입력하면 surface가
  `steer(request, state, config)`를 호출하고 결과에 따라:
  - `accepted` → `injection`을 `Message`(`role:"user", content: [{type:
    "text", text: injection.content}]`)로 변환해 working memory에 push.
    다음 LLM call **전에** push 완료가 강제되어야 하므로(`prepareTurnContext`
    가 working memory snapshot을 찍는 시점 이전), 동기 mutex 또는
    barrier가 필요하다.
  - `rejected` → trajectory `recovery` 이벤트 발행 (reason 포함). 진행
    중인 turn은 그대로 둔다.
- **Interrupted bit 결선**: `config.signal.aborted === true`가 되는
  순간 `isInterrupted = true`로 셋. 기존 abort 경로(현 loop 1059행
  `if (result.kind === "aborted") return finish("aborted", turn - 1)`)는
  byte-identical로 유지된다 — `isInterrupted`는 steer의 입력일 뿐
  loop control flow를 바꾸지 않는다.
- **NonSteerableTurnKind 후속 결선**:
  - Reactive compaction (`reactiveCompact`) 호출 직전에 `kind:"compact"`
    sub-header를 push, 호출 직후 pop.
  - ADR-0029 reviewer 결선 시 guardian subagent invocation에 `kind:
    "standalone"` 적용.
  - Verifier/closeout reminder는 별도 PR에서 `kind:"review"` 결선 검토.

위 결선 지점들은 본 ADR과 동일 wave의 후속 PR에서 처리한다. 본 PR은
모듈 + 테스트 + ADR만 포함하며, 기존 테스트 슈트는 byte-identical로
통과한다.

## Migration

기존 호출자에게는 변경 없음. surface가 `steer()`를 호출하지 않고
`activeTurnRef`를 주입하지 않는 한, loop와 dispatch는 byte-identical하게
동작한다 (ADR-0023의 §1.2 default-OFF 보존 원칙 준수).
