# ADR-0034: Session JSONL envelope (5 top-level types + 17 turn_context fields + v3 subagent linkage)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0015(Codex foundation turn_context), ADR-0023(byte-identical replay), `codex-session-jsonl-envelope` 메모, `subagent-sota-hardening` 메모

## 맥락

v3의 기존 session 영속화는 `src/session/store.ts`의 snapshot 모델 — 매 save가
`<id>.json`을 통째로 rewrite한다. 이 모델은 resume에는 충분하지만 두 가지
한계가 있다:

1. **replay 불가**: snapshot은 "마지막 상태"만 보존하므로 turn-by-turn
   재실행 (`bench --replay`, `probe --trajectory`)이 불가능. Codex는 같은
   목적으로 append-only JSONL을 별도 rail로 운영한다.
2. **subagent 계보 누락**: subagent thread가 fork되어도 snapshot 어디에도
   parent/child 관계가 기록되지 않음. `subagent-sota-hardening` 라운드에서
   `taskKind/resultShape/ownedSurfaces` 등을 강화했지만, 영속 layer에
   thread 계보가 빠진 상태였다.

Codex의 session JSONL envelope을 흡수하되 v3 고유 요건(subagent linkage)을
2 필드 더해 확장한다. snapshot rail은 그대로 두고 JSONL rail은 **add-only
seam**으로 store.ts에 한 줄 추가.

## 결정

### Part A — 5 top-level record types

`src/session/envelope.ts`에 Zod discriminated-union `SessionEnvelopeRecord`:

1. **`session_meta`** (1회/세션): `session_id, started_at, cwd,
   cli_version, model`
2. **`turn_context`** (매 턴 시작): 17 Codex 필드 + 2 v3 필드 (아래 Part B)
3. **`event_msg`** (옵저버빌리티): nested discriminated-union on `kind`:
   `task_started / user_message / token_count / turn_aborted /
   tool_invoke / tool_result / custom`. `custom`은 `custom_kind: string`
   강제 — 오타가 silent하게 들어가지 못함.
4. **`response_item`** (모델 출력 캡처): `item_kind ∈ {assistant_text,
   assistant_tool_use, assistant_reasoning}` + `index, content`.
5. **`thread_spawn`** (v3 신설): `parent_session_id, parent_turn_id,
   child_session_id, child_task_kind, spawned_at` — subagent 계보.

모든 object는 `.strict()` — 미지의 키는 hard-reject.

### Part B — `turn_context`의 17 + 2 필드

Codex 17:
`turn_id / cwd / current_date / timezone / approval_policy /
sandbox_policy / permission_profile / model / personality /
collaboration_mode / realtime_active / effort / summary /
user_instructions / truncation_policy`

v3 확장 2:
- **`parent_thread_id: string | null`** — root thread는 `null`, subagent는
  spawn한 부모의 `turn_id` 참조.
- **`thread_role: "root" | "subagent"`** — root와 subagent의 prompt 분기
  (subagent SOTA: ownedSurfaces / forbiddenSurfaces)에 사용.

각 enum (approval/sandbox/permission/collab/effort/truncation/role)은 Zod
`z.enum`으로 폐쇄 — 신규 값은 schema 변경 필요 (silent drift 금지).

### Part C — encoder/decoder/iterator

`src/session/envelope-encoder.ts`:

- **`encodeSessionLine(record)`**: canonical JSON (alphabetically-sorted
  keys at every depth) + 정확히 1 LF 종결. ADR-0023 byte-identical 보존.
- **`decodeSessionLine(line)`**: BOM strip, CR strip, NEVER throws —
  `Result<Record, EnvelopeDecodeError>` (kind: `parse_json | schema |
  empty_line`).
- **`iterateSessionFile(path)`**: streaming async iterator. 빈 줄 무시,
  malformed line은 `Result<…>`로 surface (silent skip 없음) — caller가
  중단/로깅/skip 정책 결정. trailing-newline 없는 마지막 줄도 yield.
- **`appendSessionLine(path, encoded)`**: POSIX `O_APPEND` open — 다중
  process append가 interleave되지 않음.

### Part D — store.ts add-only seam

`src/session/store.ts`에 한 줄짜리 함수만 추가:

```ts
export const appendEnvelope = async (
  sessionId: string,
  record: SessionEnvelopeRecord,
): Promise<void> => {
  await appendSessionLine(sessionEnvelopePath(sessionId), encodeSessionLine(record))
}
```

snapshot 함수 (saveSessionById / loadSessionById / archiveSession /
forkSession 등)는 **건드리지 않는다**. 새 envelope rail은 `<id>.jsonl`로
snapshot `<id>.json`과 path-disjoint.

## 근거

- **5 top-level types**: Codex가 검증한 분류. event_msg를 nested union으로
  유지해 discriminator dispatch 비용을 1 lookup으로 절감.
- **canonical encoding**: byte-identical replay (ADR-0023)는 record가 다른
  순서로 build되어도 동일 byte를 산출해야 함 → 알파벳 키 ordering 강제.
- **두 v3 필드만 추가**: subagent 계보가 필수. 셋 이상은 over-engineering.
- **add-only seam**: main의 in-flight store.ts 변경과 충돌 최소화. snapshot
  rail은 향후에도 그대로.

## 대안

- **snapshot rail로 흡수**: 기각 — snapshot은 mutable, replay 불가능 (전체
  state만 보존). append-only가 본질.
- **5 types를 모두 별개 schema**: 기각 — Zod discriminated-union으로 묶어
  top-level dispatch O(1).
- **canonical 키 ordering 안 함**: 기각 — replay 동일성 불가능.

## 결과·트레이드오프

- **얻은 것**: 5-type discriminated union schema / canonical encoder /
  streaming iterator / store.ts에 +1 함수 seam. **44 schema 테스트 + 13
  encoding 테스트 + 6 streaming 테스트 + 3 integration** = 66 신규 unit,
  3 integration tests. snapshot rail unchanged.
- **비용**: 두 rail 공존 (snapshot + JSONL). consumer가 어느 rail을 source-of-
  truth로 삼을지 결정해야 함 — 본 ADR은 둘 다 유지하고 consumer가
  resume=snapshot / replay=jsonl로 분기하는 정책을 권장 (구현은 후속).

## 한계 (LIMITATIONS)

- **(a) snapshot↔JSONL 자동 동기 없음**: appendEnvelope이 saveSessionById를
  호출하지 않으며 그 역도 아님. 두 rail을 모두 쓰려면 caller(현재는 미구현
  consumer)가 명시 호출.
- **(b) 17 Codex 필드 중 일부는 v3에서 placeholder**: `personality, summary,
  user_instructions` 등은 현재 빈 문자열을 기본값으로 — 후속 PR에서 채움.
- **(c) `iterateSessionFile`은 forward-only**: random access / reverse 순회
  필요 시 별도 indexing layer가 필요.

## 불변식 영향

- **슬라이스 격리 유지**: `@/session`은 `@/storage`와 `@/shared`만 import
  (Biome 강제). 추가 envelope/encoder 모두 같은 제약 준수.
- **RFC/ADR 동기**: ADR-0023(byte-identical)와 본 ADR이 canonical encoding
  으로 align.
- **신규 npm dep 0**.
- **subagent SOTA(`subagent-sota-hardening`)와 정합**: thread_spawn record가
  taskKind/parent linkage를 영속 layer에 노출.
