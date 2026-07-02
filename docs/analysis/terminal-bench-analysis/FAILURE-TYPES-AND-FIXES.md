# Terminal-Bench 실패 타입별 × 문제설명 × 해결책 (2026-07-02)

full-89 (48/89, knob-OFF baseline)에서 실패한 ~41개를 **각 final 메시지 실독**으로 4타입 분류. 타입별로: 어떤 문제들이냐 · 각 문제가 뭐하는 거냐 · 어떻게 조질 거냐.

> 측정상태: 타입1(install-refusal)은 env-owned A/B로 검증 중(4/5 완료 + 남은 5개 배치 도는 중). 타입2~4는 계획.

---

## 타입 1 — R-ENV 설치거부 (~9개) · **레버 #1 env-posture · 측정중**

에이전트가 *"not allowed to install / owned by the harness"* 하고 bail. 근데 이 태스크들은 **설치·빌드가 딜리버러블의 본질**. SWE 편향 R-ENV 하드룰이 정확히 막음.

| task | 뭐하는 문제 | 상태(env-owned) |
|---|---|---|
| kv-store-grpc | gRPC 키-밸류 스토어 서버 구현(grpc 설치+서버 기동) | ✅ PASS |
| nginx-request-logging | nginx 설치+요청로깅 설정 | ✅ PASS |
| sqlite-with-gcov | SQLite를 gcov 커버리지로 컴파일(빌드툴) | ✅ PASS |
| configure-git-webserver | bare git repo + post-receive 훅 → 웹서버 배포 | ✅ PASS |
| compile-compcert | CompCert(검증된 C 컴파일러) 빌드 | 배치2 (별개 `/tmp/CompCert` task-env 이슈 있음) |
| install-windows-3.11 | QEMU 설치 + Windows 3.11 VM 부팅 | 배치2 (무거움) |
| torch-pipeline-parallelism | PyTorch 파이프라인 병렬화 구현(torch 설치) | 배치2 |
| caffe-cifar-10 | Caffe로 CIFAR-10 학습(caffe 설치+훈련) | 배치2 |
| build-cython-ext | Cython 확장(pyknotid) 빌드 | 배치2 |

**해결:** `QUANTA_TB_ENV_OWNED=1` — OWNED_RULES가 R-ENV/R-STOP-ENV 대체, "환경 소유·자유 설치". **검증됨(4/5 reward=1)**. 남은 5개 측정 후 타입1 총합 확정.

---

## 타입 2 — 가짜 green (CLAIMED-DONE, ~30개, **70% 지배**) · **레버 #2 verify-gate**

에이전트가 *"구현/검증/green"* 선언했는데 verifier reject. **existence/execution은 증명, behavior-against-spec은 안 함**(돌아감≠맞음). 다시 둘로 갈림:

### 2a. verify-gap = 오라클 있었는데 스킵 (top-tier 푸는 것, ~13) — **레버가 먹힐 곳**
| task | 뭐하는 문제 |
|---|---|
| path-tracing-reverse | `/app/mystery` 바이너리 리버스 → C 패스트레이서 재현(출력 바이트일치). *green 선언했지만 레퍼런스랑 대조 안 함* |
| pytorch-model-recovery | 손상된 torch 모델 복구(top-tier 66%) |
| mcmc-sampling-stan | 계층 베이지안 MCMC 샘플링(Stan) posterior 추정(top 56%) |
| merge-diff-arc-agi | ARC-AGI 퍼즐 규칙 귀납(hidden test로 일반화) |
| mailman | Mailman 메일링리스트 서버 셋업 |
| build-pov-ray | POV-Ray 레이트레이서 빌드+렌더 |
| query-optimize | DB 쿼리 최적화 |
| financial-document-processor | 금융문서 파싱/처리 |
| polyglot-rust-c / polyglot-c-py | 한 소스가 두 언어로 컴파일/실행되는 폴리글랏 |
| chess-best-move | 체스 최선수 계산 |
| mteb-retrieve | MTEB 임베딩 검색 태스크 |
| db-wal-recovery | DB WAL(Write-Ahead Log) 복구 |
| raman-fitting | 라만 스펙트럼 피팅 |
| adaptive-rejection-sampler | 적응적 기각 샘플링 알고리즘(ars.R) |
| dna-assembly / dna-insert | DNA 프라이머 설계/삽입 |
| rstan-to-pystan | RStan → PyStan 포팅 |

**해결:** `QUANTA_TB_VERIFY_GATE=1` — report 전 **deliverable end-to-end 실행 증거 없으면 1턴 강제** + verified-pass/fail/**unverifiable** 3분법. 오라클 있던 걸 강제 → 회복. **정직:** 이건 "검증 스킵"만 잡음.
- 더 깊은 레버(부족하면): **오라클-루프** — 검증 실패 시 검증될 때까지 멀티어템프(현재 게이트는 1턴 bounded, 미구현)

### 2b. claimed-done인데 실제로 하드 — 아래 타입3과 겹침

---

## 타입 3 — 하드천장 (~7-12개) · **모델 레버(Opus 4.8), 스캐폴드 무효**

top-tier도 ~0. 스캐폴드로 못 만듦. 모델 역량·추론·깊이 문제.

| task | 뭐하는 문제 |
|---|---|
| gpt2-codegolf | GPT-2를 최소코드로 구현(expert 추정 40h, 코드골프) |
| protein-assembly | 단백질 구조 조립 |
| mteb-leaderboard | MTEB 임베딩 벤치 리더보드 재현 |
| make-doom-for-mips | Doom을 MIPS로 크로스컴파일 |
| regex-chess | 순수 정규식으로 체스 엔진 |
| sam-cell-seg | SAM(Segment Anything)으로 세포 분할 |
| extract-moves-from-video | 체스 대국 영상에서 수(move) 추출 |

**해결:** **Opus 4.8 재런** = 모델 델타 측정. 스캐폴드 레버 없음(측정용). 도메인힌트 주입은 answer-key 위험이라 금지.

---

## 타입 4 — 예산소진/기타 (~5개) · **limit 튜닝**

능력은 되는데 턴/시간 예산 부족으로 중단.

| task | 뭐하는 문제 |
|---|---|
| build-pmars | pMARS(코어워 시뮬레이터) 빌드 — 빌드하다 턴소진 |
| make-mips-interpreter | MIPS 인터프리터 구현 — 29턴 소진 |
| (일부 build-* 계열) | 빌드 장시간 |

**해결:** **turn/time limit 상향**(effort-ladder knob, tier→adaptive limits). 그냥 더 돌리면 되는 부류.

---

## 공략 순서 (측정 우선, 큰 것부터)

1. **타입1 install-refusal** (레버 #1) — 측정중. 4/5 검증됨. → 총합 확정
2. **타입2 fake-green** (레버 #2 verify-gate) — 최대 버킷(70%). solvable subset(~13) A/B. 부족하면 오라클-루프
3. **타입3 하드천장** — Opus 4.8 재런. 모델델타
4. **타입4 budget** — limit 상향

**전부 measure-first, default-OFF byte-identical.** 안 오르면 knob 삭제. SWE Verified 불변 확인이 무결성 가드.
