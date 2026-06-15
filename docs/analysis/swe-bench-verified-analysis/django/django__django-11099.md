---
instance_id: django__django-11099
repo: django/django
base_commit: d26b2424437dabeeca94d7900b37d2df4410da0c
version: "3.0"
difficulty: <15 min fix
created_at: 2019-03-20T03:46:18Z
fail_to_pass: 3
pass_to_pass: 19
gold_files: [django/contrib/auth/validators.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Gen
flags: [has-repro]
---

# django__django-11099

## 문제 요약
`ASCIIUsernameValidator`와 `UnicodeUsernameValidator`는 `r'^[\w.@+-]+$'` 정규식으로 username을 검증한다. 의도는 영숫자와 `.@+-` 문자만 허용하는 것이지만, Python 정규식에서 `$`는 (MULTILINE이 아니어도) "문자열의 끝" 또는 "끝에 붙은 단일 개행(`\n`) 직전"에 매치된다. 따라서 `"trailingnewline\n"` 처럼 후행 개행이 포함된 username이 검증을 통과해 버린다. 이슈는 원인(`$` quirk), 영향받는 두 validator의 위치(`contrib.auth.validators`), 정확한 권장 수정(`r'\A[\w.@+-]+\Z'`)까지 전부 적어준다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** problem_statement가 파일(`contrib.auth.validators`), 두 심볼(`ASCIIUsernameValidator`, `UnicodeUsernameValidator`), 문제의 정확한 regex 리터럴(`r'^[\w.@+-]+$'`)까지 그대로 지목한다. grep 한 방이면 끝 — 탐색 노력이 사실상 0이라 L1조차 아니다.
- **S (Repair Strategy) = S1 Direct-Map (+S2 보조).** 이슈가 픽스를 거의 명세한다(권장 regex까지 제시) → 기계적 상수 교체 = S1 (PAR/TBar식 결함클래스 "잘못된 앵커 → 올바른 앵커" 템플릿 매칭). 보조로 S2가 붙는 이유: 골드는 권장안의 절반만(끝 앵커 `$`→`\Z`만, 시작 `^`은 유지) 적용한다. 시작 측은 `^`와 `\A`가 동작상 등가임을 추론해 최소 변경을 고르는 작은 불변식 추론이 있으나, 이는 dominant가 아니라 S1 위의 옵션 미세조정이라 보조 표기.
- **K (Knowledge) = K-Gen.** 필요한 지식은 "Python regex에서 `$`가 후행 `\n`에 매치된다 / `\Z`는 절대 끝에만 매치된다"는 일반 Python/정규식 지식이다. django ORM·query-compiler·migrations 같은 프레임워크 내부 도메인 지식이 아니므로 K-Domain 아님. (validator가 django에 살지만 픽스 추론은 순수 regex semantics.)
- **Primary type = T-DirectMap.** 위치가 완전히 명확(L0)하고 픽스가 기계적 상수/리터럴 교체(S1)이므로 T-DirectMap이 정확히 들어맞는다. T-LocTrivial(L0+S1, 픽스가 자명)과 경계에 가깝지만, "`$`→`\Z`로 바꿔야 한다"는 비자명한 regex quirk 지식이 픽스의 정당성을 좌우하므로(가드 추가 등 오답 경로가 존재) 순수 자명(T1급 T-LocTrivial)보다는 T-DirectMap이 맞다.
- **왜 이 strategy인가 (APR 관점):** 결함이 정형 결함클래스(잘못된 정규식 앵커 = 경계/종료 오용)에 속하고 이슈가 수정 토큰까지 제공하므로, 후보를 여럿 생성·테스트로 선택(S3)하거나 스펙을 재구성(S5)할 필요가 없다. 단일 결정적 변환 = 전형적 template-based repair(S1).

## 난이도 티어
**Tier = T2 (쉬움).** 공식 라벨은 `<15 min fix`(T1~T2 prior)이며 이 분류와 일치한다.

이 티어로 미는 구조적 피처:
- **파일/줄 수:** 단일 파일 `django/contrib/auth/validators.py`, 2-라인 변경(2개 클래스 각 1줄). ICLR 2024 구조 컷의 "1파일·소규모" 영역으로 solve-rate 상단.
- **localize 직접성:** L0 — 이슈가 심볼·리터럴을 지목해 localization 에러(실패의 ~51%) 위험이 0에 수렴.
- **repro:** 이슈에 명시적 재현 입력(`"...\n"`)과 기대 동작(거부)이 있어 `has-repro` 신호 — 가장 강한 easiness 지표.
- **P2P trap:** PASS_TO_PASS 19개는 전부 동일 테스트 모듈(`auth_tests.test_validators`)의 password validator 계열로, 정규식 앵커 변경과 의미적으로 격리되어 있다. regression-trap 약함.

**T1이 아니라 T2인 이유:** T1(존나쉬움)은 "이슈가 픽스를 거의 적어주고 K-Gen이며 자명"인데, 본 문제는 이슈가 픽스를 적어주긴 하나 그 정당성이 "`$`가 후행 개행에 매치된다"는 비자명한 quirk에 의존한다. 이 지식이 없으면 `^...$`를 그대로 두고 별도 검증 로직을 덧붙이는 오답 경로로 새기 쉽다(아래 함정 참조). 따라서 완전 자명 T1보다 한 칸 위인 T2가 방어 가능하다. 공식 시간라벨과는 충돌 없음.

## 골드패치 분석
- **건드린 파일/함수:** `django/contrib/auth/validators.py`
  - `ASCIIUsernameValidator.regex`
  - `UnicodeUsernameValidator.regex`
- **근본 원인:** Python `re`에서 끝 앵커 `$`는 MULTILINE이 아니어도 "문자열의 끝" **또는** "끝에 위치한 단일 `\n` 직전"에 매치된다. 그래서 `r'^[\w.@+-]+$'`는 `"foo\n"`을 valid로 통과시킨다(끝 `\n` 직전에서 `$`가 매치).
- **수정 요지:** 두 validator의 `regex`에서 끝 앵커만 `$` → `\Z`로 교체:
  - `r'^[\w.@+-]+$'` → `r'^[\w.@+-]+\Z'`
  `\Z`는 후행 개행을 허용하지 않고 오직 문자열의 절대 끝에만 매치하므로 후행 `\n`을 거부한다. 시작 앵커 `^`는 그대로 둔다 — 시작 측은 입력에 선행 개행이 없는 한 `^`와 `\A`가 동작상 등가이고(그리고 `+`는 최소 1문자를 강제), regex 흐름상 시작 측 후행-개행 버그가 없으므로 최소 변경으로 끝 앵커만 고친 것. (이슈 권장안 `\A...\Z`보다 좁은 수정이지만 동작은 동일.)

## 검증 (test_patch)
- **FAIL_TO_PASS (3):** `test_ascii_validator`, `test_unicode_validator` (둘 다 `UsernameValidatorsTests`), 그리고 `test_help_text (UserAttributeSimilarityValidatorTest)`. 앞 둘이 핵심 회귀 테스트이고, `test_help_text`는 동일 테스트 파일 수집/실행에 묶여 함께 status 전이되는 케이스.
- **픽스 증명 동작:** 두 테스트는 `invalid_usernames`에 후행 개행 케이스를 추가한다 — ascii는 `'trailingnewline\n'`, unicode는 `'trailingnewline
'`(= `\n`). 테스트는 각 invalid username에 대해 validator가 `ValidationError`를 던지길 `assertRaises`로 기대한다. 버그 있는 `$` regex에서는 해당 입력이 통과해 예외가 안 나 **FAIL**; `\Z` 패치 후에는 거부되어 예외 발생 → **PASS**. valid 케이스(`'glenn'`, `'jean-marc'` 등)는 양 regex에서 동일하게 통과하므로 false-positive 회귀 없음.
- **overfit 관점:** 추가된 음성 케이스는 정확히 버그가 발생하는 입력공간(후행 `\n`)을 찌른다. special-case 하드코딩(예: `username.endswith('\n')` 체크 추가)으로도 이 테스트를 통과시킬 수 있어 이론상 overfit 여지는 있으나, 골드의 `\Z` 교체는 그 입력공간 전체(끝 개행 일반)를 닫는 올바른 일반화라 overfit이 아니다. FAIL_TO_PASS가 ascii/unicode 양쪽을 커버해 단일 validator만 고치는 부분픽스도 걸러낸다.
- **regression 관점:** PASS_TO_PASS 19개는 password validator 계열(`MinimumLength`/`NumericPassword`/`UserAttributeSimilarity`/`CommonPassword`/`PasswordValidation`)로 username regex와 무관해 회귀 위험 낮음. `regression-trap` 플래그 미부여.

## 모범답안 (오라클 기반)
1. **Localize 경로:** 이슈 제목 "UsernameValidator allows trailing newline" + 본문이 `contrib.auth.validators`와 정확한 regex 리터럴 `r'^[\w.@+-]+$'`을 명시 → `django/contrib/auth/validators.py`로 직행. 해당 파일에서 동일 regex를 쓰는 두 클래스(`ASCIIUsernameValidator`, `UnicodeUsernameValidator`)를 모두 식별한다. localization 노력 ≈ 0.
2. **픽스(무엇/왜, 올바른 일반화인 이유):** 두 클래스의 `regex` 끝 앵커 `$`를 `\Z`로 교체. `$`는 후행 단일 `\n`을 허용하지만 `\Z`는 절대 문자열 끝에만 매치 → 끝-개행 클래스 전체를 닫는다. 이것이 "후행 newline 거부"라는 의도된 스펙의 올바른 일반화이며, 특정 테스트 문자열에 매달린 special-case가 아니다. **두 validator 모두** 고쳐야 함(둘 다 같은 버그 regex 공유).
3. **Regression 안전:** valid username(`'glenn'`, `'GLEnN'`, `'jean-marc'`, unicode 정상 이름)은 `\Z` 하에서도 그대로 통과 — `\Z`는 정상 문자열의 끝에 정확히 매치하므로 정당한 입력을 거부하지 않는다. PASS_TO_PASS의 password validator 19개는 이 regex와 독립이라 영향 없음. 시작 앵커 `^`를 건드리지 않음으로써 선행 동작도 불변.
4. **함정 회피:** (a) **단일 validator만 수정** — ascii만 또는 unicode만 고치면 다른 쪽 FAIL_TO_PASS가 RED로 남는다. 반드시 둘 다. (b) **quirk 미인지로 우회 구현** — `$`가 후행 개행에 매치된다는 사실을 모르면 regex를 그대로 두고 `clean`/별도 `.endswith('\n')` 가드를 덧대는 비표준·취약한 픽스로 샐 수 있다(스펙은 regex 차원의 거부를 의도). (c) **`re.MULTILINE` 오해** — 이 버그는 MULTILINE과 무관(기본 모드에서도 발생)하므로 플래그를 만지면 오답. 올바른 해법은 앵커 자체(`$`→`\Z`) 교체. 이슈 권장 `\A...\Z`로 시작까지 바꿔도 동작·테스트는 동일하므로 골드와 diff가 달라도 FAIL_TO_PASS/PASS_TO_PASS는 전부 그린(채점 영향 없음).
