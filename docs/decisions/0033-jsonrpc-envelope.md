# ADR-0033: JSON-RPC 2.0 envelope + 명시적 -timeout 채널 + version lockstep

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: RFC-0001 §3.1(슬라이스 격리), ADR-0023(byte-identical replay), Codex `codex-jsonrpc-protocol-pattern` 메모(19 methods + 18 events)

## 맥락

`src/mcp/jsonrpc.ts`와 `src/lsp/adapters/jsonrpc.ts`는 각자 ad-hoc JSON
직렬화로 JSON-RPC frame을 다루었다 — 두 곳에 거의 동일한 encode/decode 코드가
중복되었고, error code -32700/-32600/-32603은 매직 넘버였으며, request id
correlation이 `Math.random()` 또는 `Date.now()` 베이스라서 ADR-0023의
"byte-identical replayable trace" 불변식과 충돌했다.

Codex의 JSON-RPC 패턴은 두 가지 차별점을 강제한다:
1. 모든 비동기 method가 `{name}-request / {name}-response / {name}-timeout`
   세 채널 triplet으로 구성되어 timeout이 일반 error response와 구분됨
   (error code -32000 + `data.kind === "timeout"`).
2. envelope 버전(`jsonrpc: "2.0"` literal)이 peer 간 lockstep — version drift
   는 fail-loud (downstream 모든 frame 폐기, peer 재연결 알림).

mcp/lsp 적용은 in-flight (main에 동시에 수정 중)이므로, **본 ADR은 standalone
`@/shared/jsonrpc` 모듈만 ship한다**. mcp/lsp 통합은 별도 후속 ADR에서 한 번에
diff한다 (in-flight 코드를 건드리지 않기 위함).

## 결정

### Part A — standalone envelope 모듈

`src/shared/jsonrpc/`에 5개 파일 신설:

- **`envelope.ts`**: Zod schema `JsonRpcRequest / Response / Notification /
  ErrorResponse / TimeoutResponse`. spec §4 강제 (`id` is string|number|null,
  object/array 거부; notification은 `id` 부재; response는 `result` XOR `error`).
- **`codec.ts`**: `encode*` 함수는 spec 위반 시 programmer error로 throw,
  `decode*` 함수는 **NEVER throw** — `Result<T, JsonRpcCodecError>` 반환.
  bad-JSON / version-mismatch / shape-mismatch 분리 (`kind` 식별자).
- **`correlation.ts`**: `RequestId` brand + `createRequestIdGenerator(seed)`
  결정론적 monotonic counter. `nextRequestId()`는 process-wide default
  (seed=1, MAX_SAFE_INTEGER 도달 시 RangeError throw — wrap-around 금지).
- **`channel-naming.ts`**: `channelTriple(name)` → `{ request, response,
  timeout }` 3-tuple 생성. 이미 suffix가 붙은 이름은 거부 (`foo-request`를
  다시 wrap 방지). `parseChannelKind(channel)` round-trip 지원.
- **`index.ts`**: 공개 export.

### Part B — 명시적 -timeout 채널

timeout response는 error code -32000 (JSON-RPC spec §5.1 implementation-
defined server-error 범위의 시작점) + `error.data.kind === "timeout"`
로 인코딩. `decodeTimeout(input)`은 일반 error response를 거부하고 timeout만
허용 (시그널-노이즈 분리). `encodeTimeout({ id, elapsedMs })`는 항상 둘을
함께 채움.

### Part C — version lockstep

`JsonRpcRequestSchema` 등 모든 envelope schema가 `z.literal("2.0")` —
"2.0" 이외의 version은 `version_mismatch` 카테고리 에러로 분리 surface
되어 peer가 disconnect/log/drop 중 어느 정책을 적용할지 결정 가능.

### Part D — mcp/lsp 통합 deferral

`src/mcp/jsonrpc.ts`와 `src/lsp/adapters/jsonrpc.ts`는 main에 in-flight 변경
중. 본 worktree에서는 둘 다 touch하지 않으며, 통합은 향후 mcp/lsp 변경이
main으로 land된 후 단일 follow-up ADR에서 일괄 처리한다. 격리 위반 방지가
목적.

## 근거

- 모든 frame이 동일 표준(JSON-RPC 2.0) 위에서 movable → mcp/lsp/custom-bridge
  코드 중복 제거 (후속 ADR에서).
- `Result<T, E>` codec API → decode 실패가 silent하지 않고 caller가 명시적
  branch.
- deterministic monotonic id → ADR-0023 byte-identical trace replay 보존
  (테스트는 seed=1로 고정 → recorded vs replayed identical).
- channel triple 강제 → timeout이 일반 error로 sneak in 불가, observability
  pipeline이 `parseChannelKind`만으로 timeout 분류 가능.

## 대안

- **mcp/lsp를 본 ADR에서 동시 마이그레이션**: 기각 — main의 in-flight 변경과
  충돌, worktree merge 시 conflict 폭증.
- **brand 없는 `number` id**: 기각 — call site에서 raw `number`와 혼동
  가능, ADR-0023 invariant 추적 어려움.
- **timeout을 별도 channel(노트) 없이 generic error**: 기각 — observability
  pipeline에서 timeout vs application-error 분리가 매번 magic string check
  필요, Codex 패턴 분리 strength 손실.

## 결과·트레이드오프

- **얻은 것**: standalone 모듈 5 파일 / Zod-validated envelope / 69
  결정론적 단위테스트 (envelope-21 + codec-15 + correlation-13 + channel-9
  + ack 11). slice 격리 유지 (`@/shared/jsonrpc`는 zod와 `@/shared/types`만
  import).
- **비용**: standalone 단계에서 mcp/lsp는 여전히 ad-hoc — 통합 후속 ADR
  필요. zod runtime validation overhead (cold path; 모든 frame validation 시
  ~수μs 추가, 무시 가능).

## 한계 (LIMITATIONS)

- **(a) mcp/lsp 미통합**: 본 ADR가 만든 모듈은 아직 wire에 연결되지 않음.
  후속 ADR이 land될 때까지 mcp/lsp는 여전히 ad-hoc encode/decode.
- **(b) batch request 미지원**: JSON-RPC 2.0 §6의 batch request 배열 형식은
  현재 v3 어디서도 사용하지 않으므로 명시적으로 schema에 포함하지 않음.
  필요 시 별도 schema (`JsonRpcBatchRequestSchema`) 추가.
- **(c) custom JSON serialiser 없음**: spec은 canonical 키 ordering을 요구
  하지 않음 (peer 호환성 우선) — `JSON.stringify`의 insertion-order를
  그대로 사용. byte-identical replay 의존성이 있는 곳은 session-jsonl
  envelope(ADR-0031)의 canonical 인코딩을 사용해야 함.

## 불변식 영향

- **슬라이스 격리 유지**: `@/shared/jsonrpc`는 `zod` + `@/shared/types`만
  의존. 다른 slice에서 import 자유 (Biome `noRestrictedImports`가 `@/shared`
  를 제약하지 않음).
- **RFC/ADR 동기**: 후속 mcp/lsp 통합 ADR이 land될 때 본 ADR cross-link
  추가 필요.
- **신규 npm dep 0**.
- **byte-identical replay (ADR-0023)**: `createRequestIdGenerator(seed)`로
  test에서 id 결정론성 보장.
