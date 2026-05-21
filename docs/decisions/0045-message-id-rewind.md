# ADR-0045 — Message-id rewind (Claude Desktop 1.7196.3 parity)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: [[claude-desktop-1-7196-catalog]] (rewind UX 단편),
  ADR-0034 (JSONL envelope), `src/session/store.ts` `forkSession`

## 맥락

Claude Desktop 1.7196.3은 transcript 안의 **message 단위 rewind** UX를
제공한다 — 사용자가 임의 시점의 메시지를 선택하면 그 이후 모든
message가 truncate되고, 그 지점에서 다시 입력하거나 fork할 수 있다.

v3의 기존 `forkSession`은 풀 세션 복사만 지원했고, transcript 단위
편집은 없었다. message에 식별자도 없었기 때문에 "이 메시지 이후를
잘라달라" 같은 명령을 표현할 방법 자체가 없었다.

## 결정

1. **`Message.id?: string`** opt-in 필드를 `src/llm/types.ts`에 추가.
   - **byte-identical default-OFF**: 기존 세션 파일은 `id` 없이 그대로
     load/save된다. 신규 세션도 `assignMessageIds`를 통과시키기
     전까지는 id를 갖지 않는다.
   - zod schema (`store.ts:messageSchema`)도 동일하게 `id` 를 optional
     으로 받는다 — 강한 검증은 유지하되 absent를 reject 하지 않는다.

2. **`assignMessageIds(messages, idFor?)`** 헬퍼 (in `src/session/store.ts`):
   - 새 array를 반환 (input 불변).
   - 기존 `id`는 byte-identical 보존; 없는 것만 `crypto.randomUUID()`로
     민트 (혹은 `idFor(index)` override — 결정성 테스트용).

3. **`rewindToMessage(sessionId, msgId): { removed }`** (in
   `src/session/store.ts`):
   - transcript에서 `msgId`를 찾아 그 message **자체는 보존**하고
     이후를 전부 제거 (Claude Desktop 시맨틱: "checkpoint TO, not past").
   - missing session / empty transcript / unknown msgId / msgId가 이미
     마지막인 경우 → 모두 `removed: 0` no-op. 예외 발생하지 않음.
   - 별도 함수로 분리. `forkSession`은 그대로 — rewind + fork 결합은
     CLI/UX layer에서 수행.

4. **JSONL envelope 처리 (phase-A scope)**: rewind는 **snapshot JSON만**
   truncate한다. ADR-0034 envelope log는 append-only 불변을 유지하며
   touch하지 않는다. 외부 replay 도구는 post-rewind snapshot과
   교집합을 취해 reconcile한다. 명시적 envelope truncation seam은
   구체적 consumer 요구가 나오면 phase-B에서 추가.

5. **CLI 노출**: `quanta session rewind <id> <msg-id>` subcommand 추가
   (`src/apps/cli/session-commands.ts`). entry point (`cli/index.ts`)
   변경은 0 — dispatcher가 sub 이름으로 분기한다.

## 결과 / 시험

- `tests/unit/session/rewind.test.ts` — 9 케이스, 26 expect (id mint /
  preserve / immutability / empty / truncate / no-op).
- `tests/integration/session-rewind-e2e.test.ts` — 3 케이스, 15 expect
  (5-msg round-trip, envelope-untouched, legacy-noid byte-identical).
- typecheck / lint / 전 unit suite 통과.

## negative space

- envelope log truncation 없음 → 자동 replay tool은 post-rewind
  snapshot 우선 정책을 알아야 한다 (현재 v3의 resume path는 snapshot
  load만 사용하므로 mismatch 없음).
- `assignMessageIds`는 기존 세션을 자동 변환하지 않는다 — caller가
  명시적으로 통과시켜야 id가 붙는다.
