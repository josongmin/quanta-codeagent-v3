# Terminal-Bench 문제 정형화 루브릭 (분석 SSOT)

Terminal-Bench(terminal-bench 데이터셋, 89 task)를 **task별로 까볼 수 있게** 정리하기 위한 분류 루브릭. SWE-bench 계열([../swe-bench-pro-analysis/TAXONOMY.md](../swe-bench-pro-analysis/TAXONOMY.md))과 **성격이 다르다** — TB는 "코드 버그 고치기"가 아니라 **"터미널에서 실제 작업 수행"**(IDE 세션 사이의 일: sysadmin/scripting/데이터/보안/디버그/ML). 그래서 축도 다르다.

> ⚠️ 분석 md는 **solve.sh(정답) 스포일러 포함** — 사람이 task 유형을 빠르게 파악하는 레퍼런스지 에이전트 학습셋 아님. solve.sh엔 canary GUID가 박혀 있음(오염 방지).

> TB의 채점은 SWE-bench와 다르다: **task별 `tests/test_outputs.py`(pytest)가 최종 산출물/파일상태/동작을 검증**하고 reward는 0/1(binary pass). 코드 diff가 아니라 **컨테이너 최종 상태**를 본다.

---

## 축 1 — Category (task.toml, 16종)

task마다 `[metadata].category` 1개. 분포(89):

| category | n | 성격 |
|---|--:|---|
| software-engineering | 26 | 스펙대로 스크립트/프로그램 작성·수정·빌드 |
| system-administration | 9 | 설치/설정/빌드/시스템 상태 조작 |
| security | 8 | 익스플로잇/필터우회/하드닝(적대적 사고) |
| scientific-computing | 8 | 과학/수치 알고리즘 구현 |
| data-science | 8 | 데이터 파이프라인/전처리 |
| file-operations | 5 | 파일 구조 변환/조작 |
| debugging | 5 | 깨진 코드/설정 진단·수정 |
| model-training | 4 | 모델 학습/튜닝 |
| mathematics | 4 | 수학 문제 프로그래밍 |
| data-processing | 4 | 데이터 변환 |
| machine-learning | 3 | ML 태스크 |
| video/personal-assistant/optimization/games/data-querying | 각 1 | 롱테일 |

## 축 2 — Difficulty (task.toml) + 시간추정

`[metadata].difficulty ∈ {easy, medium, hard}` — 분포: **medium 55 · hard 30 · easy 4**.
`expert_time_estimate_min` / `junior_time_estimate_min` = 인간 소요시간 추정(난이도 proxy, 30~수백 분).

## 축 3 — Skill-class (파생, cross-category)

category를 가로지르는 **실제 필요 역량** 1급 축(분석자가 solve.sh+instruction 보고 부여):

| skill_class | 정의 | 대표 category |
|---|---|---|
| `CODE-AUTHOR` | 스펙 받아 스크립트/프로그램을 **새로 작성** | software-engineering, data-science |
| `DEBUG-FIX` | 깨진 코드/빌드/설정을 **진단·수정** | debugging, system-administration |
| `SYSADMIN` | 설치/설정/컴파일/시스템상태 (코드 아님) | system-administration, file-operations |
| `ADVERSARIAL-SEC` | 우회/익스플로잇/하드닝 (적대적) | security |
| `DATA-WRANGLE` | 대용량 데이터 변환/재구조화 | data-processing, data-science |
| `NUMERIC-SCI` | 수치/과학/수학 알고리즘 구현 | scientific-computing, mathematics |
| `ML-TRAIN` | 학습/튜닝/추론 파이프라인 | model-training, machine-learning |

## 축 4 — Terminal-nativeness (`terminal_native ∈ {low, med, high}`)

**TB의 정체성 축.** 이 task가 얼마나 "진짜 터미널 작업"이냐 vs "터미널에서 도는 순수 코딩":
- `low` = 사실상 코딩 문제(파일 하나 스펙대로 작성, 터미널은 실행판일 뿐) → SWE-스캐폴드와 겹침.
- `med` = 코드 + 환경/도구 셋업(uv venv, deps, 빌드) 결합.
- `high` = 시스템 상태/멀티스텝 셸/비대화형 도구/장시간 프로세스가 본질(sysadmin, 빌드, ML 학습) → **quanta 터미널 서피스의 진짜 시험대**.

## 축 5 — Interaction-shape

`one-shot`(스크립트 하나 떨구면 끝) · `iterate`(빌드→테스트→수정 루프 필요) · `multi-file`(여러 산출물 조율) · `long-running`(verifier/agent timeout이 큼, ML 학습 등 최대 3600s).

---

## per-task md 표준 포맷 (모든 task 동일)

frontmatter(task/category/difficulty/tags/시간/skill_class/terminal_native/docker_image) + 5 섹션:
1. **Goal** — 1-2줄, 에이전트가 뭘 달성해야 하나(instruction 요약).
2. **Solution shape** — solve.sh가 하는 것(접근/핵심도구/산출파일수/대략 LOC).
3. **Verifier** — tests/가 뭘 검증(pytest 산출물/파일해시/동작).
4. **Difficulty drivers** — 왜 이 난이도(도메인지식? 멀티스텝? env/deps? 적대적? 장시간?).
5. **quanta attack points** — 필요 도구(container_exec/pty)·실패 리스크·"exit-code 루프/테스트-until-green" 스캐폴드가 먹히는지.
