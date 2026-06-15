---
instance_id: django__django-13741
repo: django/django
base_commit: d746f28949c009251a8741ba03d156964050717f
version: 3.2
difficulty: <15 min fix
created_at: 2020-12-02T10:52:52Z
fail_to_pass: 1
pass_to_pass: 82
gold_files: [django/contrib/auth/forms.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, overfit-risk]
---

# django__django-13741

## 문제 요약
`django.contrib.auth.forms.UserChangeForm`은 비밀번호 해시가 사용자에 의해 (실수로) 변경되는 것을 막기 위해 `clean_password` 메서드로 항상 초기값(`self.initial['password']`)을 되돌려준다. User 모델용 커스텀 폼을 만들 때도 이 메서드를 반드시 정의해야 한다고 공식 문서에 명시되어 있는데, 이걸 빼먹으면 비밀번호 해시가 조용히 덮어써지는 함정이 있다. 한편 `forms.Field` 베이스 클래스에는 이미 `disabled` 인자가 있어 "제출된 값을 무시하고 폼의 initial 데이터 값을 강제"한다. 이슈는 이 `disabled`를 `ReadOnlyPasswordHashField`에 기본 `True`로 걸면 `clean_password`(및 폼/필드 보일러플레이트)가 불필요해지고 함정이 제거된다는 개선 요청이다.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed).** problem_statement가 `ReadOnlyPasswordHashField`, `UserChangeForm`, `clean_password`, `disabled`라는 구체 심볼을 그대로 지목한다. `grep ReadOnlyPasswordHashField` → `django/contrib/auth/forms.py` 단일 파일·단일 클래스로 한 방에 수렴. 탐색 비용 사실상 0.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S6 Design-Refactor).** 고칠 지점은 자명하지만 "한 줄 추가"가 아니라 **`disabled` 시맨틱이 기존 보일러플레이트(`bound_data`/`has_changed`/`clean_password`)와 의미적으로 등가임을 추론으로 증명한 뒤 그 중복을 제거**하는 게 본질이다. `disabled=True` → base `Field.has_changed`가 항상 `False`, `bound_data`가 initial 강제 → 수동 구현 3개가 모두 redundant가 됨을 따져야 정답 패치가 나온다. 따라서 dominant는 불변식 추론(S2), 보조로 죽은 코드 정리 구조변경(S6). 단순 템플릿 매칭(S1)이 아닌 이유: 픽스가 "가드 추가"가 아니라 "프레임워크 메커니즘으로 위임하며 기존 로직 삭제"라는 동치성 판단을 요구하기 때문.
- **K (Knowledge) = K-Domain.** django forms 내부 계약(`Field.disabled`가 `bound_data`/`has_changed`/`clean`에 미치는 효과)을 알아야만 "보일러플레이트를 안전하게 지울 수 있다"는 결론에 도달한다. 일반 파이썬 추론(K-Gen)으로는 `disabled` 한 줄만 추가하고 멈춘다.
- **Primary type = T-DomainBound.** 위치는 trivial(L0)이고 줄수도 작지만, 난점의 핵심은 "django forms `disabled` 프로토콜이 무엇을 보장하는가"라는 프레임워크 내부지식이다. 이 지식이 있으면 골드와 동일한 정리까지 가고, 없으면 부분 픽스(overfit)에 머문다 → K-Domain이 병목이므로 T-DomainBound.

## 난이도 티어

**Tier = T3 (중간).** 공식 라벨은 `<15 min fix`(개발자 구현시간 기준 T1~T2급)인데, 구조피처 기반으로는 한 단계 위인 T3로 조정한다. 근거:

- **T1/T2로 끌어내리는 피처:** 단일 파일(`forms.py`), 골드 net 변경 ≲5줄(추가 1줄 + 메서드 3개 삭제), L0 pinpoint localize.
- **T3로 미는 피처:** (1) **K-Domain 병목** — `disabled` 시맨틱을 모르면 정답 일반화에 도달 못 함. (2) **overfit-risk** — FAIL_TO_PASS가 `assertIs(field.disabled, True)` 한 줄뿐이라 `disabled` 추가 + 삭제 없음(부분 픽스)으로도 채점 통과 가능 → 테스트가 정답을 과소명세. (3) **regression-trap** — P2P 82개가 인접 동작(`test_bug_19349_bound_password_field`, "The change form does not return the password value", UserChangeForm 전체 스위트)을 광범위하게 커버하므로, 보일러플레이트 삭제가 이 중 하나라도 깨면 안 됨. 삭제 여파가 폼 레벨까지 번지는 게 단순 1줄 수정과 질적으로 다름.
- 공식 라벨과의 차이: 시간라벨은 "숙련 django 개발자"가 도메인지식을 이미 가진 상태의 구현시간이라 K-Domain·overfit 비용을 포착하지 못한다. 오라클 없는 에이전트 입장에선 그 두 축이 실난이도이므로 T3가 타당.

## 골드패치 분석

- **건드린 파일·함수:** `django/contrib/auth/forms.py`
  - `ReadOnlyPasswordHashField.__init__` — 한 줄 추가
  - `ReadOnlyPasswordHashField.bound_data` — 삭제
  - `ReadOnlyPasswordHashField.has_changed` — 삭제
  - `UserChangeForm.clean_password` — 삭제
- **근본 원인:** `ReadOnlyPasswordHashField`는 입력 위젯을 렌더링하지 않는 읽기전용 필드인데도 `disabled` 플래그가 꺼져 있다. 그래서 "제출값 무시 + initial 강제"라는 동작을 프레임워크 메커니즘 대신 수동 보일러플레이트로 흩어 구현했다 — 필드 레벨의 `bound_data`(항상 initial 반환)·`has_changed`(항상 False), 그리고 폼 레벨의 `UserChangeForm.clean_password`(항상 `self.initial['password']` 반환). 이 보호가 **폼 레벨에 일부 의존**하기 때문에 커스텀 User 폼이 `clean_password`를 누락하면 보호가 사라지는 fragile 계약이 된다.
- **수정 요지:**
  - `ReadOnlyPasswordHashField.__init__`에 `kwargs.setdefault('disabled', True)` 추가 → django forms의 `disabled` 메커니즘이 제출값을 무시하고 initial을 강제(`has_changed`는 base에서 항상 False, `bound_data`는 initial 반환)하도록 위임.
  - 이제 redundant가 된 `ReadOnlyPasswordHashField.bound_data`·`has_changed` 삭제.
  - 보호가 필드 자체로 이동했으므로 `UserChangeForm.clean_password` 삭제. 이 결과 보호가 폼 정의에서 필드 정의로 이전되어, 커스텀 폼이 `clean_password`를 빼먹어도 안전해짐(이슈가 지적한 함정 제거).
  - `setdefault` 사용이 핵심 — 호출자가 명시적으로 `disabled=False`를 넘기는 하위호환 경로를 깨지 않는다.

## 검증 (test_patch)

- **FAIL_TO_PASS (1):** `test_readonly_field_has_changed (auth_tests.test_forms.ReadOnlyPasswordHashTest)`
- **동작/픽스 증명:** 테스트는 기존 케이스에 `self.assertIs(field.disabled, True)` 한 줄을 추가한다. 인자 없이 `ReadOnlyPasswordHashField()`를 생성했을 때 `disabled`가 기본 `True`인지 검증 → `__init__`의 `setdefault('disabled', True)`가 정확히 이걸 만든다. 이어지는 `assertFalse(field.has_changed('aaa', 'bbb'))`는 `has_changed` 메서드를 **삭제했음에도** base `Field.has_changed`가 `disabled` 필드에 대해 항상 `False`를 반환하므로 통과 → initial(`'aaa'`)≠data(`'bbb'`)여도 "변경 없음"이 보장됨을 입증한다. 즉 삭제한 수동 로직과 `disabled` 위임이 동치임을 한 케이스로 확인.
- **overfit 관점:** FAIL_TO_PASS가 `disabled is True`만 단언하므로 **`disabled` 한 줄만 추가하고 3개 메서드를 안 지운 부분 픽스도 채점 통과**한다(weak test → S4성 과소명세). 골드와 diff는 어긋나지만 테스트는 green → overfit-risk 실재. 반대 방향 overfit(테스트만 맞추려 has_changed를 special-case)도 가능하나 base 동작과 충돌해 P2P가 잡는다.
- **regression 관점:** `clean_password`/`bound_data` 삭제가 회귀를 일으키지 않음을 P2P가 보장 — `test_bug_19349_bound_password_field`(bound 필드 렌더), "The change form does not return the password value"(폼이 password 값을 반환 안 함), `test_bug_17944_*`, `test_render` 등이 삭제 후에도 동일 동작을 강제한다. 이들이 통과해야 "`disabled` 위임이 수동 보일러플레이트와 진짜 등가"임이 회귀 없이 입증됨.

## 모범답안 (오라클 기반)

1. **localize 경로:** problem_statement가 `ReadOnlyPasswordHashField`/`disabled`/`clean_password`를 명시 → `grep ReadOnlyPasswordHashField` → `django/contrib/auth/forms.py`. 같은 파일에서 `UserChangeForm.clean_password`와 `ReadOnlyPasswordHashField`의 `bound_data`/`has_changed`까지 한눈에 보임. localize는 사실상 즉시 끝.
2. **픽스와 올바른 일반화:** `__init__`에 `kwargs.setdefault('disabled', True)`. `setdefault`여야 하는 이유 = 명시 `disabled=False` 호출자를 깨지 않는 하위호환(API 계약). 그다음 핵심은 **`disabled` 시맨틱이 기존 3개 수동 메서드와 등가임을 검증하고 그것을 삭제**하는 것 — django forms에서 `disabled=True`면 base `Field.has_changed`가 항상 False, `bound_data`가 initial을 반환하므로 필드의 `bound_data`/`has_changed` override는 redundant, 그리고 보호가 필드로 이동해 `UserChangeForm.clean_password`도 불필요. 이게 "테스트만 맞추는 special-case"가 아니라 **메커니즘 위임에 의한 중복 제거**라 올바른 일반화다. 함정 제거(커스텀 폼의 `clean_password` 누락 안전)는 이 삭제가 완료돼야 달성됨.
3. **regression 안전:** 삭제 전 P2P가 보장하는 인접 동작을 안 깨는지 추론으로 확인 — bound password 필드 렌더(`test_bug_19349_bound_password_field`), 폼이 raw password 값을 반환하지 않음("The change form does not return the password value"), unknown/empty/unmanageable password 렌더(`test_bug_17944_*`). `disabled=True`가 이 모두를 base 경로로 동일 보장하므로 삭제 안전.
4. **함정 회피:** 오라클 없는 에이전트의 전형적 오답은 두 가지. (a) **부분 픽스** — `disabled` 한 줄만 넣고 `clean_password`/`bound_data`/`has_changed`를 남김. FAIL_TO_PASS가 `disabled is True`만 보므로 green이 떠 "완료"로 오판하지만 골드와 diff 불일치·dead code 잔존(overfit). (b) **과삭제** — `disabled` 추가 없이 메서드만 지우거나 `setdefault`가 아닌 `kwargs['disabled']=True`로 덮어써 `disabled=False` 호출자를 깸. 회피법 = django forms `disabled` 프로토콜(initial 강제·제출값 무시·base has_changed=False)을 먼저 확인하고, "이 메커니즘이 수동 로직과 등가임"을 근거로 삭제까지 수행하되 `setdefault`로 하위호환을 지키는 것. 즉 K-Domain을 약한 테스트의 빈틈을 메우는 spec으로 사용한다.
