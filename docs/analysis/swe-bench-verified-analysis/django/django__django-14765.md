---
instance_id: django__django-14765
repo: django/django
base_commit: 4e8121e8e42a24acc3565851c9ef50ca8322b15c
version: "4.0"
difficulty: <15 min fix
created_at: 2021-08-12T05:59:11Z
fail_to_pass: 1
pass_to_pass: 64
gold_files: [django/db/migrations/state.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S5)
knowledge: K-API
flags: [regression-trap]
---

# django__django-14765

## 문제 요약
선행 PR #14760으로 `ProjectState.__init__()`를 호출하는 모든 코드가 `real_apps`를 이미 set으로 전달하도록 정리됐다. 따라서 생성자 안에서 set 여부를 검사하고 아니면 `set(real_apps)`로 변환하던 방어 로직은 더 이상 필요 없다. 대신 non-None일 때 set임을 단언(`assert`)하도록 바꿔, ProjectState 생성이 Django 내부 API라는 계약을 코드로 명시하자는 리팩터링 요청이다. 기능 버그가 아니라 "느슨한 계약을 엄격한 불변식으로 조이는" 의도적 강화다.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed).** problem_statement가 `ProjectState.__init__()`를 함수명으로 직접 지목하고, PR #14760(real_apps를 set으로 통일)을 인과 근거로 명시한다. `django/db/migrations/state.py`에서 `real_apps` 분기만 보면 끝 — grep 한 방, 탐색 노력 0.
- **S (Repair Strategy) = S1 (Direct-Map) (+S5 보조).** 이슈가 사실상 픽스를 명세한다("checking and converting it can just assert that it's a set when non-None"). 정형 결함클래스(타입강제/입력계약)에 기계적으로 매칭 — 변환 제거 + `assert isinstance(real_apps, set)` 추가. APR 관점에서 PAR/TBar류 템플릿("validate-instead-of-coerce")이 그대로 적용된다. 보조로 S5(Spec-Inference)가 약하게 섞이는 이유: "이게 버그 수정이 아니라 더 엄격하게 만드는 게 의도"라는 스펙을 이슈 본문에서 재구성해야 방향을 정렬할 수 있다(코드만 보면 "관대하게 받아주는" 기존 동작이 정상으로 보임).
- **K (Knowledge) = K-API (API-contract).** "construction of new ProjectState objects is part of Django's internal API"라는 하위호환/공개성 판단이 핵심이다. 일반 파이썬 추론(K-Gen)으로도 변환→단언 치환은 가능하지만, "내부 API라 입력 계약을 좁혀도 외부 호환을 안 깬다"는 판단은 API 계약 지식이다. migrations 내부 ORM 로직을 깊게 알 필요는 없어 K-Domain까지는 아니다.

**primary type = T-DirectMap 근거:** 위치가 명확(L0)하고 픽스가 기계적 타입강제(S1)다. 추론으로 식을 합성(T-ConstraintReason)할 필요도, localize가 어렵지(T-DiffuseLoc)도 않다. S5가 섞이지만 dominant는 "이슈가 적어준 픽스를 그대로 매핑"이라 T-DirectMap.

## 난이도 티어

**Tier = T2 (쉬움).** 공식 라벨은 `<15 min fix`(최저 시간대, T1 prior에 해당)다. 한 단계 올려 T2로 두는 구조적 근거:

- **파일/줄수:** 1파일·`ProjectState.__init__` 한 함수·실질 5줄 변경 → T1~T2 구간.
- **localize 직접성:** L0, 이슈가 함수를 지목 → 난이도 하향 요인.
- **repro 없음:** has-repro 플래그 없음. 네이티브 스택트레이스/재현코드가 없고, "버그를 재현"하는 게 아니라 "정책을 바꾸는" 작업이라 가장 강한 easiness 신호(repro≈87% solve)가 빠진다.
- **P2P trap:** PASS_TO_PASS 64개로 넓다(`regression-trap`). `ProjectState`는 migration state 구성의 핵심 생성자라 set/None 정상 경로를 깨면 다수 RelatedModelsTests/StateTests가 연쇄로 깨진다. 변환을 너무 공격적으로 들어내(예: None 처리 누락) 빈 set 경계에서 어긋나면 광범위 회귀.
- **의도 역전 함정:** 에이전트의 디폴트 습관(입력을 관대하게 받기)과 정답(엄격히 거부)이 정반대 — T1의 "이슈가 픽스를 거의 적어줌"보단 한 끗 미묘하다.

공식 `<15 min`(T1 prior)과 다르게 T2로 올린 이유: 시간라벨은 "개발자 구현시간"만 잡고, repro 부재 + 넓은 P2P regression-trap + 의도 역전이라는 에이전트 난이도 요인을 반영하지 못한다. 다만 L0·S1·1함수라 T3 이상은 과대평가.

## 골드패치 분석

- **건드린 파일/함수:** `django/db/migrations/state.py` → `ProjectState.__init__(self, models=None, real_apps=None)`
- **근본 원인:** 기존 코드는
  ```python
  if real_apps:
      self.real_apps = real_apps if isinstance(real_apps, set) else set(real_apps)
  else:
      self.real_apps = set()
  ```
  처럼 `real_apps`가 set이 아니면 `set(real_apps)`로 변환해 받아줬다. PR #14760으로 모든 호출부가 set을 넘기게 정리된 뒤에도 이 변환이 남아, 비-set 입력(list 등)을 silent하게 허용하는 느슨한 계약이 유지됐다. 또한 `if real_apps:`는 falsy 분기라 빈 컬렉션과 None을 같은 줄로 처리해 의미가 흐릿했다.
- **수정 요지:** 분기를 다음으로 치환.
  ```python
  if real_apps is None:
      real_apps = set()
  else:
      assert isinstance(real_apps, set)
  self.real_apps = real_apps
  ```
  None이면 빈 set, non-None이면 set임을 `assert`로 단언하고 그대로 할당. 변환 로직 제거로 비-set 입력은 `AssertionError`로 즉시 실패한다. `if real_apps:`(falsy) → `if real_apps is None:`(identity)로 바꿔 "None이냐"와 "비었냐"의 의미를 분리하고, 이미 set으로 넘어온 빈 set/non-empty set을 동일하게 통과시킨다.

## 검증 (test_patch)

- **FAIL_TO_PASS (1):** `test_real_apps_non_set (migrations.test_state.StateTests)`
- **동작:** 신규 테스트가 `ProjectState(real_apps=['contenttypes'])`(list = 비-set)를 넘기면 `AssertionError`가 나는지 `assertRaises`로 확인.
- **픽스 증명:** 픽스 전에는 list가 `set(real_apps)`로 변환돼 예외 없이 통과 → `assertRaises(AssertionError)` 컨텍스트가 잡을 예외가 없어 테스트 FAIL. 픽스 후 `else: assert isinstance(real_apps, set)`이 list를 거부 → `AssertionError` 발생 → 테스트 PASS. 즉 테스트는 "변환이 사라지고 단언이 들어왔다"는 정확히 그 동작 변화를 관찰한다.
- **overfit 관점:** FAIL_TO_PASS가 1개로 얇아 표면상 special-case로도 통과할 여지가 있어 보이나, 픽스 자체가 5줄짜리 타입강제라 일반화 공간이 거의 없다. `assert isinstance(x, set)`는 list/tuple/dict/frozenset 등 모든 비-set을 균일하게 거부하므로 `['contenttypes']` 단일 입력에 overfit되지 않는다(S1이라 CEGIS식 일반화 부담 없음). 그래서 `overfit-risk` 플래그는 미부여.
- **regression 관점:** PASS_TO_PASS 64개가 `regression-trap`. set/None 정상 경로(`ProjectState()`, `ProjectState(real_apps=set(...))`)가 깨지면 RelatedModelsTests 27개, StateTests/ModelStateTests 다수가 연쇄 실패한다. 골드패치는 set·None 경로를 그대로 보존(빈 set→그대로, None→빈 set)하므로 64개 전부 green 유지.

## 모범답안 (오라클 기반)

1. **localize 경로:** 이슈가 `ProjectState.__init__()`를 함수명으로 직접 적고 PR #14760을 인과로 인용 → 키워드 `ProjectState`로 `django/db/migrations/state.py`의 `__init__`를 즉시 연다. `real_apps` 처리 분기(`if real_apps:` ~ `set(real_apps)`)가 유일한 타깃. 호출부 탐색 불필요(#14760이 이미 set 통일을 끝냄 — 이걸 이슈가 명시).

2. **픽스와 일반화 근거:** 변환(`set(real_apps)`)을 제거하고 `else: assert isinstance(real_apps, set)`로 치환, None은 `is None`으로 분리해 빈 set 시드. 이게 올바른 일반화인 이유: 이슈가 요구하는 계약은 "non-None real_apps는 항상 set"이라는 불변식이고, `isinstance(x, set)` 단언은 단일 테스트 입력(list)이 아니라 비-set 타입 전체를 균일하게 거부한다. 변환을 남기면(관대한 처리) 테스트가 기대하는 `AssertionError`가 안 나 FAIL — 즉 정답은 "엄격화"이지 "방어"가 아니다.

3. **regression 안전:** 안 깨야 할 핵심 P2P는 set/None 정상 생성 경로다 — "Tests making a ProjectState from an Apps", RelatedModelsTests 전 27케이스, `test_dangling_references_throw_error`, "Including real apps can resolve dangling FK errors." 등. 이들은 `real_apps`로 set 또는 None을 넘기므로, None→빈 set·set→그대로 통과를 보존해야 한다. 골드패치는 두 정상 경로를 동치로 유지하므로 안전. 빈 set을 falsy로 흘려보내던 `if real_apps:`의 미묘함을 `is None`으로 고친 것도 빈 set 입력을 set 경로로 정확히 보내 회귀를 막는다.

4. **함정 회피:** 오라클 없는 에이전트의 가장 큰 오답은 **의도 역전** — "비-set 입력도 받아주게 더 견고히 만들자"며 변환을 유지하거나 강화하는 것(LLM의 관대한-입력 습관). 이러면 `assertRaises(AssertionError)`가 영영 실패한다. 이를 피하려면 test_patch가 `AssertionError`를 **기대**한다는 신호를 먼저 읽어 "엄격화가 목표"임을 확정해야 한다. 둘째 함정은 None 처리 누락 — `else`만 assert로 바꾸고 None 분기를 빠뜨리면 `ProjectState()`(기본값)에서 터져 64개 P2P가 무너진다. 셋째는 `if real_apps:`를 그대로 두는 것 — 빈 set이 falsy라 단언 분기를 건너뛰어 의미가 어긋날 수 있으니 `is None`으로 바꿔야 한다.
