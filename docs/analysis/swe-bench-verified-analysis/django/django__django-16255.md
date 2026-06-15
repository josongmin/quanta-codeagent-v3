---
instance_id: django__django-16255
repo: django/django
base_commit: 444b6da7cc229a58a2c476a52e45233001dc7073
version: "4.2"
difficulty: <15 min fix
created_at: 2022-11-04T13:49:40Z
fail_to_pass: 1
pass_to_pass: 36
gold_files: [django/contrib/sitemaps/__init__.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

# django__django-16255

## 문제 요약
sitemap이 항목(items)을 하나도 가지지 않지만 callable `lastmod`를 지원하는 경우, sitemap index 렌더링 시 `ValueError: max() arg is an empty sequence`가 발생한다. `Sitemap.get_latest_lastmod()`가 빈 리스트에 `max()`를 호출하기 때문이다. 사용자는 빈 sitemap이라면 단순히 `Last-Modified`가 없는(=None) 정상 응답을 기대한다. problem_statement에 전체 traceback과 후보 해법까지 포함되어 있다.

## 유형 (정형화)
- **L0 (Pinpointed)** — problem_statement가 네이티브 traceback을 그대로 제공해 `django/contrib/sitemaps/__init__.py", line 170, in get_latest_lastmod` / `return max([self.lastmod(item) for item in self.items()])`로 파일·함수·라인을 직접 지목한다. 탐색 거의 0, grep 한 방.
- **S1 (Direct-Map / template)** — 정형 결함클래스 "빈 컬렉션에 대한 reduce(max) 미가드"에 그대로 매칭된다. 픽스는 기계적: `max(...)`에 `default` 인자 추가 또는 except 절 확장. 이슈 본문과 메인테이너 힌트("default argument of max() can be used")가 사실상 픽스를 명세한다. 추론으로 식을 합성할 필요(S2)도, 후보를 반복 선택할 필요(S3/S4)도 없다.
- **K-Gen (General)** — 빈 시퀀스에서 `max([])`가 ValueError를 던진다는 것은 순수 파이썬 표준 라이브러리 지식이다. django ORM/query-compiler 같은 프레임워크 내부지식 불필요. sitemap이라는 도메인은 표면적 맥락일 뿐 픽스 추론에 기여하지 않는다.
- **primary type = T-DirectMap** — 위치가 명확(L0)하고 픽스가 정형 결함클래스에 대한 기계적 가드(S1)다. T-LocTrivial(=T1 프로파일)과의 경계에 있으나, 두 갈래 해법 중 골드가 `default=None`을 택한 점·callable 분기 한정 적용이라는 약한 판단이 끼어 T-DirectMap이 더 정확하다.

APR 관점: 이건 PAR/TBar식 **fix-pattern template matching**의 교과서 사례다. "reduce-over-possibly-empty-iterable → ValueError" 결함 패턴 ↔ "supply identity/default" 수리 패턴의 1:1 매핑이라 SemFix류 의미추론이 불필요하다.

## 난이도 티어
**T2 (쉬움).** 공식 라벨도 `<15 min fix`로 일치한다.

이 티어로 미는 구조적 피처:
- **단일 파일·단일 라인** 수정(`max([...])` → `max([...], default=None)`). gold scope = 1파일 1헌크 1줄 → 구조적 컷(1파일·<5줄 ≈ 48% solve)의 최상단.
- **has-repro** — 네이티브 traceback + 후보 패치 제공(가장 강한 easiness 신호, repro 존재 시 해결률 ~87%).
- **L0 localize** — 탐색 노력 0.

T1(존나쉬움)이 아니라 T2인 이유: (1) 두 가지 정당한 해법 분기(except에 ValueError 추가 vs `default=None`)가 존재해 "이슈가 픽스를 그대로 적어줌"의 완전 자명성에서 한 칸 내려온다. (2) **regression-trap** — PASS_TO_PASS가 36개로 sitemap/Last-Modified 인접 동작(헤더 포함/생략, i18n index, cached index, non-callable lastmod 등)을 폭넓게 커버한다. callable 분기에만 가드를 좁게 넣지 않고 `else` 분기나 except 절을 광범위하게 건드리면 이 인접 동작들을 깰 수 있다. 단 이 trap은 골드 픽스가 callable 분기 내부 한 줄에 국한되므로 실제로는 회피가 쉬워 T3까지 올리지는 않는다.

## 골드패치 분석
- **건드린 파일/함수:** `django/contrib/sitemaps/__init__.py` : `Sitemap.get_latest_lastmod`
- **근본 원인:** `callable(self.lastmod)` 분기에서 `self.items()`가 빈 시퀀스를 반환하면 리스트 컴프리헨션 `[self.lastmod(item) for item in self.items()]` 결과가 `[]`가 되고, `max([])`는 `ValueError: max() arg is an empty sequence`를 던진다. 기존 `try/except TypeError`는 lastmod 값들이 서로 비교 불가능한 타입일 때(예: date vs None 혼재)의 `TypeError`만 잡고, **빈 시퀀스의 ValueError는 잡지 못한다.** 그래서 index 뷰(`views.index → site.get_latest_lastmod()`)에서 500이 난다.
- **수정 요지:** `max(...)` 호출에 `default=None` 인자를 추가해 빈 시퀀스일 때 예외 대신 `None`을 반환하도록 했다. `return max([self.lastmod(item) for item in self.items()])` → `return max([self.lastmod(item) for item in self.items()], default=None)`. problem_statement의 대안(`except (TypeError, ValueError)`) 대신 메인테이너 힌트를 따라 의도가 코드에 드러나는 `default=None`을 택했다 — "빈 경우 lastmod 없음(None)"이 상위 호출부 계약과 정확히 일치한다.

## 검증 (test_patch)
- **FAIL_TO_PASS:** `test_callable_sitemod_no_items (sitemaps_tests.test_http.HTTPSitemapTests)` — items가 비어있는 callable-lastmod sitemap의 index가 예외 없이 렌더링되는지 검증.
- **픽스 증명 방식:** `tests/sitemaps_tests/urls/http.py`에 `CallableLastmodNoItemsSitemap`(`items()`가 `[]` 반환, callable `lastmod(self, obj)` 보유)을 추가하고 `/callable-lastmod-no-items/index.xml` 경로(`callable_lastmod_no_items_sitemap` dict + `views.index`)를 등록한다. 테스트는 이 URL을 GET하여 (1) 응답에 `Last-Modified` 헤더가 **없음**(`assertNotIn("Last-Modified", index_response)`)과 (2) sitemapindex XML이 기대값과 일치함(`assertXMLEqual`)을 확인한다. 픽스 전에는 `get_latest_lastmod()`가 ValueError를 던져 500이 나므로 응답 자체를 받지 못해 FAIL.
- **overfit 관점:** FAIL_TO_PASS는 1개로 얇지만, 결함클래스가 "빈 시퀀스 max"라는 단일 차원이고 `default=None`은 빈/비빈 입력공간 전체를 올바르게 커버하는 일반해다. special-case 우회(예: `if not self.items()` 분기 추가)로도 통과 가능하나, 골드는 그보다 더 일반적이고 표준적이다. overfit-risk 낮음 → 플래그 미부여.
- **regression 관점:** PASS_TO_PASS 36개가 callable lastmod 정상 케이스(`test_callable_sitemod_full`), 비-callable lastmod, 헤더 포함/생략, i18n/cached/paged index 등을 광범위 커버한다. `default=None`은 비-빈 시퀀스의 `max` 결과를 바꾸지 않으므로(빈 경우만 None) 이들 전부 그대로 통과한다. regression-trap 플래그 유효하나 골드 픽스 자체는 안전.

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement의 traceback 마지막 프레임(`__init__.py", line 170, in get_latest_lastmod` + `return max([...])`)과 예외 메시지(`max() arg is an empty sequence`)가 파일·함수·결함 라인을 직접 지목한다. `get_latest_lastmod`만 열어 callable 분기의 `max(...)` 호출 한 줄을 본다. L0, 탐색 불필요.
2. **픽스와 일반화 근거:** `max([...])` → `max([...], default=None)`. 빈 sitemap의 의미상 정답은 "최신 lastmod 없음 = None"이고, 이는 `get_latest_lastmod`가 이미 다른 경로에서 반환하는 값(`if not hasattr(self, "lastmod"): return None`)과 일관된다. `default=None`은 빈 입력 한 케이스만 다루고 나머지(≥1 item)는 기존 `max` 의미를 보존하므로 special-case가 아닌 올바른 일반화다. except 절 확장(`(TypeError, ValueError)`)도 통과하지만 ValueError를 "비교불가 타입"과 한 바구니로 묶어 의도가 흐려지므로 차선.
3. **regression 안전:** 깨지 말아야 할 P2P — `test_callable_sitemod_full`(비-빈 callable lastmod의 정확한 max), "The Last-Modified header is set to the most recent sitemap lastmod", "sitemapindex.lastmod is included/omitted ..." 등 헤더 포함/생략 로직. 가드를 callable 분기 안 `max` 호출에만 좁게 넣어 `else: return self.lastmod`(비-callable, 빈 items 무관) 분기를 건드리지 않으면 전부 안전하다.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) except 절을 `except Exception`처럼 과도하게 넓혀 진짜 버그(비교불가 lastmod)를 삼키는 과잉 수정, (b) `else` 분기나 `items()` 호출부를 불필요하게 리팩터해 인접 P2P를 깨는 것, (c) `get_latest_lastmod`가 아닌 호출부(`views.index`)에 None 가드를 덧대 위치를 잘못 잡는 것. 회피법: traceback이 지목한 정확한 한 줄에만, 결함클래스(empty-max)에 맞는 최소 가드(`default=None`)를 적용. test_patch가 URL conf + 새 Sitemap 클래스를 요구하나 그건 채점 측 적용분이고, 코드 패치는 `__init__.py` 한 줄로 충분함을 인지한다.
