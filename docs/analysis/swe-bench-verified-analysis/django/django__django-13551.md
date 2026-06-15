---
instance_id: django__django-13551
repo: django/django
base_commit: 7f9e4524d6b23424cf44fbe1bf1f4e70f6bb066e
version: 3.2
difficulty: <15 min fix
created_at: 2020-10-17T17:22:01Z
fail_to_pass: 2
pass_to_pass: 56
gold_files: [django/contrib/auth/tokens.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-13551

## 문제 요약
패스워드 리셋 토큰이 발급된 후 사용자가 이메일 주소를 바꾸면, 발급된(미사용) 리셋 토큰이 무효화되어야 하는데 여전히 유효하게 통과된다. 시나리오: foo@ 계정으로 리셋 요청(미사용) → 계정이 이메일을 변경 → 기존 리셋 메일의 토큰을 사용하면 거부되어야 하지만 허용된다. 이슈 본문은 "The fix is to add the user's email address into `PasswordResetTokenGenerator._make_hash_value()`"라고 픽스 위치와 방향을 명시하며, AbstractBaseUser가 이메일을 강제하지 않는다는 점도 경고한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: 이슈 본문이 `PasswordResetTokenGenerator._make_hash_value()`를 풀네임으로 직접 지목한다. grep 한 방으로 `django/contrib/auth/tokens.py`의 단일 함수에 도달. 탐색 부담 0.
- **S (Repair Strategy) = S1 (Direct-Map) +S2**: dominant는 S1 — 이슈가 사실상 픽스를 명세한다("해시 입력에 email을 추가하라"). 해시 입력 문자열에 한 토큰을 더 붙이는 기계적 add-field 픽스. 다만 순수 S1이 아닌 이유로 S2 보조: "email을 어떻게 안전하게 꺼낼 것인가"에 약간의 제약 추론이 필요하다 — `user.email` 하드코딩은 틀리고, 커스텀 EMAIL_FIELD 및 None/미보유 케이스를 따져 `get_email_field_name()` + `getattr(..., '') or ''`로 합성해야 한다. 이 엣지 추론이 정답과 순진한 오답을 가른다.
- **K (Knowledge) = K-Domain**: django.contrib.auth 도메인 지식 필요. `AbstractBaseUser.get_email_field_name()` / `EMAIL_FIELD` 규약, 그리고 토큰 해시가 "password reset 시 변하는 상태"로 무효화를 구현한다는 설계 의도를 알아야 올바른 픽스가 나온다. 일반 파이썬 추론만으로는 `user.email` 하드코딩에 그치기 쉽다.
- **Primary = T-DirectMap**: 위치가 명확(L0)하고 픽스가 기계적 "필드 추가"(S1)이므로 T-DirectMap. 이슈가 픽스를 거의 적어주지만 K-Domain 엣지(get_email_field_name/None 방어)가 자명함을 약간 깎아 T-LocTrivial까지는 아니다.

## 난이도 티어
- **티어 = T2 (쉬움)**.
- 이 티어로 미는 구조적 피처: (1) **1파일·1함수·실질 3줄 변경**(헌크 2개지만 하나는 docstring, 실코드는 return 라인 교체) — 구조적 컷에서 1파일·<5줄은 ~48% solve 구간. (2) **L0 localize**(이슈가 함수 풀네임 + 픽스 방향 제공) — 가장 강한 easiness 신호 중 하나. (3) **has-repro**: 이슈가 4단계 재현 시퀀스를 명시(네이티브 스택은 아니지만 결정론적 재현절차). (4) 픽스 패턴이 정형(add-to-hash-input).
- T1이 아닌 이유: 픽스가 완전 자명하지 않다. `user.email` 직접 참조라는 순진 구현이 커스텀 이메일 필드/None 케이스에서 깨지므로 K-Domain 엣지 추론(S2 보조)이 끼어든다 — 이게 품질 분기점이라 "존나쉬움" 위로 올린다.
- T3+도 아닌 이유: cross-file 조율 없음(gold는 단일 파일), 깊은 call-chain 추적 없음, underspecified 아님(이슈가 명확).
- **공식 라벨(<15 min fix)과 일치**: 개발자 구현시간 기준 15분 미만이며, 에이전트 난이도 관점(L0 + S1 + 좁은 regression 표면)에서도 T2가 부합한다. 조정 불필요.

## 골드패치 분석
- **건드린 파일·함수**: `django/contrib/auth/tokens.py` → `PasswordResetTokenGenerator._make_hash_value(self, user, timestamp)` (그리고 그 docstring).
- **근본 원인**: 토큰 해시 입력이 `str(user.pk) + user.password + str(login_timestamp) + str(timestamp)`로, **사용자 이메일을 포함하지 않았다**. 토큰 무효화는 "리셋 후 반드시 바뀌는 상태(password salt, last_login)"를 해시에 넣어 구현되는데, 이메일 변경은 password/last_login을 건드리지 않으므로 해시가 불변 → 변경 전 발급된 토큰이 계속 유효(silent-wrong, 보안 결함).
- **수정 요지**:
  1. `email_field = user.get_email_field_name()` — 하드코딩 `user.email` 대신 모델이 선언한 EMAIL_FIELD 명을 동적으로 얻어 커스텀 유저 모델 호환.
  2. `email = getattr(user, email_field, '') or ''` — 필드 미존재(AbstractBaseUser는 email 강제 안 함) 및 값이 None인 경우 둘 다 빈 문자열로 정규화.
  3. return을 f-string `f'{user.pk}{user.password}{login_timestamp}{timestamp}{email}'`로 교체해 email을 해시 입력 끝에 부착.
  4. docstring을 "Hash the user's primary key, **email (if available)**, and some user state..."로 갱신해 의도 문서화.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**: `test_token_with_different_email` ("Updating the user email address invalidates the token.") 및 `test_token_with_different_secret (auth_tests.test_tokens.TokenGeneratorTest)`.
- **픽스 증명 동작**: `test_token_with_different_email`은 3개 케이스를 subTest로 돈다 — `(CustomEmailField, None)`, `(CustomEmailField, 'test4@example.com')`, `(User, 'test4@example.com')`. 각 케이스: 유저 생성 → `make_token`으로 tk1 발급 → `check_token(user, tk1) is True` 확인 → `setattr(user, user.get_email_field_name(), 'test4new@example.com')`로 이메일 변경 후 `save()` → 같은 토큰의 `check_token`이 **False**여야 한다. 픽스 전에는 해시에 email이 없어 변경 후에도 True를 반환 → 실패. 테스트 인프라 변경으로 `with_custom_email_field.py`의 `email_address`를 `null=True`로 바꿔 **None 이메일 경로**(`(CustomEmailField, None)` 케이스)를 명시적으로 커버한다.
- **overfit 관점**: FAIL_TO_PASS가 얇아 보이지만(2개), 핵심 테스트가 (a) 빌트인 User, (b) 커스텀 EMAIL_FIELD 모델, (c) None 이메일의 3축을 한 번에 친다. 즉 `user.email` 하드코딩이나 None 미방어로 통과하는 special-case 경로를 테스트가 막아 overfit 여지를 좁힌다. overfit-risk 플래그는 달지 않는다.
- **regression 관점**: PASS_TO_PASS 56개 — `test_10265`(reload 후 동일 토큰), `test_make_token`, `test_legacy_token_validation`, `test_token_default_hashing_algorithm` 등 토큰 생성·검증 동작 전반 + auth 모델/매니저 테스트군. 해시 입력 끝에 email을 추가하는 것은 **이메일 미보유/불변 유저에게는 빈 문자열을 붙이는 것과 동치**여야 기존 토큰 동작이 보존된다. `or ''` 정규화가 이 invariant를 지킨다. regression-trap 플래그 부여(56개 인접 동작 보호 필요).

## 모범답안 (오라클 기반)
1. **Localize 경로**: 이슈 본문이 `PasswordResetTokenGenerator._make_hash_value()`를 명시 → grep `_make_hash_value` → `django/contrib/auth/tokens.py` 단일 함수. 현재 return이 `pk + password + last_login + timestamp`임을 확인하고 email이 빠졌음을 즉시 식별. (탐색 사실상 불필요.)
2. **픽스(왜 올바른 일반화인가)**: 해시 입력에 user의 EMAIL_FIELD 값을 추가. 핵심은 `user.email` 직접 참조가 아니라 `user.get_email_field_name()`로 필드명을 동적 해석하고 `getattr(..., '') or ''`로 추출하는 것. 이게 올바른 일반화인 이유: (a) 커스텀 유저 모델이 EMAIL_FIELD를 'email_address' 등으로 둘 수 있으므로 하드코딩은 AttributeError/오동작 유발; (b) AbstractBaseUser는 email을 강제하지 않고 null일 수 있으므로 빈 문자열 정규화로 이메일 없는 유저의 토큰 동작을 보존. special-case가 아니라 "리셋 후 바뀌어야 할 상태"라는 일반 원칙에 email을 편입.
3. **regression 안전**: 안 깨야 할 P2P — `test_10265`(같은 유저 reload 시 토큰 동일), `test_make_token`, `test_legacy_token_validation`, `test_token_default_hashing_algorithm`, 그리고 커스텀 이메일/None을 다루는 auth 모델 테스트들. email이 변하지 않거나 없는 유저에게 해시 결과가 (빈 문자열 append이므로) 결정론적으로 일관되어야 위 테스트들이 살아남는다. `or ''`가 이 invariant를 보장. (기존 발급 토큰이 이 릴리스에서 전부 무효화되는 것은 의도된 보안 동작이라 OK — django는 메이저 보안 픽스로 수용.)
4. **함정 회피**: 오라클 없는 에이전트의 주요 오답 — (i) `user.email` 하드코딩 → 커스텀 EMAIL_FIELD 모델(`CustomEmailField`) 케이스에서 실패. (ii) None 미방어(`str(user.email)` 또는 `+ user.email`) → `(CustomEmailField, None)` 케이스에서 TypeError 또는 'None' 문자열 혼입. (iii) 이슈의 "factored out onto the model, ala get_session_auth_hash()" 힌트를 과대해석해 모델에 메서드를 추가하는 over-engineering(gold는 하지 않음) → 불필요한 cross-file 변경/regression. 정답은 `get_email_field_name()` + `getattr(..., '') or ''` 2-줄 방어를 인지하고 최소 변경에 머무는 것.
