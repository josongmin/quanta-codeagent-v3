---
instance_id: matplotlib__matplotlib-25332
repo: matplotlib/matplotlib
base_commit: 66ba515e671638971bd11a34cff12c107a437e0b
version: "3.7"
difficulty: "<15 min fix"
created_at: 2023-02-26T11:18:40Z
fail_to_pass: 1
pass_to_pass: 181
gold_files: [lib/matplotlib/cbook.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`fig.align_labels()`(또는 `align_ylabels`)를 호출한 뒤 figure를 `pickle.dumps()`하면 `TypeError: cannot pickle 'weakref.ReferenceType' object`가 발생한다. align 호출이 내부적으로 `Grouper`(라벨 그룹 관리용)를 채우는데, 이 `Grouper`의 `_mapping`이 `weakref.ref` 객체를 dict 키/값으로 보관하므로 pickle이 불가능하다. align을 호출하지 않으면 pickle은 정상 동작한다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `Grouper` 심볼을 직접 지목하진 않지만, "weakref + pickle + align_labels" 키워드 체인이 좁은 후보로 수렴한다. `align_labels` → `Figure._align_label_groups` → `cbook.Grouper`까지 한 단계 추적이 필요해 L0는 아니다. gold는 단일 파일(`cbook.py`).
- **S2 (+S6)**: 고칠 지점(`Grouper`)을 찾으면, 픽스는 "weakref ↔ strong ref 변환"이라는 **불변식 추론**으로 합성된다. 임의 후보를 테스트로 거르는 G&V가 아니라, pickle 라이프사이클(직렬화 시 strong으로 풀고, 복원 시 weak으로 되감기)을 정확히 따져서 `__getstate__`/`__setstate__` 한 쌍을 도입하는 **소규모 구조 추가**(S6 보조)다.
- **K-Domain**: 일반 파이썬 추론만으론 부족하다. matplotlib의 `Grouper` 약참조 자료구조 의미 + CPython pickle 프로토콜(`__getstate__`/`__setstate__` 계약)을 알아야 올바른 변환을 쓸 수 있다.
- **primary = T-DomainBound**: 병목이 "어디"가 아니라 weakref/pickle 도메인 계약 지식이다. 위치는 한 번의 추적으로 잡히지만, 픽스의 정확성은 약참조-직렬화 도메인 이해에 달려 있다.

이 repair strategy인 이유(APR 관점): 결함이 "값이 틀림"이 아니라 "객체가 직렬화 불가능"한 **타입/라이프사이클 결함**이라, 조건 한 줄 추가(S1)로는 못 푼다. pickle 계약을 만족하는 상태 변환 메서드 쌍을 추론으로 합성해야 하므로 SemFix/Angelix류 semantic 수리(S2)에 가깝고, 메서드 두 개를 새로 도입하는 구조 변경이라 S6가 보조로 붙는다.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 1개·실질 추가 13줄(헌크 1개) → scope는 작다(T1~T2 영역).
- localize는 L1(한 단계 추적)로 가볍다.
- `has-repro`: 최소 재현 코드 + 정확한 예외 메시지 존재 → 강한 easiness 신호.
- 그러나 픽스 정확성이 **도메인 지식(weakref↔pickle 계약)**에 걸려 있어 단순 T1/T2를 넘는다. `__setstate__`에서 weak으로 되감지 않으면 복원된 객체가 `clean()`/`__contains__` 등에서 `weakref.ref(item) in self._mapping` 비교가 깨진다.
- P2P 173개로 넓지만 대부분 `test_cmap` 파라미터라 실 인접면은 좁다 → regression-trap은 중간 수준.

공식 라벨은 `<15 min fix`(T1~T2 prior). 개발자에겐 패턴을 알면 15분이지만, 에이전트 관점에서 정답은 "함수에 가드 추가"가 아니라 "pickle 프로토콜 메서드 쌍을 도메인 계약대로 합성"이라 추론 비용이 한 단계 더 든다. 그래서 prior보다 한 티어 올린 T3.

## 골드패치 분석
- **파일·심볼**: `lib/matplotlib/cbook.py`의 `Grouper` 클래스에 `__getstate__`/`__setstate__` 두 메서드를 신규 추가.
- **근본원인**: `Grouper.__init__`이 `self._mapping = {weakref.ref(x): [weakref.ref(x)] ...}`로 dict 전체를 `weakref.ref` 객체로 채운다. `weakref.ReferenceType`은 pickle 불가능하다. `align_labels`가 `Figure._align_label_groups`(Grouper들)를 비우지 않은 채 채우므로 figure 그래프를 타고 직렬화하다 이 `_mapping`에서 터진다.
- **수정요지**:
  - `__getstate__`: `vars(self)`를 복사하되 `_mapping`만 약참조를 **strong ref로 역참조**(`{k(): [v() for v in vs] ...}`)해 picklable한 형태로 내보낸다.
  - `__setstate__`: 복원 시 strong ref를 다시 `weakref.ref`로 **되감아** 원래 약참조 불변식을 복구(`{weakref.ref(k): [*map(weakref.ref, vs)] ...}`).

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_pickle.py::test_complete[png]`. test_patch는 `_generate_complete_test_figure`에 `plt.ylabel("hello")`, 멀티라인 `ylabel`, 그리고 결정적으로 `fig_ref.align_ylabels()`를 추가한다(주석: "Test handling of _align_label_groups Groupers"). align 호출로 `Grouper._mapping`이 weakref로 채워진 상태에서 figure 전체를 pickle round-trip(`check_figures_equal`)하므로, 픽스 전이면 `cannot pickle weakref` 예외로 실패한다.
- **픽스 증명**: `__getstate__`가 직렬화 시 weak→strong 변환을 수행해 pickle 통과, `__setstate__`가 복원 후 weak으로 되돌려 동일 figure를 재구성 → round-trip 비교 통과.
- **overfit 관점**: 테스트는 단 1개지만, 픽스가 special-case(예: align된 figure만 우회)가 아니라 `Grouper` 자료구조 차원의 일반 직렬화 계약이라 overfit 위험은 낮다. 다만 테스트가 "값 동일성"까지 강하게 보진 않아(round-trip 성공 위주), 복원된 그룹 멤버십이 보존되는지는 약하게만 커버된다.
- **regression 관점**: P2P 173개(`test_simple`/`test_gcf`/`test_shared`/대량 `test_cmap` 등)는 align 없는 일반 pickle 경로. `__getstate__`가 `**vars(self)`로 나머지 상태를 그대로 보존하므로 비-align figure의 직렬화는 영향 없음.

## 모범답안 (오라클 기반)
1. **localize 경로**: 예외 메시지 `cannot pickle 'weakref.ReferenceType'` + "align_labels 호출 시에만 발생"이 핵심 단서. `align_labels`/`align_ylabels` → `Figure._align_label_groups`가 `cbook.Grouper` 인스턴스를 보유함을 따라가, `Grouper._mapping`이 `weakref.ref` 키/값으로 채워지는 `__init__`을 지목한다(L1, 한 단계 추적).
2. **픽스와 일반화 근거**: `Grouper`에 pickle 프로토콜 훅 `__getstate__`/`__setstate__`를 추가해, 직렬화 경계에서만 weak↔strong을 변환한다. 약참조를 strong으로 바꿔 picklable하게 만들고 복원 시 weak으로 되감는 것은 "약참조를 보유한 컨테이너를 직렬화하는" 표준 패턴이라, align 케이스에 국한되지 않는 올바른 일반화다(`Grouper`를 쓰는 모든 pickle 경로를 덮음).
3. **regression 안전**: `__getstate__`는 `**vars(self)`로 `_mapping` 외 상태를 보존하고, `_mapping` 변환은 직렬화 시점에만 일어나 in-memory 동작(`join`/`joined`/`clean`/`__contains__`)은 불변. 따라서 align 없는 173개 P2P(특히 대량 `test_cmap`/`test_shared`)는 안 깨진다.
4. **함정 회피**:
   - **얕은 우회 유혹**: `align_labels`에서 Grouper를 비우거나 weakref를 무시하는 식으로 "align만 pickle 가능"하게 만들면 align 정보가 손실되고 다른 Grouper 사용처를 못 덮는다 → overfit. 정답은 자료구조 레벨 직렬화 계약.
   - **`__setstate__` 누락**: `__getstate__`만 추가하면 pickle은 통과하지만 복원된 `_mapping`이 strong ref로 남아 `weakref.ref(item) in self._mapping` 비교(`__contains__`)·`clean()`이 깨진다 → 반드시 쌍으로 되감아야 함.
   - **dead ref 처리**: 직렬화 시 이미 죽은 약참조(`k()` is None)는 strong으로 풀면 None이 섞일 수 있으나, gold는 단순 역참조만 한다(테스트 범위 내 살아있는 ref 가정). 과도하게 None 필터를 넣어 의미를 바꾸면 골드와 동치성이 어긋날 수 있으니 최소 변환에 머무는 것이 안전.
