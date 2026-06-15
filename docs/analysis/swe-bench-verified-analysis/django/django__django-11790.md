---
instance_id: django__django-11790
repo: django/django
base_commit: b1d6b35e146aea83b171c1b921178bbaae2795ed
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2019-09-17T14:33:44Z
fail_to_pass: 2
pass_to_pass: 77
gold_files: [django/contrib/auth/forms.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-11790

## 문제 요약
`AuthenticationForm`의 username 필드가 더 이상 HTML `maxlength` 속성을 렌더링하지 않는다. 이슈는 `#27515`과 커밋 `5ceaf14686ce626404afb6a5fbd3d8286410bf13`에서 도입된 **회귀**라고 명시한다. 회귀 전에는 `username` 필드가 모델 `USERNAME_FIELD`의 `max_length`(혹은 기본 254)만큼 HTML `maxlength` 속성을 렌더했으나, 폼 필드의 `max_length`를 `__init__`에서 런타임 동적으로 덮어쓰면서 위젯 attrs로의 전파가 끊겨 브라우저단 입력 길이 제한이 사라졌다. 예외 없이 렌더만 빠지는 silent-wrong 출력 결함이다.

## 유형 (정형화)

- **L = L0 (Pinpointed)** — problem_statement가 폼 클래스명(`AuthenticationForm`), 증상(`maxlength HTML attribute`), 회귀 커밋 SHA(`5ceaf14686ce…`)까지 직접 지목한다. `django/contrib/auth/forms.py`의 `AuthenticationForm.__init__`로 grep 한 방에 수렴. 후보 탐색 사실상 불요.
- **S = S1 Direct-Map (+S2 보조)** — 회귀라는 점이 픽스를 거의 명세한다: "값은 계산됐는데 위젯에 전파만 안 됨" → 누락된 한 줄(`widget.attrs['maxlength'] = …`)을 추가하는 기계적 동기화. 정형 결함클래스(상태 미동기화). 보조 S2가 붙는 이유는 "어떤 값"을 위젯에 넣어야 올바른지 — `self.username_field.max_length or 254`라는 동일한 fallback 식을 폼 필드와 위젯 attrs **양쪽에 일관되게** 적용해야 한다는 불변식 추론이 약하게 필요하기 때문. 후보 다수를 테스트로 거르는 G&V(S3)가 아니라, 결함을 이해하면 픽스가 결정되는 직접 매핑이라 S1이 dominant.
- **K = K-Domain** — django forms/widgets 모델 지식이 병목. "폼 필드의 `max_length`(파이썬 검증용)"와 "위젯의 `attrs['maxlength']`(HTML 렌더용)"가 **별개의 두 저장소**이며, 평소엔 필드 정의 시점에 자동 전파되지만 런타임 재대입 시엔 수동 동기화가 필요하다는 django 내부 계약을 모르면 헛다리를 짚는다. 일반 파이썬 추론(K-Gen)만으론 부족.

**Primary = T-DirectMap.** 위치가 명확(L0)하고 픽스가 기계적 상태-동기화(S1)다. T-DirectMap의 정의("위치 명확 + S1 기계적 픽스")에 정확히 부합. K-Domain이 있으나 dominant 병목은 아니라 T-DomainBound로 끌어올리지 않는다 — 도메인 지식은 "이 한 줄이 빠졌다"를 깨닫게 하는 보조일 뿐, 일단 깨달으면 픽스 도출은 자명하다.

## 난이도 티어
**Tier = T2 (쉬움).** 공식 라벨은 `15 min - 1 hour`(시간 prior로 T3 근방)이나 **구조적 피처로 한 단계 낮춰 T2**로 본다.

- **이 티어로 미는 피처**: 1파일(`forms.py`) · 1함수(`__init__`) · 실질 1줄→3줄(지역변수 hoist 포함) 변경. L0 직접 localize. 회귀 커밋 SHA가 박혀 있어 사실상 has-repro에 준하는 강한 easiness 신호. 픽스가 가드/상수 추가류의 기계적 S1.
- **공식 라벨과 다른 이유**: OpenAI 시간라벨은 "개발자 구현시간"이라 회귀 추적·django widget 모델 이해에 드는 사람의 탐색 시간이 반영돼 1시간 가까이 잡힌다. 그러나 에이전트 관점에선 이슈가 파일·함수·증상·회귀커밋을 다 적어줘 localize 노력이 0에 가깝고 패치 scope가 극소(1파일·<5줄, ICLR 2024 컷에서 ~48% solve 구간)이라 T1~T2 구간이 맞다.
- **T1로 더 내리지 않는 이유**: 순수 K-Gen이 아니다. "max_length 줄은 이미 멀쩡히 존재"하므로 widget.attrs가 별개라는 K-Domain 인지가 없으면 "이미 맞는데?"라고 오판할 함정이 있다. 또 P2P 77개 중 `AuthenticationFormTest`의 인접 동작(label/autocapitalize/integer_username 등)을 안 깨야 하는 약한 **regression-trap**이 존재한다.

## 골드패치 분석
- **건드린 파일·함수**: `django/contrib/auth/forms.py` → `AuthenticationForm.__init__`
- **근본 원인**: `__init__`이 `self.fields['username'].max_length = self.username_field.max_length or 254`로 **폼 필드의 파이썬 검증용 길이만** 런타임에 덮어쓰고, 실제 HTML 렌더에 쓰이는 `self.fields['username'].widget.attrs['maxlength']`는 갱신하지 않았다. `#27515`(5ceaf14) 이전에는 필드 정의 시점에 `max_length`가 위젯 attrs로 자동 전파됐으나, 동적 재대입 경로에서 그 동기화가 빠지면서 위젯 attrs에 `maxlength` 키가 영영 안 들어갔다.
- **수정 요지**: 계산값을 지역변수 `username_max_length = self.username_field.max_length or 254`로 한 번만 뽑은 뒤, `self.fields['username'].max_length`와 `self.fields['username'].widget.attrs['maxlength']` **양쪽에 동일 값**을 명시 대입한다. 폼 검증 길이와 HTML 속성을 단일 source 값으로 일치시키는 것이 핵심 — fallback `or 254`를 한 곳에서만 평가해 양쪽이 갈라지지 않게 한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**:
  - `test_username_field_max_length_matches_user_model` — 커스텀 `CustomEmailField`(USERNAME_FIELD max_length=255) 모델로 `AuthenticationForm` 생성 → 위젯 maxlength == 255 기대.
  - `test_username_field_max_length_defaults_to_254` — `IntegerUsernameUser`(max_length 미지정) 모델 → 기본 fallback 254 기대.
  - 둘 다 `auth_tests.test_forms.AuthenticationFormTest`.
- **픽스 증명**: 각 테스트는 기존 `form.fields['username'].max_length == 255/254` 단언에 더해 새 단언 `form.fields['username'].widget.attrs.get('maxlength') == 255/254`를 추가한다. 픽스 전엔 위젯 attrs에 `maxlength` 키가 없어 `.get()`이 `None`을 반환해 실패, 픽스 후엔 값이 들어가 통과. 즉 폼 필드 레벨이 아니라 **위젯 attrs 레벨**을 직접 관찰해 회귀를 재현한다.
- **overfit 관점**: `or 254` 기본 분기(254)와 커스텀 길이 분기(255) 두 경로를 모두 커버하므로 단일 special-case 통과(예: 위젯에 254를 상수로 하드코딩)는 255 테스트에서 깨진다 — overfit 저지력이 있다. 단 두 케이스뿐이라 매우 얇은 건 아니지만 강하지도 않아 `overfit-risk` 플래그까진 달지 않는다(골드처럼 동일 source 값을 쓰면 자연히 일반화됨).
- **regression 관점**: P2P 77개가 `AuthenticationFormTest`/`UserCreationFormTest`/`PasswordChangeFormTest` 등 인접 auth 폼 동작을 광범위하게 잠근다. 위젯 attrs에 키 하나를 **추가**할 뿐 기존 `max_length` 대입은 그대로 보존하므로 label/autocapitalize/`test_integer_username`/`test_html_autocomplete_attributes` 등이 안 깨진다. `regression-trap` 플래그는 P2P 폭(77)을 반영하나 픽스가 순수 additive라 실제 파손 위험은 낮다.

## 모범답안 (오라클 기반)

1. **Localize 경로**: 이슈가 `AuthenticationForm` + `maxlength HTML attribute` + 회귀 커밋 `5ceaf14`를 직접 준다. `git show 5ceaf14` 또는 `grep "max_length" django/contrib/auth/forms.py`로 `AuthenticationForm.__init__`의 `self.fields['username'].max_length = self.username_field.max_length or 254` 한 줄에 즉시 도달. 회귀 SHA가 "여기서 깨졌다"를 확정해 줘 탐색이 0에 수렴.

2. **픽스와 일반화 근거**: max_length 대입 옆에 `self.fields['username'].widget.attrs['maxlength'] = …`를 추가하되, fallback `or 254`를 **지역변수 `username_max_length`로 한 번만 평가**해 폼 필드와 위젯 attrs에 같은 값을 넣는다. 이것이 올바른 일반화인 이유: 254 상수를 위젯에 하드코딩하면 커스텀 USERNAME_FIELD(255) 케이스에서 폼 검증 길이와 HTML 속성이 갈라진다. 단일 source 값을 양쪽에 분배하는 것이 "폼이 max_length를 동적으로 정하면 위젯도 그 값을 반영한다"는 의도된 불변식을 정확히 복원한다.

3. **regression 안전**: 기존 `self.fields['username'].max_length = …` 대입을 **삭제하지 말고 보존**(파이썬 레벨 검증이 P2P 다수의 전제)하고 위젯 attrs는 **추가만** 한다. 그러면 P2P 77 — 특히 `AuthenticationFormTest`의 `test_username_field_label*`, `test_integer_username`, `test_html_autocomplete_attributes`(같은 위젯 attrs를 만지는 인접 동작) — 가 그대로 통과한다. attrs를 dict 재할당이 아니라 키 set으로 처리해 autocomplete 등 기존 attrs를 날리지 않는 것도 중요.

4. **함정 회피**: 오라클 없는 에이전트의 최빈 오답은 "`max_length` 대입 줄이 이미 존재 → 이미 맞는데?"라고 판단해 No-op하거나, 폼 필드 `max_length`만 만지고 끝내는 것. 핵심 함정은 **django에서 폼 필드 `max_length`와 위젯 `attrs['maxlength']`가 별개 저장소**이며 런타임 재대입 시 자동 전파가 안 된다는 점이다. 이를 피하려면 증상("HTML 렌더에 maxlength 없음")을 코드 위치("widget.attrs 미설정")로 번역하고, 검증 단계에서 폼 필드가 아니라 **위젯 attrs(`widget.attrs.get('maxlength')`)를 직접 단언**하는 재현 테스트를 먼저 세워야 한다. 또 254를 양쪽에 따로 적어 source가 갈라지는 미묘한 overfit도 single-eval 지역변수로 차단.
