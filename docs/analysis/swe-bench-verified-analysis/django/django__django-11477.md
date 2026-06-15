---
instance_id: django__django-11477
repo: django/django
base_commit: e28671187903e6aca2428374fdd504fca3032aee
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-06-14T17:40:45Z
fail_to_pass: 3
pass_to_pass: 151
gold_files: [django/urls/resolvers.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-11477

## 문제 요약
URL 패턴에 optional named group(예: `(?:(?P<optional>...))?`)이 있고, 실제 URL에서 그 그룹이 매칭되지 않으면 `translate_url()`이 잘못된 URL을 생성한다. resolve가 캡처 안 된 optional 그룹을 `None`으로 반환하는데, 이후 reverse 경로에서 그 `None`이 `force_text()`를 거쳐 literal 문자열 `'None'`으로 강제 변환되면서 resolve와 reverse 사이에 비대칭이 생긴다. 사용자는 optional 인자가 없을 때 원래 URL 그대로 번역되길 기대했지만, `set_language`로 언어를 바꾸면 `'None'`이 박힌 깨진 URL로 인해 404가 발생한다. hints_text에 재현 테스트케이스와 원인 진단(resolve/reverse 비대칭)이 모두 들어 있다.

## 유형 (정형화)
- **L1 (Traceable)** — problem_statement는 `translate_url()`만 지목하지만, hints_text가 "resolve() returns None for optional capture groups that aren't captured / asymmetry between resolve() and reverse()"라고 진단하고 `django.urls.resolvers`를 명시한다. i18n 레이어가 아니라 resolver 매칭 단계로 좁혀지는 단일파일 후보. grep 한 방(L0)은 아니고, "왕복(round-trip)" 인과를 한 단계 추적해야 하므로 L1.
- **S2 (Constraint-Reasoning)** — 픽스는 1줄이지만 그 1줄은 기계적 None-가드가 아니라 "어떤 불변식을 회복해야 하는가"의 추론 산물이다. resolve→reverse 왕복 대칭성이라는 불변식, 그리고 바로 아래 `args = () if kwargs else match.groups()` 분기와의 상호작용(필터 후 kwargs가 비면 positional fallback이 작동)을 따져야 올바른 식 `{k: v for k, v in match.groupdict().items() if v is not None}`이 나온다. 후보를 마구 던져 테스트로 거르는 G&V(S3)가 아니라 "생각으로" 합성하는 SemFix/Angelix 계열. hints가 reverse 쪽(`_reverse_with_prefix`)을 제안했는데 골드는 match 쪽(source)을 고친 점도, 단순 템플릿 매칭(S1)이 아니라 "어디서 None을 제거하는 게 올바른가"의 판단이 필요했음을 보여준다.
- **K-Domain** — django URL dispatcher 내부 모델(`RegexPattern.match`가 `groupdict()`로 kwargs를 만들고, named group 유무로 args/kwargs를 가르며, reverse가 `force_text`로 인자를 직렬화하는 파이프라인)을 알아야 한다. 일반 파이썬 추론(K-Gen)만으론 "1줄 None 필터가 왜 정답인지"를 정당화 못 한다.
- **primary = T-ConstraintReason** — 위치는 hints 덕에 비교적 명확하나(따라서 T-DiffuseLoc 아님), 본질 난점은 올바른 조건식을 불변식 추론으로 합성하는 데 있다(S2 dominant). 정형 결함클래스 템플릿(S1)으로 자동매칭되지 않으므로 T-DirectMap도 아니다.

## 난이도 티어
**T3 (중간).** 구조적 피처:
- **단일 파일·1줄 수정** (`django/urls/resolvers.py` 한 헌크) → scope는 T1~T2급으로 작다.
- **has-repro** — hints_text에 재현 패턴과 기대 동작이 적혀 있어 easiness 신호가 강하다.
- 그러나 **localize가 L1**(증상 함수 ≠ 수정 함수; round-trip 인과 추적 필요)이고 **repair가 S2**(불변식 추론 + 인접 분기와의 상호작용 이해)라 T1/T2의 "찾으면 끝, 픽스 자명" 프로파일을 넘어선다.
- **regression-trap** — PASS_TO_PASS 151개가 거의 전부 URL resolve/reverse/namespace/i18n 동작이다. `groupdict()` 결과를 손대므로, None이 아닌 빈 문자열 캡처나 positional fallback 경로를 잘못 건드리면 대량 회귀가 난다. 넓은 P2P trap이 T3 상단으로 민다.

공식 라벨("15 min - 1 hour")과 정합한다. 공식 라벨은 위치만 맞으면 1줄이라 개발자 구현시간이 짧음을 반영하지만, 에이전트 관점에서는 (a) 증상 문구가 가리키는 i18n 레이어로 오도될 위험과 (b) S2 추론 부담 때문에 T2가 아닌 T3로 본다.

## 골드패치 분석
- **건드린 파일/함수:** `django/urls/resolvers.py` — `RegexPattern.match(self, path)` (153번째 줄 근처).
- **근본 원인:** `match.groupdict()`는 정규식의 **모든** named group을 반환한다. 매칭되지 않은 optional group은 키는 존재하되 값이 `None`이다. 이 `None`이 kwargs에 그대로 실려 `ResolverMatch`까지 전파되고, reverse 시 `force_text(None)` → `'None'`으로 직렬화되어 resolve/reverse 비대칭(round-trip 깨짐)을 유발했다. 이 비대칭이 `translate_url()`/`set_language`에서 잘못된 URL → 404로 드러난다.
- **수정 요지:** kwargs를 구성할 때 값이 `None`인 항목을 걸러낸다.
  ```python
  kwargs = {k: v for k, v in match.groupdict().items() if v is not None}
  ```
  바로 다음 줄 `args = () if kwargs else match.groups()` 로직 덕분에: optional 그룹만 빠지고 다른 named group이 남으면 여전히 kwargs 경로를 타고, named group이 하나도 안 잡히면 positional args로 fallback한다. hints가 제안한 reverse 쪽(`_reverse_with_prefix`)이 아니라 **매칭 시점(source)에서 `None`을 제거**하는 방향으로 해결해, asymmetry를 발생원에서 봉인했다.

## 검증 (test_patch)
- **FAIL_TO_PASS (3):**
  - `test_re_path_with_optional_parameter` (urlpatterns) — 패턴 `^regex_optional/(?P<arg1>\d+)/(?:(?P<arg2>\d+)/)?` 에 대해 `/regex_optional/1/2/` → `{'arg1':'1','arg2':'2'}`, `/regex_optional/1/` → `{'arg1':'1'}` (arg2가 `None`으로 들어가지 **않음**)을 직접 단언. 픽스의 핵심 동작을 가장 좁게 증명.
  - `test_translate_url_utility` (i18n.patterns) — `with-arguments/(?P<argument>...)/(?:(?P<optional>...).html)?` 패턴에서 optional 부분이 없는 `/en/with-arguments/regular-argument/`가 `'None'` 오염 없이 `/nl/...`로 올바르게 round-trip 번역되는지 확인. 원래 보고된 증상(end-to-end) 회복을 증명.
  - `test_two_variable_at_start_of_path_pattern` — kwargs 필터링이 일반(non-optional) 경로를 깨지 않는지 회귀 보호.
- **픽스 증명:** optional 그룹이 미캡처일 때 kwargs에서 그 키가 아예 빠지므로(`None` 아님), resolve→reverse 왕복이 대칭을 회복하여 입력 URL과 동일한(언어만 바뀐) URL이 재생성된다.
- **overfit 관점:** FAIL_TO_PASS가 unit(`test_re_path...`)과 end-to-end(`test_translate_url...`) 두 층위를 모두 커버하고, `urlpatterns_reverse/tests.py`에 `named_optional_terminated`의 reverse-방향 케이스도 추가되어 resolve/reverse 양방향을 묶는다. special-case 통과가 어렵게 설계되어 overfit 위험은 낮다(따라서 overfit-risk 플래그 미부여).
- **regression 관점:** PASS_TO_PASS 151개가 URL resolve/reverse/namespace/i18n 전반을 광범위하게 덮는다. `groupdict()`를 손대므로 이들이 안전망 역할을 한다 → regression-trap 플래그.

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement의 `translate_url()`만 보면 `i18n/utils.py`로 직행하기 쉽다. 그러나 hints_text의 결정적 단서 — "resolve() returns None for optional capture groups that aren't captured" + "asymmetry between resolve() and reverse()" — 를 잡으면, 증상은 i18n이지만 원인은 **resolver의 매칭이 `None`을 흘리는 것**임이 보인다. `django/urls/resolvers.py`에서 named group을 kwargs로 만드는 `RegexPattern.match`의 `match.groupdict()` 호출부가 single source of truth.
2. **픽스와 왜 올바른 일반화인가:** `groupdict()`에서 값이 `None`인 키를 제거한다. 이는 "optional이 미캡처면 그 인자는 애초에 전달되지 않은 것"이라는 의미론을 발생원에서 강제하는 것 — 특정 입력 URL이 아니라 **모든 optional-group 패턴 + resolve/reverse 왕복**에 대해 대칭을 회복하므로 올바른 일반화다. reverse 쪽에서 `'None'` 문자열을 사후 패치하는 것보다, None이 kwargs에 들어가기 전에 차단하는 쪽이 더 적은 표면적으로 동일 불변식을 보장한다.
3. **regression 안전:** `args = () if kwargs else match.groups()` 분기를 깨지 않는 게 핵심. 다른 named group이 남아 있으면 여전히 kwargs 경로, 전부 None이면 빈 dict가 되어 positional fallback이 그대로 작동한다. PASS_TO_PASS의 `test_re_path`, namespace/include 계열, 그리고 빈 문자열(`''`)을 캡처하는 패턴(빈 문자열은 `is not None`이라 살아남음)을 깨지 않아야 한다 — `if v is not None`(`if v`가 아니라)이 바로 이 빈-문자열 보존을 위한 선택.
4. **함정 회피:** 오라클 없는 에이전트의 전형적 오답 두 가지 — (a) 증상 문구에 끌려 `i18n/utils.translate_url`이나 `set_language` 뷰를 다파일로 헤매는 것(hints를 안 읽으면 빠짐). (b) reverse 쪽에서 `'None'` 문자열을 필터링하거나 `if v`로 falsy 전체를 거르는 것 — 후자는 빈 문자열·`'0'` 같은 유효 캡처를 날려 regression을 유발한다. 정답은 hints의 진단을 따라 매칭 source로 직행하고, falsy가 아니라 정확히 `None`만 제거하는 것.
