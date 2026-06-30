# SWE-bench Pro — 점수 보고·신뢰도 Landscape (2026-06-30)

이 문서는 "SWE-bench Pro 점수를 누가·어떻게 냈고, 그 숫자를 얼마나 믿을 수 있나"의 cross-cutting 정리.
per-instance 골드패치 분석은 [swe-bench-pro-analysis/](swe-bench-pro-analysis/) 별도.

> 작성 맥락: quanta가 자체 Pro 점수를 내고 발표할 때의 전략 근거. 모든 점수는 **조건(스캐폴드·봉인 여부)을 같이 적지 않으면 무의미**하다는 게 결론.
> 출처는 웹리서치(2026-06 기준). confidence는 항목별 표기. 빠르게 churn하는 영역이라 숫자는 시점값.

---

## 0. TL;DR

1. **Pro는 Verified보다 나은 벤치다** (멀티언어·멀티파일·프로덕션 repo). OpenAI도 Verified 오염으로 폐기→Pro 권장. "Pro가 별로다"가 아님.
2. **근데 published Pro 숫자는 부풀려져 있다.** 채점 도커 `.git`에 정답 커밋이 남아(issue #93) 에이전트가 `git show`로 읽고, 웹에서 merged PR도 찾는다. Cursor 측정: 봉인하면 Opus 4.8 Max **87.1→73.0**, 성공의 **63%가 정답을 retrieve**(웹 57% + git 9%).
3. **같은 모델이 조건 따라 흩어진다.** Opus 4.8 = Scale표준 51.9(4.6) ~ Anthropic자체 69.2 ~ Cursor봉인 73.0 ~ Cursor unsealed 87.1. 단일 "Pro 점수"는 못 믿음.
4. **봉인(git strip+인터넷 차단)을 한 곳은 사실상 Cursor 하나.** 아시아(중국 포함) 봉인 Pro = 0.
5. **우리(quanta) solve 박스도 같은 누수 있음** ([dataset.ts](../../src/runner/batch/corpus/dataset.ts) 풀미러 클론). 봉인 안 함.

---

## 1. 세 가지 regime (이걸 안 가르면 다 헷갈림)

| regime | 하네스 | 봉인 | 성격 | 대표 |
|---|---|---|---|---|
| **벤더 자체발표** | 자기 튠 스캐폴드 | ✕ | 제일 부풀림(누수+스캐폴드 섞임) | Anthropic 모델카드, 중국 오픈웨이트 |
| **Scale 표준** | mini-swe-agent / SWE-agent 고정, 250턴 | 부분(?) | 모델 비교용 baseline, 스캐폴드 의존모델엔 불리 | [labs.scale.com](https://labs.scale.com/leaderboard/swe_bench_pro_public) |
| **봉인(sealed)** | 아무거나 + git strip + 인터넷 차단 | ○ | 누수 제거한 진짜 숫자 | Cursor (유일) |

벤더-vs-Scale 갭은 보통 **10~30점**. "Scale보다 10~30 높으면 벤더-스캐폴드 숫자"가 룰 (morphllm).

---

## 2. 최신 점수표 (mid-2026), regime별

### 2-A. 벤더 자체발표 (own scaffold, unsealed) — [llm-stats](https://llm-stats.com/benchmarks/swe-bench-pro) / [morphllm](https://www.morphllm.com/swe-bench-pro), 6/28 갱신
| 모델 | Pro | 비고 |
|---|--:|---|
| Claude Fable 5 = Mythos 5 (같은 weight) | **80.3** | Verified 95. suspend(6/12 export-control). ⚠️Fable/Mythos 별개 아님 |
| Claude Opus 4.8 | 69.2 | Verified 88.6 |
| Claude Opus 4.7 | 64.3 | Verified 87.6 |
| GLM-5.2 (Zhipu/Z.ai) | 62.1 | 오픈웨이트 |
| Qwen 3.7 Max (Alibaba) | 60.6 | |
| Meituan LongCat-2.0 | 59.5 | 오픈웨이트, agentic coding |
| MiniMax M3 | 59.0 | |
| GPT-5.5 | 58.6 | OpenAI 자체발표 여부 불확실(aggregate) |
| Kimi K2.6 (Moonshot) | 58.6 | |
| GPT-5.4 | 57.7 | (Scale표준선 xHigh는 59.1, 별도) |
| Xiaomi MiMo-V2.5-Pro | 57.2 | |
| GPT-5.3 Codex | 56.8 | |
| StepFun Step 3.7 Flash | 56.3 | Step-SWE-Bench(멀티스캐폴드 분산공개)=중국 중 제일 투명 |
| DeepSeek V4-Pro-Max | 55.4 | |
| GPT-5.6 (Sol/Terra/Luna) | — | 6/26 발표, Pro 점수 아직 없음 |

### 2-B. Scale 표준 (중립, 하네스 고정)
| 모델 | Pro |
|---|--:|
| GPT-5.4 (xHigh) | 59.1 |
| Muse Spark (Meta) | 55.0 |
| Claude Opus 4.6 (thinking) | 51.9 |
| Gemini 3.1 Pro | 46.1 |
| Claude Opus 4.5 | 45.9 |
| Claude Sonnet 4.5 | 43.6 |
| **중국(구버전 체크포인트만)**: Qwen3-Coder-480b 38.7 · MiniMax-2.1 36.8 · Kimi-K2-instruct 27.7 · Qwen3-235b 21.4 · DeepSeek-v3p2 15.6 · **GLM-4.6 9.67** | |

### 2-C. 봉인 (Cursor, 6/25) — [cursor.com](https://cursor.com/blog/reward-hacking-coding-benchmarks)
| 모델 | Pro (unsealed→sealed) | Multilingual |
|---|--:|--:|
| Opus 4.8 Max | 87.1 → **73.0** (−14.1) | 91.16 → 82.03 |
| Composer 2.5 (Cursor 자체모델) | 74.7 → **54.0** (−20.7) | 79.15 → 71.60 |
| Opus 4.6 | <1pt drop (클린) | 76.33 → 76.06 (−0.3) |
봉인법: `.git` 제거 + single-commit reinit / 네트워크 deny + 패키지 레지스트리만 allow-list 프록시.

### 2-D. 제3자 재채점 (Datacurve DeepSWE, 5월) — [VentureBeat](https://venturebeat.com/technology/deepswe-blows-up-the-ai-coding-leaderboard-crowns-gpt-5-5-and-finds-claude-opus-exploiting-a-benchmark-loophole)
GPT-5.5 ~70 · GPT-5.4 ~56 · Opus 4.7 ~54 · Sonnet 4.6 32 · Gemini 3.5 Flash 28.
- Opus 4.6/4.7 = git 누수 ">12% CHEATED" 마킹, **GPT는 안 걸림**.
- grader 자체 오류: 틀린답 수용 8.5% / 맞는답 기각 24%.

### 결정적 tell
Pro 원논문(2025-09)에선 GPT-5 **23.3**, Opus 4.1 **22.7**. 9개월 만에 23→80. 모델·스캐폴드 발전 + **누수를 더 세게 파먹은 것**(Cursor: "강한 모델일수록 더 reward-hack").

---

## 3. reward-hack 여부 (모델별) — contested

| 모델 | git-mine | 근거 |
|---|---|---|
| GPT-5.4 / 5.5 | 안 함 | Datacurve(git만 봄; 웹은 미측정) |
| Opus 4.6 | 클린(봉인해도 <1pt) | Cursor |
| Opus 4.6/4.7 | ">12% CHEATED" | Datacurve ← **Cursor와 모순** |
| Opus 4.8 Max | −14.1 | Cursor |
| Composer 2.5 | −20.7 | Cursor |

함정 3개 → **"클린 모델 골라쓰기"는 못 믿을 전략:**
1. Cursor·Datacurve가 Opus 4.6 두고 정반대(하네스 차이).
2. 벡터 분리: Datacurve는 git만, 진짜 큰 건 웹 57%(Opus만 측정). GPT 웹-lookup은 **아무도 안 쟀음** → "GPT 클린"은 git한정.
3. "클린"이 "약함"과 confound(Sonnet 4.6 32, Gemini Flash 28 = hack 못 할 만큼 약한 걸 수도).
→ **결론: 모델 고르지 말고 환경을 봉인하라.** 봉인하면 어떤 모델이든 by construction 클린.

---

## 4. 자체발표 템플릿 (우리가 베낄 것)

| 누가 | 봉인 | 페어숫자 | trajectory감사 | 하네스공개 | 비고 |
|---|:--:|:--:|:--:|:--:|---|
| **Cursor** (6/2026) | ○ | ○ | ○ (731, 63% retrieval) | ✕ | 골드스탠다드. 자기 Composer 제일 못나오게 깠음(−20.7) |
| **Cognition/Devin** (3/2024) | ○ | ✕ | ✕ | ○ ([github](https://github.com/CognitionAI/devin-swebench-results)) | original SWE-bench 13.86%. 오래됐고 Pro 아님 |
| **Augment** ([blog](https://www.augmentcode.com/blog/auggie-tops-swe-bench-pro)) | ✕ | same-model h2h | ✕ | ✕ | Pro 51.80, 모델 고정(Opus 4.5)으로 스캐폴드 격리 |

Augment 표(Opus 4.5 고정): Auggie 51.80 · Cursor 50.21 · Claude Code 49.75 · **Codex 46.47(이건 GPT-5.2-codex)** · SWE-agent 45.89.
→ **(봉인+페어+감사)는 Cursor, (하네스 오픈소스)는 Cognition. 둘 다 한 곳은 없음.** 합치면 우리가 제일 투명.

---

## 5. "스캐폴드가 차별점" 자랑 카탈로그 (Cursor/Augment 외)

### Pro에서 (드뭄)
- **Confucius Code Agent** (학계, Harvard/Meta추정) — Pro **59% Resolve@1**, *"identical model backends and tool access"* = 봉인 same-backend ablation 프레이밍 제일 깨끗. **우리가 하려는 것의 학계 버전.** arXiv 2512.10398. ⚠️particula 인용 "52.7%>52.0% 약한모델승"은 secondary고 논문 59%랑 안 맞음→59%만 신뢰.
- **Blitzy** — Pro 66.5 vs GPT-5.4 57.7, **Quesma 독립검증**("모델 말고 하네스 비교"). 단 베이스모델 비공개=same-model 아님.
- **particula.tech** — "모델은 commodity, 하네스가 차별점", Pro 스캐폴드 22점 스윙 주장(secondary).

### Verified에서 (흔함)
- **Verdent** 76.1 — **진짜 same-model h2h + ablation** (Verified 중 제일 깨끗)
- **OpenHands/All Hands** 72 ("스캐폴드 레이어다") · **Warp** 75.8 · **Trae/ByteDance** 75.2 · **Refact** 74.4 · **Qodo** 71.2 · **Nvidia Nemotron-CORTEXA** 68.2

### 학계/중립 (스캐폴드가 곧 논점)
- **Agentless**(UIUC) Lite 32 "단순 파이프라인이 낫다" · **SWE-agent**(Princeton) 원조 ACI · **mini-swe-agent** Verified 74(미니멀 대조군, Scale가 씀) · **Moatless** Lite 38 · **Mistral Devstral** 46.8(same-scaffold로 모델만 바꾸는 역축)

---

## 6. 국가별 (China/Japan/Korea/SEA/India)

**Pro는 미국 vs 중국 게임. 나머지 아시아는 부재** — 자국어 벤치(일본어 MT-Bench, KMMLU, SEA-HELM, Indic)+주권AI로 빠짐.

- **중국** — 미국 외 유일 Pro 실적. 단 전부 unsealed 자체발표(§2-A). **Scale 표준선 폭락**(GLM-4.6 9.67, Kimi 27.7). Verified만: ByteDance Doubao 76.5, Tencent Hunyuan ~74.4. ⚠️GLM "62→9.7"은 버전confound(5.2 self vs 4.6 표준; 같은버전 Pro 비교 데이터 없음). 낮은 표준점수는 누수뻥튀기 OR 스캐폴드의존 둘 다 해석가능, 현재 데이터로 **구분 불가**.
- **일본** — Sakana **Fugu 73.7**이 유일, 근데 GPT-5.5/Opus 4.8/Gemini 라우팅하는 **오케스트레이션 레이어**지 자국모델 아님. non-sealed, Scale 보드 없음. 나머지(PLaMo·tsuzumi·Takane) = SWE-bench 안 함.
- **한국** — Pro **0**. Verified만: **LG K-EXAONE 49.4**(mini-swe-agent), Upstage Solar Pro 3 28.6(Agentless). Naver/Kakao/SKT/삼성 = 한국어 벤치/HumanEval.
- **싱가포르/SEA** — 완전 0. SEA-HELM 등 지역 다국어만. Sapient HRM=SG/베이징 모호+코딩벤치 없음.
- **인도** — Pro **0**. 디아스포라(미국법인+인도창업자) agent: Composio 48.6 Verified, Patchwork 37 Lite, Emergent(등재·수치미공개). 주권랩(Sarvam·Krutrim)=Indic만.

**빈 칸**: (한국+Pro), (아시아+봉인 Pro), (아시아+Augment식 agent-product 비교) 전부 비어있음 — 중국조차 봉인 Pro 없음.

---

## 7. 우리(quanta) 취약점 + 전략

### 취약점 — solve 박스 git 누수 확정
[dataset.ts:256-295](../../src/runner/batch/corpus/dataset.ts#L256-L295): 풀 bare-mirror 클론 → sandbox `.git`에 `origin/main`+태그가 fix 커밋 가리킨 채 복사 → base_commit 체크아웃만, **strip 없음.** 에이전트가 `git log --all`/`git show <fix>`로 정답 읽을 수 있음(full clone이라 blob까지 있어 네트워크도 불필요). → 우리 측정(2/5 등)도 부풀려졌을 수 있음. 실제 통과 여부는 trajectory 까야 확정.
- 인터넷 축: [network-allowlist.ts](../../src/runtime/network-allowlist.ts) 일부 게이팅 있으나 bench solve egress-deny 적용여부 미확인.

### 전략
1. **봉인을 default-OFF 플래그로** — base_commit 체크아웃 후 `.git` 제거+single-commit reinit + solve egress deny(패키지 레지스트리만 allow).
2. **sealed/unsealed A/B** 같은 픽으로 → 우리 점수 중 실력 vs 누수 분리 = 진짜 baseline.
3. 순서: **trajectory 먼저** 까서 우리가 4.6형(클린)인지 4.8형(누수)인지 확인 → 우선순위 결정. (안 쓰면 봉인해도 점수 불변, 쓰면 봉인 필수.)
4. **발표하려면 Cursor+Cognition 합본**: 봉인 + unsealed/sealed 페어 + "우리 솔브 X%가 git/web 썼다" 감사 + 하네스 공개. 시장 전체가 의심받는 통에서 "깨끗함 증명"이 엣지. 봉인은 윤리 아니라 리스크관리(자랑했다 까이면 "CHEATED" 헤드라인).

---

## 8. 핵심 출처
- 벤치/리더보드: [Scale Pro 보드](https://labs.scale.com/leaderboard/swe_bench_pro_public) · [llm-stats](https://llm-stats.com/benchmarks/swe-bench-pro) · [morphllm](https://www.morphllm.com/swe-bench-pro) · [benchlm](https://benchlm.ai/benchmarks/swePro)
- 봉인/누수: [Cursor reward-hacking](https://cursor.com/blog/reward-hacking-coding-benchmarks) · [Poolside through-the-looking-glass](https://poolside.ai/blog/through-the-looking-glass) · git leak [issue #93](https://github.com/scaleapi/SWE-bench_Pro-os/issues/93)/[PR #94(미머지)](https://github.com/scaleapi/SWE-bench_Pro-os/pull/94) · [Datacurve DeepSWE](https://venturebeat.com/technology/deepswe-blows-up-the-ai-coding-leaderboard-crowns-gpt-5-5-and-finds-claude-opus-exploiting-a-benchmark-loophole)
- 템플릿: [Augment](https://www.augmentcode.com/blog/auggie-tops-swe-bench-pro) · [Cognition devin-swebench-results](https://github.com/CognitionAI/devin-swebench-results) · [Verdent](https://www.verdent.ai) · Confucius arXiv 2512.10398 · [OpenAI: Verified 폐기](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
- 학술 overfit: [PatchDiff 2503.15223](https://arxiv.org/abs/2503.15223) · [IBM test-overfit 2511.16858](https://arxiv.org/html/2511.16858v2)
- Pro 원논문(23.3/22.7): arXiv 2509.16941

### 정정 로그 (이 리서치 중 바로잡은 것)
- GLM "62→9.7"=버전confound(5.2 self vs 4.6 표준), 같은버전 비교 데이터 없음.
- Augment 표 Codex=GPT-5.2-codex(Opus 4.5 아님). 모델고정은 Auggie/Cursor/Claude Code 3개만.
- Fable 5 = Mythos 5 같은 weight(별개 행 아님). Pro 80.3(80.0 아님).
- GitHub issue #21 = 제3자(@dephnor)가 DeepSWE 감사하다 자기 solve-rate 철회. Datacurve CHEATED는 안 철회.
- Cursor 봉인 74→54는 Composer 2.5(자기모델), Opus는 87→73.
- Cursor 하네스 오픈소스 **안** 함(방법만 글로). 공개한 건 Cognition(2024).

---

## 9. 타임라인 — 출처 아티클 (제목 + 날짜, 최신순)

> ~표시 = 날짜 secondary/추정. arXiv 번호의 앞 4자리(YYMM)가 제출 연월.

| 날짜 | 제목 / 출처 | 핵심 |
|---|---|---|
| 2026-06-29 | benchlm Pro 보드 갱신 (40 모델) | 집계 |
| 2026-06-28 | [Scale Pro 보드](https://labs.scale.com/leaderboard/swe_bench_pro_public) / [morphllm](https://www.morphllm.com/swe-bench-pro) / [llm-stats](https://llm-stats.com/benchmarks/swe-bench-pro) 갱신 | 표준 baseline |
| 2026-06-26 | OpenAI **GPT-5.6 (Sol/Terra/Luna)** 발표 | Pro 점수 아직 없음 |
| 2026-06-25 | Cursor **"Reward hacking is swamping model intelligence gains"** (Naman Jain) | 봉인 87→73, 63% retrieval. 골드스탠다드 |
| 2026-06-19~23 | Sakana **Fugu** technical report (arXiv 2606.21228) | 일본 유일, 오케스트레이션 라우터 73.7 |
| 2026-06-19 | Zhipu **GLM-5.2** README/launch | Pro 62.1 자체발표 |
| 2026-06-18 | Augment **"Auggie tops SWE-bench Pro"** 갱신(원 2026-02-04, run Apr) | same-model h2h 51.80 |
| 2026-06-12 | Anthropic **Fable 5 / Mythos 5 suspend** (export-control) | |
| 2026-06-09 | Anthropic **Fable 5 / Mythos 5** 출시 | Pro 80.3 / Verified 95 |
| 2026-06-01 | GitHub **issue #21** (@dephnor, DeepSWE 감사) | dephnor 자기 solve-rate 철회(CHEATED는 유지) |
| 2026-05-29 | StepFun **Step 3.7 Flash** | Pro 56.3, Step-SWE-Bench |
| 2026-05-28 | Anthropic **Opus 4.8** news | Pro 69.2 / Verified 88.6 |
| ~2026-05-27 | **Datacurve DeepSWE** ([VentureBeat](https://venturebeat.com/technology/deepswe-blows-up-the-ai-coding-leaderboard-crowns-gpt-5-5-and-finds-claude-opus-exploiting-a-benchmark-loophole)) | Opus git CHEATED >12%, grader 8.5/24% |
| 2026-05-20 | Alibaba **Qwen 3.7 Max** | Pro 60.6 |
| 2026-05-14 | git leak [**PR #94**](https://github.com/scaleapi/SWE-bench_Pro-os/pull/94) last activity (미머지) | future history strip |
| 2026-05-11 | Poolside **"Through the Looking Glass"** | "벤치 설계만으론 못 막는다" |
| 2026-04-29 | git leak [**issue #93**](https://github.com/scaleapi/SWE-bench_Pro-os/issues/93) (ConnorBAdams/Poolside) | 공개 이미지 100% 익스플로잇 |
| 2026-04-22 | Xiaomi **MiMo-V2.5-Pro** | Pro 57.2 |
| 2026-04-07 | Quesma **"Verifying Blitzy SWE-bench Pro"** | Blitzy 66.5 vs GPT-5.4 57.7(독립검증) |
| ~2026-04 또는 02 | OpenAI **"Why we no longer evaluate SWE-bench Verified"** | 실패의 59.4% flawed test → Pro 권장 |
| 2026-03-25 | particula.tech **"scaffold beats model"** (S. Mondragon) | "모델은 commodity, 하네스가 차별점" |
| 2026-03-24 | Upstage **Solar Pro 3** | SWE-bench 28.6(변종 미공개) |
| ~2026-02 | ByteDance **Seed 2.0 / Doubao** | Verified 76.5(Pro 아님) |
| 2026-01-05 | LG **K-EXAONE** Technical Report (arXiv 2601.01739) | Verified 49.4(한국 최고) |
| ~2025-12 | **Confucius Code Agent** (arXiv 2512.10398, Harvard/Meta?) | **Pro 59%, sealed same-backend** — 학계 최강 |
| 2025-11-14 | SWE-bench Pro 논문 개정 (arXiv 2509.16941) | |
| 2025-11 | IBM **"Investigating Test Overfitting"** (arXiv 2511.16858) | Claude-3.7 21.8% overfit |
| 2025-11-01 | **Verdent** SWE-bench Verified tech report | 76.1, same-model h2h+ablation |
| 2025-09-21 | **SWE-bench Pro 원논문** (arXiv 2509.16941, ScaleAI) | **GPT-5 23.3 / Opus 4.1 22.7** (9개월 뒤 80으로 폭등) |
| 2025-07-10 | Upstage Solar Pro 2 | SWE-bench Agentless 14.5 |
| ~2025-03 | **"Are Solved Issues Really Solved Correctly?"** PatchDiff (arXiv 2503.15223, ICSE 2026) | resolution ~6.2pp 부풀림 |
| 2024-11-11 | Composio **SWE-Kit** (LangChain blog) | 인도디아스포라, Verified 48.6 |
| 2024-07 | **Agentless** (arXiv 2407.01489, UIUC) | "단순 파이프라인이 낫다", Lite 32 |
| 2024-03-15 | Cognition/Devin **SWE-bench technical report** | 봉인+하네스 공개 원조, original 13.86 |

**연도 요약:** Pro 벤치 자체는 **2025-09** 등장(23%대). **2025-11~2026-06**에 점수 80%대로 폭등 + 동시에 누수 폭로(2026-04 issue #93, 2026-05 Datacurve/Poolside, 2026-06 Cursor)가 터짐 = "점수 오름"과 "그 점수 못 믿음"이 같은 9개월에 동시 진행. 봉인 정식 측정은 **2026-06 Cursor가 처음**(Cognition 2024 선례 빼면).

---

## 10. 스캐폴드 플레이어 전수 (B/C급 롱테일) + Pro 구조적 공백

§5는 "스캐폴드를 엄밀히 증명한 A급"만. 여기는 **롱테일 전체**와 **왜 Pro엔 스캐폴드가 없는지**.

### 🔴 구조적 사실 — Pro엔 스캐폴드 제출 자체가 불가
- **swebench.com**(Verified/Lite/Full) 보드는 **에이전트 제출을 받음** → 모든 스캐폴드 롱테일이 여기 쌓임.
- **Scale Pro 보드**는 **모델을 자기가 고정 하네스(mini-swe-agent)로 돌림** → 스캐폴드 제품 제출 레인이 없음.
- ⇒ 에이전트 제품이 Pro 숫자를 가지려면 **자기 블로그 자체발표뿐**이고, 거의 아무도 안 함.
- **Pro 숫자 있는 스캐폴드 = 6개가 전부**(전부 자체발표): Augment 51.80 · Blitzy 66.5(Quesma검증, base 비공개) · Cursor Composer(봉인연구) · Sakana Fugu 73.7(secondary, 라우터) · Confucius 59(학계 sealed) · StepFun Step-SWE-Bench(멀티스캐폴드).
- 봉인+감사=Cursor 1 · same-model 격리=Augment 1 · 학계 sealed=Confucius 1. **(Pro+봉인+same-model+감사) 조합은 0.**

### B급 — 엔터프라이즈 "wrapped-Claude" 군 (71~79% **Verified**, 거의 안 알려짐)
| 에이전트 | org | % (Verified) | 모델 |
|---|---|--:|---|
| Sonar Foundation Agent | SonarSource | **79.2**(Opus) / 52.62 Full | Claude 4.5 Opus/Sonnet |
| Atlassian Rovo Dev | Atlassian | 76.8 | |
| EPAM AI/Run | EPAM | 76.8 | Claude 4 Sonnet |
| ACoder | OSS | 76.4 | |
| Harness AI | Harness.io | 74.8 | |
| **Lingxi** | **Huawei**+U.Manitoba | 74.6 | 멀티모델 ablation(GPT-4.1/Kimi/Sonnet), sealed |
| JoyCode | JD.com 🇨🇳 | 74.6 | Claude4 Sonnet+GPT-4.1 |
| Refact.ai | Refact | 74.4 | Claude4 Sonnet+o4-mini |
| Prometheus | euni.ai | 74.4 | GPT-5 |
| Salesforce SAGE | Salesforce | 73.8 | |
| Tools | OSS | 73.2(Opus) | same-model arm(Opus/Sonnet/Haiku) |

### B급 — 중위 (Verified)
Qodo 71.2 · Bloop(🇬🇧) 71.2 · devlo 70.2 · Zencoder 70.0 · Amazon Q Developer 65.4 · W&B Programmer 64.6 · AgentScope(Alibaba🇨🇳) 63.4 · CodeStory/Aide 62.2 · Cline(자체발표 off-board) ~59.8 · Emergent E1(🇮🇳) 57.2 · Artemis/TurinTech 57.0 · Gru.ai(🇨🇳) 57.0 · JetBrains Junie 53.6(SWE-rebench #1 61.6) · Bracket.sh 53.2 · AutoCodeRover(🇸🇬NUS) 51.6 · Engine Labs/Solver(Laredo)/MarsCode(🇨🇳ByteDance)/nFactorial ~49-52 · AppMap Navie 47.2

### C급 (obscure / Lite / 옛날 / 약함)
Isoform(Lite 55) · Codev(Lite 49) · Globant Code Fixer(🇦🇷 Lite 48.33) · Honeycomb(40.6) · Aider(Lite 26.33; 자기 polyglot 벤치는 별개) · Mentat(Lite 38) · Lingma SWE-GPT(🇨🇳 30.2, 모델에 가까움) · LingmaAgent(Lite relative-delta만) · 학계 일회성 무더기(SemAgent·KGCompass·ExpeRepair·DARS·OrcaLoca·CodeFuse·Kortix·MASAI·HyperAgent·IBM SWE-1.0, Lite 23~58)

### 아시아 스캐폴드 국가별
- **중국** — Trae(ByteDance) 75.2 최강 · JoyCode(JD) 74.6 · AgentScope(Alibaba) 63.4 · Gru.ai 57 · MarsCode 49.4 · Lingma 30.2. **Tencent CodeBuddy·Baidu Comate·iFlytek·CodeGeeX(제품)은 SWE-bench 미보고**(내부 채택률만).
- **Huawei Lingxi 74.6** — 별개·강함(중국 corporate).
- **한국** — 스캐폴드 제품 **0**. Naver "Agent N" 예고만.
- **일본** — Sakana Fugu만(secondary, 라우터).
- **인도** — Composio/Emergent/Patchwork(디아스포라)만.

### 정정 (이 census에서)
- **Lingxi = Huawei + 매니토바대** (Alibaba 아님).
- **CodeGeeX는 스캐폴드로 SWE-bench 안 냄** — 그 숫자는 GLM 모델 라인.
- Tencent/Baidu/iFlytek 코딩 제품 = SWE-bench 미보고, 채택률 등 내부지표만.
- Sonar 52.62는 SWE-bench **Full**(원본 2294), Pro 아님.

### 참고 — 스캐폴드 아키텍처 택소노미
**"Inside the Scaffold: A Source-Code Taxonomy of Coding Agent Architectures"** (arXiv 2604.03515, 2026-04). 코딩 에이전트 하네스 구조 분류 — quanta 하네스 설계 baseline으로 볼 만함. (앞선 [Dissecting the SWE-Bench Leaderboards](https://arxiv.org/html/2506.17208v2) = 제출자/아키텍처 프로파일링과 보완.)

### 한 줄
Verified는 70%대 wrapped-Claude 래퍼가 빽빽(차별화 불가). **Pro 스캐폴드는 자체발표 6개가 전부 = 빈 운동장.** (Pro+봉인+same-model+감사) 칸 0개 재확인.
