---
instance_id: django__django-11880
repo: django/django
base_commit: 06909fe084f87a65459a83bd69d7cdbe4fce9a7c
version: 3.1
difficulty: <15 min fix
created_at: 2019-10-07T19:10:59Z
fail_to_pass: 1
pass_to_pass: 114
gold_files: [django/forms/fields.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

# django__django-11880

## 문제 요약
Form `Field`의 `__deepcopy__`가 `error_messages` 딕셔너리를 (deep)copy하지 않아서, 같은 필드 인스턴스를 deepcopy한 모든 복사본이 동일한 `error_messages` dict 객체를 공유한다. `BaseForm.__init__`가 `copy.deepcopy(self.base_fields)`로 폼별 필드 집합을 격리("sealed")한다고 기대하지만, 실제로는 모든 인스턴스가 같은 error_messages dict를 가리키므로, 한 폼 인스턴스에서 에러 메시지를 동적으로 바꾸면 동일 폼 클래스의 다른 모든 인스턴스에 그 변경이 누수되어 잘못된 에러가 발생한다. problem_statement이 파일/라인/메서드(`django/forms/fields.py` L200 `__deepcopy__`)를 직접 지목하고 hints에 PR과 repro 테스트가 첨부되어 있다. Django 1.11까지 거슬러 재현된다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)** — problem_statement이 GitHub permalink로 `django/forms/fields.py`의 `__deepcopy__`(L200)와 `error_messages` dict를 명시적으로 좌표 지목. grep 한 방, 탐색 노력 0. 직접성 최상.
- **S (Repair Strategy) = S1 Direct-Map (+S2 약하게)** — 정형 결함클래스 "deepcopy에서 mutable 속성 누락 공유(shared-mutable-default)"에 템플릿 매칭. 이미 같은 메서드 안에서 `result.widget = copy.deepcopy(...)`, `result.validators = self.validators[:]`로 mutable 속성을 인스턴스별 분리하는 패턴이 존재 → 누락된 한 속성(`error_messages`)을 같은 관용구로 채우면 끝(기계적). S2가 약하게 섞이는 이유: `deepcopy` vs `.copy()` 중 무엇이 올바른 깊이인지 1단계 추론이 필요(값이 lazy 문자열이라 1단계 copy로 충분, 재귀 deepcopy는 과교정).
- **K (Knowledge) = K-Gen** — 일반 파이썬의 `copy.copy`/얕은복사 의미론과 mutable dict 공유 함정만 알면 풀린다. forms 도메인 내부지식(검증 파이프라인/ORM)은 불필요. error_messages가 dict라는 것만 코드에서 즉시 확인 가능.
- **Primary = T-DirectMap** — 위치가 명확(L0)하고 픽스가 기계적 S1(누락된 mutable 분리 한 줄 추가). 기존 형제 라인(`validators[:]`, `widget` deepcopy)이 템플릿을 직접 제공하므로 "추론 합성(T-ConstraintReason)"이 아니라 "직접 매핑". APR 관점: PAR/TBar류의 fix-pattern(add-missing-copy)으로 정확히 커버되는 케이스.

## 난이도 티어
**T2 (쉬움).** 이 티어로 미는 구조적 피처:
- 1파일·1함수·**+1줄**(`gold_files` 단일, 헌크 1개) — ICLR 2024 구조컷에서 "1파일·<5줄 ≈ 48% solve" 상단.
- localize 직접성 L0 + `has-repro`(hints에 PR/repro 테스트 첨부) — 가장 강한 easiness 신호.
- 픽스가 자명 템플릿이지만, `.copy()` vs `copy.deepcopy()`의 깊이 선택에 가벼운 엣지추론이 끼고(따라서 순수 T1 "픽스를 거의 적어줌"보다 살짝 위), `regression-trap`(P2P 114개, 특히 `test_validators_independence`/`test_multivalue_deep_copy`/`test_subclassing_forms` 등 deepcopy 인접동작 다수)이 존재해 T1에서 T2로 올린다.

공식 라벨(`<15 min fix`)과 **일치**한다(개발자 구현시간 기준 최단). 다만 에이전트 관점의 진짜 리스크는 "구현시간"이 아니라 altitude 오버슈트(과교정)이며, 이는 시간라벨에 안 잡히는 부분이라 T2로 둔다(T1은 함정 0에 가까운 구간으로 예약).

## 골드패치 분석
- **건드린 파일·함수**: `django/forms/fields.py` — `Field.__deepcopy__`
- **근본원인**: `__deepcopy__`가 `result = copy.copy(self)`(shallow copy)로 시작한 뒤 `widget`(deepcopy)과 `validators`(`[:]` 슬라이스 복제)만 인스턴스별로 분리하고 `error_messages` dict는 손대지 않았다. shallow copy이므로 `result.error_messages`는 `self.error_messages`와 **동일 객체**를 참조 → 한쪽의 dict mutation(예: `field.error_messages['required'] = ...`)이 모든 복사본에 전파. `BaseForm.__init__`의 `deepcopy(base_fields)` 격리 의도가 무력화됨.
- **수정요지**: `result.widget = copy.deepcopy(self.widget, memo)` 다음 줄, `result.validators = self.validators[:]` 앞에 한 줄 추가 — `result.error_messages = self.error_messages.copy()`. dict의 얕은 사본(키/값 1단계 복사)으로 인스턴스별 독립 dict를 만든다. validators가 `[:]`로 분리되던 것과 정확히 같은 패턴의 빈칸 메우기.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_field_deep_copy_error_messages` — 생성 시 `error_messages={'invalid': 'Form custom error message.'}`를 주입하는 `CustomCharField`를 만들고 `copy.deepcopy(field)` 한 뒤, (a) 복사본이 여전히 `CustomCharField` 인스턴스인지(`assertIsInstance`), (b) `field_copy.error_messages`가 `field.error_messages`와 **다른 객체**인지(`assertIsNot`)를 검사.
- **픽스 증명**: 패치 전에는 두 필드가 동일 dict 객체를 공유하므로 `assertIsNot`가 실패(같은 id). 패치 후 `.copy()`가 별도 dict를 만들어 `assertIsNot` 통과. `assertIsInstance`는 deepcopy가 클래스 동일성을 보존함을 함께 확인(과교정으로 `__init__` 우회·재구성 시 깨질 수 있는 가드).
- **overfit 관점**: 테스트가 `assertIsNot`(객체 정체성)으로 분리 사실을 직접 관찰하므로 special-case 회피가 어렵다. 다만 F2P가 1개·얕은 검증이라(값 깊이까지는 안 봄) 이론상 `error_messages` dict 내부 가변값까지 공유되는 더 깊은 케이스는 미검증 → `overfit-risk`는 약하게만 존재(현실에선 값이 lazy 문자열이라 비이슈). 
- **regression 관점**: 114개 PASS_TO_PASS가 deepcopy/validators 독립성/multivalue 복제(`test_validators_independence`, `test_multivalue_deep_copy`, `test_subclassing_forms`, `test_dynamic_construction` 등)를 광범위하게 커버 → 한 줄 추가가 기존 복제 의미론을 깨지 않음을 보장(`regression-trap` 플래그의 안전망).

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement이 `django/forms/fields.py` L200 `__deepcopy__`와 `error_messages` dict를 permalink로 직접 지목 → 곧장 `Field.__deepcopy__`로 직행. 그 메서드를 읽으면 `copy.copy(self)`(shallow) 뒤 `widget`/`validators`만 재복제하고 `error_messages`는 빠져 있음이 즉시 보인다. `Field.__init__`에서 `error_messages`가 부모 클래스들의 `default_error_messages`를 병합한 **dict**로 만들어진다는 점을 확인하면 "공유 mutable dict" 진단이 확정된다.
2. **픽스와 왜 올바른 일반화인지**: `result.error_messages = self.error_messages.copy()` 한 줄. 기존 형제 라인(`validators[:]`)과 동일한 "복사본을 인스턴스별로 분리" 패턴의 빈칸을 메우는 것이라 국소적이고 일반적(특정 테스트용 special-case가 아님). `.copy()`(1단계 얕은복사)가 올바른 깊이인 이유: error_messages의 **값**은 문자열/lazy proxy라 불변 취급되고, 누수의 원인은 dict **컨테이너 공유**이지 값 공유가 아니다 → 컨테이너만 새로 만들면 격리 완성. 같은 메서드 내 `widget`은 `deepcopy`인데 그건 widget이 중첩 가변 상태를 가지기 때문이고, error_messages에는 그 깊이가 불필요.
3. **regression 안전**: `test_validators_independence`(validators가 인스턴스 간 독립)·`test_multivalue_deep_copy`·`test_subclassing_forms`·`test_dynamic_construction` 등 deepcopy 경로를 타는 P2P 114개를 안 깨야 한다. 픽스는 새 속성 분리를 **추가**만 하고 기존 widget/validators 처리 순서·방식을 건드리지 않으므로 이들이 자연히 보존된다. `result`가 여전히 같은 클래스 인스턴스임도 유지(assertIsInstance 보호).
4. **함정 회피**: 오라클 없는 에이전트의 전형 오류는 **altitude 오버슈트** — (a) `copy.deepcopy(self.error_messages)`로 과하게 복제(불필요·미세 성능손실, 값이 lazy면 의미 차이도 미묘), (b) `Field.__init__`까지 손대 dict 생성 로직을 재구성(클래스 정체성/순서 회귀 위험, assertIsInstance가 잡음), (c) `__deepcopy__`를 통째로 `copy.deepcopy` 기반으로 재작성(widget/validators의 의도적 분리 처리를 잃음). 골드의 정답 altitude는 **기존 패턴을 그대로 따른 `.copy()` 한 줄**이며, 핵심은 "복제 안 되던 mutable 속성이 `error_messages` 단 하나임을 알아채고, 형제 라인의 관용구를 복붙 수준으로 따르는 것"이다.
