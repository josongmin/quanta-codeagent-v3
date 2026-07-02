# Round-1 탄약: "insertion → higher score" 인과 vs 상관 분리용 정량 테이블

작성일 2026-07-01. 3-라운드 적대 어딧의 Round-1 (데이터 어셈블리). 이후 라운드가 쓸 per-instance resolved 테이블을 구축한다.
데이터 출처: `/Users/songmin/quanta-codeagent-v3/.extracted_source/repro-scaffolds/` + ETH SRI 서버(`https://files.sri.inf.ethz.ch/swt-bench/`).
**벤치마크는 SWT-bench Verified** (테스트 생성/재현 벤치, SWE-bench 아님). "resolved"는 SWT-bench harness가 gold patch에 대해 fail-to-pass + coverage delta 기준으로 매긴 라벨.

---

## STEP 1 — 누락 evaluation 페치 결과

ETH 서버를 훑어 다음을 확보:

| 시스템 | per-instance resolved 확보? | 출처 | model (scaffold 태그 기준) |
|---|---|---|---|
| e-Otter++ | YES | local `eotter_plus_verified.evaluation.json` | `claude_e_otter_plus` → **Claude (Sonnet 계열)** |
| AssertFlip | YES | local `assertflip_verified.evaluation.json` | `AssertFlip` (**CoverUp 기반**, 실제 LLM 미상) |
| ReProAgent | YES | local `ReProAgent.repro_agent_gpt_5_mini_verified.json` | **gpt-5-mini** (디렉토리/파일명 명시) |
| OpenHands | YES (**신규 페치**) | `openhands_gpt5/gpt-5-mini/evaluation_results.json` | **gpt-5-mini** |
| L*Agent | **NO** | inference 예측만 (`lstar_agent_verified.json`, model=`logic_star_ai`) | Internal/미상 |
| TEX-T | **NO** | 예측만 (`tex-t_..._verified.jsonl`, model=`TEX-T Claude 4 Sonnet`) | **Claude 4 Sonnet** |

**핵심 한계 (어딧에 박아둘 것):**
- L*Agent / TEX-T는 서버 어디에도 packaged evaluation JSON이 없다. `run_instance_swt_logs/swt-verified/{lstar_agent_verified.zip, tex-t_verified.zip}` (raw grading 로그)만 존재 → resolved 라벨을 얻으려면 **SWT-bench harness report 로직을 재구현**해야 함 (test_output.txt의 fail-to-pass + coverage delta 재채점). raw 로그는 받아뒀으나(`/tmp/lstar_logs.zip`, `/tmp/text_logs.zip`) Round-1 범위에서 재채점은 안 함 — 잘못 재구현하면 신뢰 불가. **따라서 L*Agent/TEX-T는 이 어딧에서 정량 비교 불가.**
- `resolved_per_approach.json` (서버 루트)는 **lite** 서브셋 leaderboard (AssertFlip 99건 등)라 verified 측정과 불일치 → 사용 안 함.

---

## STEP 2.1 — Integration style × resolved (시스템 내부)

각 시스템 패치를 diff 파싱으로 분류 (insert = 기존 test 파일에 in-place 추가, new-file = `--- /dev/null`/`new file mode`로 신규 테스트 파일 생성).

| 시스템 | model | total | resolved | rate | 스타일 분포 |
|---|---|---|---|---|---|
| e-Otter++ | Claude | 432 | 263 | **60.9%** | insert 432/432 (100%) |
| AssertFlip | CoverUp/? | 326 | 188 | **57.7%** | new-file 326/326 (100%) |
| ReProAgent | gpt-5-mini | 431 | 303 | **70.3%** | new-file 431/431 (100%) |
| OpenHands | gpt-5-mini | 464 | 267 | **57.5%** | (패치 미보유, eval만) |

**가장 깨끗한 within-system 테스트(insert vs new-file를 한 시스템 안에서)는 불가능하다.**
e-Otter는 100% insert (new-file 0건), AssertFlip·ReProAgent는 100% new-file (insert 0건). 즉 어느 단일 시스템도 두 스타일을 모두 쓰지 않는다 → 스타일 효과를 시스템(=model+scaffold) 효과에서 분리할 within-system lever가 **이 데이터셋엔 존재하지 않음**. (L*Agent eval을 못 얻었으므로 그쪽으로도 못 메움.) 모든 스타일 비교는 cross-system이며, 따라서 **method와 model+scaffold가 교란(confound)됨.**

---

## STEP 2.2 — Head-to-head contingency (공통 instance, discordant 양방향)

공통으로 채점된 instance에서 한쪽만 resolved한 discordant 쌍을 양방향으로 카운트. McNemar exact two-sided p 동봉.

| 대결 (스타일) | common | both-pass | A-only | B-only | both-fail | net A | McNemar p |
|---|---|---|---|---|---|---|---|
| e-Otter++(insert) **A** vs AssertFlip(new-file) **B** | 325 | 154 | **65** | **33** | 73 | **+32** | 1.6e-3 |
| e-Otter++(insert) **A** vs ReProAgent(new-file) **B** | 430 | 226 | **35** | **76** | 93 | **-41** | 1.3e-4 |
| AssertFlip(new-file) **A** vs ReProAgent(new-file) **B** | 324 | 161 | 25 | 81 | 57 | -56 | 4.5e-8 |
| e-Otter++(insert) **A** vs OpenHands(new-file) **B** | 400 | 184 | 58 | 62 | 96 | -4 | 0.78 (ns) |
| ReProAgent(new-file) **A** vs OpenHands(new-file) **B** | 399 | 209 | 75 | 36 | 79 | +39 | 2.7e-4 |

**해석 (인과 반증):**
- insert 시스템(e-Otter)이 new-file 시스템을 **체계적으로 이기지 않는다.** 한 new-file 시스템(AssertFlip)은 유의하게 지지만(+32), 다른 new-file 시스템(ReProAgent)에는 유의하게 **진다(-41).** OpenHands(new-file)와는 무승부(p=0.78).
- new-file끼리도 갈린다: ReProAgent ≫ AssertFlip (-56), ReProAgent ≫ OpenHands (+39). 셋 다 new-file인데 결과가 천차만별 → **스타일이 아니라 시스템(model+scaffold)이 변동을 지배.**
- 즉 "insertion이 점수를 올린다"는 **방향이 일정하지 않으므로 인과 신호 아님.** insert를 쓰는 e-Otter가 best도 아니다 (best는 new-file의 ReProAgent, 70.3%).

---

## STEP 2.3 — Repo-stratified resolved-rate (핵심 confound 테스트)

per (system × repo) resolved율. insert 우위가 같은 repo 안에서 살아남는가?

| repo | e-Otter++(insert) | AssertFlip(nf) | ReProAgent(nf) | OpenHands(nf) |
|---|---|---|---|---|
| astropy | 10/17=59% | 13/16=81% | 12/16=75% | 14/22=64% |
| django | 130/215=60% | 81/138=59% | **160/216=74%** | 132/231=57% |
| matplotlib | 24/32=75% | 19/29=66% | 23/32=72% | 25/34=74% |
| seaborn | 0/2=0% | 0/2=0% | 0/2=0% | 1/2=50% |
| flask | 1/1=100% | 0/1=0% | 0/1=0% | 1/1=100% |
| requests | 2/4=50% | 3/4=75% | 3/4=75% | 2/7=29% |
| xarray | 10/15=67% | 10/14=71% | 10/15=67% | 20/22=91% |
| pylint | 4/6=67% | 3/5=60% | 2/5=40% | 3/9=33% |
| pytest | 9/15=60% | 3/12=25% | **11/15=73%** | 6/18=33% |
| scikit-learn | 20/24=83% | 16/24=67% | 22/24=92% | 22/26=85% |
| sphinx | 5/28=18% | 6/20=30% | 6/28=21% | 7/39=18% |
| sympy | 48/73=66% | 34/61=56% | 54/73=74% | 34/53=64% |
| **OVERALL** | **263/432=61%** | **188/326=58%** | **303/431=70%** | **267/464=58%** |

**repo가 압도적 lever다.** 어느 시스템이든 sphinx ~18-30%, scikit ~67-92%. repo 내부 격차(시스템 간)는 repo 간 격차보다 작다. insert 시스템(e-Otter)이 repo별로 일관되게 1등인 repo는 없다 — django/sympy/pytest 등 큰 repo에선 오히려 ReProAgent(new-file)가 e-Otter(insert)를 능가.

### 2.3b — e-Otter++(insert) vs ReProAgent(new-file): within-repo discordant

repo로 통제하면 insert 우위가 사라지는가? (둘 다 채점된 공통 instance만)

| repo | both | eOtter-only | repro-only | bothFail | net eOtter |
|---|---|---|---|---|---|
| astropy | 9 | 0 | 3 | 4 | -3 |
| django | 114 | 16 | 45 | 40 | **-29** |
| matplotlib | 19 | 5 | 4 | 4 | +1 |
| flask | 0 | 1 | 0 | 0 | +1 |
| pylint | 2 | 1 | 0 | 2 | +1 |
| pytest | 8 | 1 | 3 | 3 | -2 |
| requests | 2 | 0 | 1 | 1 | -1 |
| scikit | 20 | 0 | 2 | 2 | -2 |
| sphinx | 2 | 3 | 4 | 19 | -1 |
| sympy | 40 | 8 | 14 | 11 | **-6** |
| **TOTAL** | **226** | **35** | **76** | **93** | **-41** |

**repo로 통제해도 insert(e-Otter)는 net으로 **진다** (-41, 거의 모든 repo에서 ≤0).** insert 우위는 repo 내부에서 살아남기는커녕 존재하지 않는다. 따라서 STEP 2.2의 e-Otter > AssertFlip(+32)은 **repo 분포 + AssertFlip 자체 약함의 산물이지 insert의 인과 효과가 아님.**

---

## STEP 2.4 — Model confound flag (명시)

| 시스템 | 스타일 | model (확신도) |
|---|---|---|
| e-Otter++ | insert | Claude Sonnet 계열 (scaffold 태그 `claude_e_otter_plus`; 정확한 버전 미확정) |
| AssertFlip | new-file | CoverUp 기반 파이프라인 (underlying LLM 로컬 메타에 미명시) |
| ReProAgent | new-file | **gpt-5-mini** (명시) |
| OpenHands | new-file | **gpt-5-mini** (명시) |
| L*Agent | (미상, 예측만) | Internal `logic_star_ai` |
| TEX-T | (미상, 예측만) | Claude 4 Sonnet |

**모든 cross-system 비교는 method(integration style) + model + scaffold-logic을 한꺼번에 섞는다.** 같은 gpt-5-mini를 쓰는 ReProAgent(70.3%)와 OpenHands(57.5%)가 12.8%p나 벌어진다 → **같은 model·같은 new-file 스타일인데도 scaffold가 12.8%p를 만든다.** 이는 "integration style 효과"라고 주장될 수 있는 어떤 cross-system 격차보다도 크다. 즉 관측된 모든 격차는 model+scaffold로 충분히 설명되며 insert/new-file 축은 독립적 신호를 남기지 않는다.

---

## 데이터가 증명할 수 있는 것 / 없는 것

**증명 가능:**
- insert가 new-file을 체계적으로 이긴다는 주장은 **반증된다.** 방향이 시스템마다 뒤집힘(e-Otter +32 vs AssertFlip, -41 vs ReProAgent), repo 통제 후 net -41.
- 변동의 지배 인자는 **repo(난이도)**, 그 다음 **scaffold/model**. integration style은 잔차 신호를 못 남김.
- 같은 model(gpt-5-mini)·같은 스타일(new-file)에서도 scaffold만으로 12.8%p 격차 → style은 결정 인자가 아님.

**증명 불가:**
- **순수 integration-style 인과 효과** — within-system insert-vs-new-file 케이스가 0건이라 측정 자체가 불가능. (L*Agent eval을 못 얻어 메우지 못함.)
- L*Agent/TEX-T 정량 비교 — packaged resolved 없음(재채점 필요, 미수행).
- model 정확 버전(e-Otter Claude 버전, AssertFlip LLM) 불확실 → model confound를 정밀 분해 불가.
