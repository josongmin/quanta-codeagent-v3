---
instance_id: django__django-14539
repo: django/django
base_commit: 6a5ef557f80a8eb6a758ebe99c8bb477ca47459e
version: 4.0
difficulty: <15 min fix
created_at: 2021-06-19T11:31:16Z
fail_to_pass: 2
pass_to_pass: 14
gold_files: [django/utils/html.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Gen
flags: [has-repro]
---

# django__django-14539

## 문제 요약
`urlize()`가 HTML 엔티티(`&lt`)를 포함한 URL 끝의 후행 구두점을 잘라낼 때, 검출은 엔티티가 해제된 문자열에서 하면서 slice는 원본(엔티티가 살아있는) 문자열에 적용해 잘못된 글자 수를 잘라낸다. `urlize('Search for google.com/?q=1&lt! and see.')`에서 `lt`가 링크 밖으로 새어나가 `...&lt</a>lt!`처럼 `lt`가 중복 출력된다. 기대값은 후행 `!`만 trail로 빠진 `...&lt</a>! and see.`이다. problem_statement에 실행 가능한 1-liner repro와 expected/actual 출력이 모두 들어 있다.

## 유형 (정형화)

**L = L0 (Pinpointed).** problem_statement가 `urlize()`라는 함수명과 "html escaped string", "trailing punctuation"을 직접 지목한다. `django/utils/html.py`의 `urlize` → 내부 `trim_punctuation` → `TRAILING_PUNCTUATION_CHARS` `rstrip` 블록으로 grep 한 방에 수렴한다. cross-module 추적 불필요, 단일 파일·단일 분기.

**S = S2 (Constraint-Reasoning).** 고칠 위치는 명확하지만 픽스가 기계적이지 않다. None-가드/상수변경 같은 템플릿 매칭(S1)이 아니라, "검출 좌표계(unescaped)와 slice 좌표계(escaped 원본)가 다르다"는 **불변식을 추론으로 합성**해야 한다. 올바른 식 `punctuation_count = len(middle_unescaped) - len(stripped)`는 두 문자열 길이 차이가 곧 trim할 구두점 개수라는 관계를 따져야 나온다. test-feedback으로 후보를 난사(S3/S4)하는 게 아니라 "생각으로" 푸는 SemFix 계열이다. K-Gen 일반 추론으로 충분하므로 secondary 불필요.

**K = K-Gen (General).** django 프레임워크 내부지식(ORM/query-compiler/migrations)이 아니라 `html.unescape`/문자열 인덱싱이라는 표준 파이썬 의미만 알면 된다. `trim_punctuation`이 django 함수일 뿐 도메인 추론은 일반적이다.

**Primary type = T-ConstraintReason.** 위치는 자명(L0)하나 픽스가 S1 기계 매핑이 아닌 S2 식-합성이라 T-DirectMap이 아니다. 진짜 난점이 "어디"가 아니라 "올바른 인덱스 식을 어떻게 도출하느냐"에 있어 T-ConstraintReason이 dominant. overfit 위험(S4)도 design 변경(S6)도 아니다.

## 난이도 티어

**Tier = T3 (중간).** 공식 라벨은 `<15 min fix`(T1~T2 prior)지만 한 단계 올린다. 미는 피처:
- **L0 + 단일파일 ≤5줄 + has-repro**는 T1/T2 쪽으로 당긴다(easiness 신호 강함, repro 해결률 ~87%).
- 그러나 strategy가 **S2 constraint-reasoning**이다. "escaped 문자열이 unescaped보다 길다 → `len(stripped)`를 원본 인덱스로 쓰면 좌표계가 어긋난다"는 인과를 못 잡으면 픽스가 안 나온다. 이 추론 부담이 순수 S1 트리비얼과 구별되는 지점이라 T2에서 T3로 민다.
- regression-trap은 약하다(P2P 14개지만 모두 `test_html.py` 내 인접 유틸이라 `trim_punctuation` 음수-인덱스 리라이트가 깰 표면이 좁다). underspecified도 아니다(repro+expected 명시).

공식 "개발자 15분"은 정답을 아는 코어 개발자 기준이고, 오라클 없는 에이전트는 좌표계 불일치 조건(엔티티가 1자 아닐 때만 깨짐)을 놓쳐 헛돌 수 있으므로 구조적으로 T3가 방어 가능하다. L0·repro 때문에 T4까지 올리지는 않는다.

## 골드패치 분석

- **건드린 파일·함수:** `django/utils/html.py` — `urlize()` 내부 클로저 `trim_punctuation()`의 후행(trailing) 구두점 처리 분기.
- **근본 원인:** 후행 구두점은 `middle_unescaped = html.unescape(middle)`에서 `rstrip(TRAILING_PUNCTUATION_CHARS)`로 검출한다. 즉 검출 좌표계는 **엔티티 해제된** 문자열이다. 그런데 기존 코드는 slice를 원본 `middle`(엔티티 `&lt`가 3자로 살아있는 문자열)에 적용하면서 인덱스를 `len(stripped)`(unescaped 좌표)로 계산했다. 두 문자열 길이가 다르므로(`&lt`=3 → `<`=1) 경계가 밀려 `lt`가 trail로 빠지지 않고 링크 텍스트에도 남고 trail에도 새는 중복이 발생한다.
- **수정 요지:** 잘린 구두점 **개수**를 좌표계-불변량으로 환산한다. `punctuation_count = len(middle_unescaped) - len(stripped)` (둘 다 unescaped 좌표라 차이는 안전). 그 다음 원본 `middle` 끝에서 그 개수만큼만 음수 인덱스로 분리한다: `trail = middle[-punctuation_count:] + trail`, `middle = middle[:-punctuation_count]`. unescaped 길이를 원본 인덱스에 직접 섞던 기존 `middle[len(stripped):]` / `middle[:len(stripped) - len(middle_unescaped)]`을 폐기. 가정은 "trim 대상 구두점은 모두 ASCII 1자라 unescaped 개수 = 원본 끝 글자 개수"이며 `TRAILING_PUNCTUATION_CHARS`가 `.,:;!` 등 ASCII이므로 성립한다.

## 검증 (test_patch)

- **FAIL_TO_PASS (2):** `test_urlize (utils_tests.test_html.TestUtilsHtml)`, `test_urlize_unchanged_inputs (utils_tests.test_html.TestUtilsHtml)`.
- **픽스 증명:** test_patch가 `test_urlize` 케이스 테이블에 `('Search for google.com/?q=1&lt! and see.', 'Search for <a href="http://google.com/?q=1%3C">google.com/?q=1&lt</a>! and see.')`를 추가한다. 버그 상태에서는 `</a>lt!`(중복 `lt`)가 나와 실패하고, 픽스 후 `</a>!`로 후행 `!`만 trail로 분리되어 통과. `test_urlize_unchanged_inputs`는 trim이 손대면 안 되는 입력을 손상시키지 않는지(불변/멱등)를 함께 잡아 over-trim 회귀를 막는다.
- **overfit 관점:** FAIL_TO_PASS가 2개로 얇지만, 픽스가 "이 입력만 special-case"하는 형태가 아니라 좌표계-불변량(`punctuation_count`)을 도입한 **일반 리라이트**라 S4 overfit 위험은 낮다. `test_urlize`의 다른 케이블(엔티티 없는 URL, `?q=` 등)이 differentiating 입력 역할을 해 special-case 통과를 배제한다. flag에 overfit-risk 미부여.
- **regression 관점:** P2P 14개는 모두 `test_html.py`(escape/strip_tags/smart_urlquote 등)로 `trim_punctuation` 변경이 닿지 않는 인접 유틸이라 regression-trap 약함. 단 `test_smart_urlquote`는 인접 인코딩 경로라 음수-인덱스 변경이 trail 경계를 잘못 옮기지 않는지의 안전망이 된다.

## 모범답안 (오라클 기반)

1. **localize 경로:** problem_statement의 함수명 `urlize` + "trailing punctuation" + "html escaped" 키워드 → `django/utils/html.py`의 `urlize` 클로저 `trim_punctuation` → `TRAILING_PUNCTUATION_CHARS`로 `rstrip`하는 후행 분기. L0이라 grep 한 방. lead 처리 분기(선행 구두점)는 무시하고 trail 분기만 본다.
2. **픽스와 일반화 근거:** 핵심 통찰은 `rstrip`이 `middle_unescaped`(엔티티 해제)에서 일어나는데 slice는 원본 `middle`에 적용된다는 **좌표계 불일치**. 두 좌표계를 섞지 말고 좌표-독립 불변량인 "잘린 구두점 개수" `len(middle_unescaped) - len(stripped)`를 구해, 원본 끝에서 음수 인덱스로 그 개수만큼만 분리한다. 이게 특정 입력 패치가 아니라 임의 엔티티-포함 URL에 대해 성립하는 올바른 일반화인 이유: 구두점이 ASCII 1자라 unescaped 개수와 원본 끝 글자 개수가 1:1 대응한다.
3. **regression 안전:** P2P 14개(`test_escape`, `test_strip_tags`, `test_smart_urlquote`, `test_linebreaks` 등)를 안 깨야 한다 — 이들은 `trim_punctuation` 밖이므로 변경 표면이 좁지만, `test_urlize` 자체의 기존 케이스(엔티티 없는 `google.com/?q=`)가 음수-인덱스 리라이트가 일반 경로를 깨지 않음을 보장한다. `test_urlize_unchanged_inputs`로 over-trim 회귀까지 차단.
4. **함정 회피:** 오라클 없는 에이전트가 틀리는 지점 — (a) 증상만 보고 `html.unescape`/`smart_urlquote` 인코딩 버그로 오진해 엉뚱한 함수를 고침. (b) lead(선행) 구두점 분기와 trail 분기를 혼동해 다른 분기를 패치. (c) escaped가 unescaped보다 길다는 점을 놓쳐 "엔티티가 1자 아닐 때만 깨진다"는 트리거 조건을 못 잡고 재현에 실패. 회피법: `rstrip` 호출의 인자가 `middle_unescaped`인 반면 slice 대상이 `middle`임을 한 줄로 대조하면 좌표계 불일치가 즉시 드러난다 — 음수-인덱스 카운트 리라이트가 정답이다.
