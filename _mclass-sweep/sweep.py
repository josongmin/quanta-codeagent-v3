#!/usr/bin/env python3
"""Structural SWE-bench coverage sweep.

Pushes every non-CEILING untried instance (E/M/H tier, ranked cnt-desc, sphinx
deprioritised) through full-remote grading. P0 (jun-20 box-lifecycle plan): ONE
box per wave with a fat slice + high per-box patch-gen concurrency, amortising the
bootstrap tax instead of multiplying boxes (which only multiplies the 429 burst).

Race-safety: this script is the SOLE writer of files under _mclass-sweep/.
It only READS the shared leaderboard (to dedup against whatever the parallel
agent has resolved). Confirmed resolves accumulate in sweep-runblocks.yaml for
the interactive agent to fold into the main leaderboard at checkpoints.
"""
import json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

ROOT = "/Users/songmin/quanta-codeagent-v3"
SWEEP = f"{ROOT}/_mclass-sweep"
UNIV = f"{SWEEP}/universe.tsv"
DS = f"{ROOT}/tools/leaderboard-dashboard/rawdata/verified-full.jsonl"
LB = f"{ROOT}/docs/swebench-leaderboard.yaml"
SLICEDIR = "/Users/songmin/Library/quanta-codeagent-v3/bench-slices"
RESULTS = f"{SWEEP}/results.jsonl"
MISS = f"{SWEEP}/misses.txt"
GINVALID = f"{SWEEP}/grader-invalid.txt"
ATTEMPTS = f"{SWEEP}/attempts.json"
TRANSIENT_CNT = f"{SWEEP}/transient.json"   # id -> 429 retry count
INFRA_CNT = f"{SWEEP}/infra-rollback.json"  # id -> batch-death attempt rollbacks (BOUNDED)
DEFERRED = f"{SWEEP}/deferred.txt"          # gave up after MAX_TRANSIENT 429s
RUNBLOCKS = f"{SWEEP}/sweep-runblocks.yaml"
LOGDIR = f"{SWEEP}/logs"
DATE = "2026-06-20"

PARALLEL = 1        # P0 (jun-20 box-lifecycle plan): collapse to 1 box. The binding
                    # limit is the shared gpt-5.4 OAuth rate, not box count — so we
                    # buy throughput by raising PER-BOX patch-gen concurrency (see
                    # run_box) and amortising one box over a FAT slice, not by adding
                    # boxes (which multiplies the bootstrap tax + the 429 burst).
SLICE = 16          # instances per box. Bumped 6->16 so one box bootstrap (boot+rsync+
                    # install+warm ~4min) amortises over 16 grades instead of 6.
TIMEOUT = 5400      # 90min/box. A 16-instance slice grades SERIALLY (process-global
                    # docker mutex), so the per-box wall is gen + ~16*grade — far past
                    # the old 40min. 90min stays well under the 180min box TTL while
                    # still catching a genuine poison-slice hang.
MAX_ATTEMPTS = 2    # an instance that never returns a verdict twice -> give up
MAX_TRANSIENT = 5   # 429/generation_error retries before deferring (NOT a miss)
MAX_INFRA_ROLLBACK = 3  # cap batch-death attempt rollbacks per instance, so a poison
                        # instance that HANGS the serial box (whole batch → 0 verdicts)
                        # can't be rolled back forever — after this it burns attempts
                        # normally and MAX_ATTEMPTS caps it. Guarantees termination.
WAVE_BACKOFF = 90   # seconds between waves to let the OAuth rate limit recover

# --- jun-20 box-lifecycle pool (Phase 3b) ----------------------------------
# Default ON: a super-wave submits POOL_CHUNKS slices to ONE persistent box via
# `quanta-bench pool`, so the box bootstrap (boot+rsync+install+warm ~4min) is
# paid ONCE per super-wave instead of once per slice. The box-side grade is still
# SERIAL per chunk; the win is amortised bootstrap + a long-lived box across
# slices. Set SWEEP_USE_POOL=0 to fall back to the proven per-slice path.
# NOTE: each chunk grades ~SLICE instances SERIALLY, so POOL_CHUNKS*SLICE*~grade
# must fit under the box TTL (180min) — keep the product modest (default 2*16=32,
# ~64min grade + gen, well under TTL; the pool also rotates the box at 150min).
USE_POOL = os.environ.get("SWEEP_USE_POOL", "1") != "0"
POOL_CHUNKS = int(os.environ.get("SWEEP_POOL_CHUNKS", "2"))  # slices per super-wave (one box)
POOL_WORKERS = int(os.environ.get("SWEEP_POOL_WORKERS", "1"))  # boxes (>1 requires explicit opt-in)
POOL_TIMEOUT = int(os.environ.get("SWEEP_POOL_TIMEOUT", "9000"))  # 150min — multi-chunk box-life wall
ALLOW_MULTI_BOX = os.environ.get("SWEEP_ALLOW_MULTI_BOX", "0") == "1"
PATCH_GEN_BUDGET = int(os.environ.get("SWEEP_PATCH_GEN_BUDGET", "16"))

if (PARALLEL > 1 or POOL_WORKERS > 1) and not ALLOW_MULTI_BOX:
    raise SystemExit(
        "refused: multi-box sweep is disabled by default. Re-run with "
        "SWEEP_ALLOW_MULTI_BOX=1 to launch more than one box."
    )

def per_box_patch_gen_concurrency(boxes):
    return max(1, min(16, PATCH_GEN_BUDGET // max(1, boxes)))

os.makedirs(LOGDIR, exist_ok=True)
os.makedirs(SLICEDIR, exist_ok=True)
for f in (RESULTS, MISS, GINVALID, RUNBLOCKS, DEFERRED):
    open(f, "a").close()

def log(m):
    print(f"[sweep {time.strftime('%H:%M:%S')}] {m}", flush=True)

def load_universe():
    out = []
    for line in open(UNIV):
        p = line.rstrip("\n").split("\t")
        if len(p) >= 4:
            out.append((p[0], int(p[1]), p[2], p[3]))  # fid, cnt, tier, short
    return out

def ds_index():
    idx = {}
    for line in open(DS):
        m = re.search(r'"instance_id"\s*:\s*"([^"]+)"', line)
        if m:
            idx[m.group(1)] = line
    return idx

def leaderboard_resolved():
    try:
        s = open(LB).read()
    except FileNotFoundError:
        return set()
    return set(re.findall(r'[a-z_-]+__[a-z_]+-[0-9]+', s))

def my_resolved():
    s = set()
    for line in open(RESULTS):
        line = line.strip()
        if not line:
            continue
        try:
            s.add(json.loads(line)["id"])
        except Exception:
            pass
    return s

def load_set(path):
    try:
        return set(x.strip() for x in open(path) if x.strip())
    except FileNotFoundError:
        return set()

def load_attempts():
    try:
        return json.load(open(ATTEMPTS))
    except Exception:
        return {}

def save_attempts(a):
    json.dump(a, open(ATTEMPTS, "w"))

def load_transient():
    try:
        return json.load(open(TRANSIENT_CNT))
    except Exception:
        return {}

def save_transient(t):
    json.dump(t, open(TRANSIENT_CNT, "w"))

PASS_RE = re.compile(r'\[PASS\]\s+(\S+)\s+\(turns=(\d+)\)')
GINV_RE = re.compile(r'\[FAIL GRADER_INVALID\]\[grader_invalid\]\s+(\S+)\s+\(turns=(\d+)\)')
# generation_error == LLM stream failure (429 / rate limit) == TRANSIENT, not a miss
TRANS_RE = re.compile(r'\[FAIL\]\[generation_error\]\s+(\S+)\s+\(turns=(\d+)\)')
FAIL_RE = re.compile(r'\[FAIL\]\[(?!generation_error)[^\]]+\]\s+(\S+)\s+\(turns=(\d+)\)')

def parse_log(path):
    """Return dict id -> (outcome, turns). outcome in pass|miss|ginvalid|transient."""
    res = {}
    try:
        txt = open(path, errors="replace").read()
    except FileNotFoundError:
        return res
    for m in TRANS_RE.finditer(txt):
        res[m.group(1)] = ("transient", int(m.group(2)))
    for m in FAIL_RE.finditer(txt):
        res[m.group(1)] = ("miss", int(m.group(2)))
    for m in GINV_RE.finditer(txt):
        res[m.group(1)] = ("ginvalid", int(m.group(2)))
    for m in PASS_RE.finditer(txt):  # a pass anywhere wins
        res[m.group(1)] = ("pass", int(m.group(2)))
    return res

def run_box(slice_path, log_path):
    env = dict(os.environ)
    # P0: drop ONDEMAND -> spot. With PARALLEL=1 a spot reclaim loses at most one
    # wave, and the harvest below already undoes attempts for no-verdict instances
    # so the slice re-queues next wave. Spot is the cheaper default for the longer
    # fat-slice waves; the box-death requeue hardening is Phase 4.
    env["QUANTA_BENCH_PRESET"] = "agentless-v2"
    # Default single-box posture: spend the WHOLE shared OAuth budget on that one
    # box. If the operator EXPLICITLY opts into more boxes, split the same default
    # budget across them instead of multiplying the burst.
    env["QUANTA_FULL_REMOTE_CONCURRENCY"] = str(per_box_patch_gen_concurrency(PARALLEL))
    cmd = ["bun", "run", "src/apps/bench/cli.ts", "grade", "--mode", "full",
           "--allow-remote-secrets", "--dataset", slice_path]
    with open(log_path, "w") as lf:
        try:
            subprocess.run(["timeout", str(TIMEOUT)] + cmd, cwd=ROOT, env=env,
                           stdout=lf, stderr=subprocess.STDOUT, timeout=TIMEOUT + 120)
        except subprocess.TimeoutExpired:
            lf.write("\n[sweep] box wall-timeout\n")

def run_pool(slice_paths, log_path):
    """Grade many slices on ONE persistent box via the pool CLI. All chunk output
    streams to a single combined log (workers=1 ⇒ sequential), which parse_log
    reads per-slice (it keys by instance id, so a shared log is fine)."""
    env = dict(os.environ)
    env["QUANTA_BENCH_PRESET"] = "agentless-v2"
    env["QUANTA_FULL_REMOTE_CONCURRENCY"] = str(per_box_patch_gen_concurrency(POOL_WORKERS))
    cmd = ["bun", "run", "src/apps/bench/cli.ts", "pool",
           "--allow-remote-secrets",
           "--datasets", ",".join(slice_paths),
           "--workers", str(POOL_WORKERS),
           "--preset", "agentless-v2", "--model", "gpt-5.4"]
    if POOL_WORKERS > 1:
        cmd.append("--allow-extra-boxes")
    with open(log_path, "w") as lf:
        try:
            subprocess.run(["timeout", str(POOL_TIMEOUT)] + cmd, cwd=ROOT, env=env,
                           stdout=lf, stderr=subprocess.STDOUT, timeout=POOL_TIMEOUT + 120)
        except subprocess.TimeoutExpired:
            lf.write("\n[sweep] pool wall-timeout\n")

def repo_of(fid):
    return fid.split("__")[0].replace("-dev", "").replace("-doc", "").replace("pydata", "xarray")

def append_runblock(wave, idx, passed):
    if not passed:
        return
    lines = [
        f"- run_id: sweep-w{wave}-s{idx}-{DATE}",
        f"  date: '{DATE}'",
        "  preset: agentless-v2",
        "  model: gpt-5.4",
        "  auth: chatgpt-oauth",
        "  grading: official swebench python harness, spot EC2, prebaked AMI",
        f"  scope: 'STRUCTURAL SWEEP wave{wave} slice{idx} — non-CEILING untried, cnt-desc.'",
        f"  resolved_count: {len(passed)}",
        "  resolved:",
    ]
    for fid, turns in passed:
        short = fid.split("__")[-1].split("-")
        repo = "-".join(short[:-1]) if len(short) > 1 else fid.split("__")[0]
        # repo label: use the human repo word
        rl = fid.split("__")[0]
        rl = {"pytest-dev": "pytest", "pylint-dev": "pylint", "sphinx-doc": "sphinx",
              "pydata": "xarray", "scikit-learn": "scikit-learn"}.get(rl, rl)
        lines.append(f"  - instance_id: {fid}")
        lines.append(f"    repo: {rl}")
        lines.append(f"    turns: {turns}")
    with open(RUNBLOCKS, "a") as f:
        f.write("\n".join(lines) + "\n")

def main():
    universe = load_universe()
    order = [u[0] for u in universe]
    dsidx = ds_index()
    log(f"universe={len(order)} non-CEILING instances")
    wave = 0
    consec_rl = 0  # consecutive fully-rate-limited waves -> exponential backoff
    while True:
        wave += 1
        resolved = leaderboard_resolved() | my_resolved()
        misses = load_set(MISS) | load_set(GINVALID) | load_set(DEFERRED)
        attempts = load_attempts()
        dead = {k for k, v in attempts.items() if v >= MAX_ATTEMPTS}
        skip = resolved | misses | dead
        remaining = [fid for fid in order if fid not in skip]
        if not remaining:
            log("SWEEP COMPLETE — no remaining non-CEILING untried instances")
            break
        n_chunks = POOL_CHUNKS if USE_POOL else PARALLEL
        batch = remaining[: n_chunks * SLICE]
        mode = f"pool({POOL_WORKERS}box×{POOL_CHUNKS}chunk)" if USE_POOL else f"{PARALLEL}box"
        log(f"wave {wave}: {len(remaining)} remaining; launching {len(batch)} via {mode}")
        slices = [batch[i:i + SLICE] for i in range(0, len(batch), SLICE)]
        # build slice files
        jobs = []
        for i, sl in enumerate(slices):
            sp = f"{SLICEDIR}/sweep-w{wave}-s{i}.jsonl"
            with open(sp, "w") as f:
                for fid in sl:
                    if fid in dsidx:
                        f.write(dsidx[fid])
            lp = f"{LOGDIR}/sweep-w{wave}-s{i}.log"
            jobs.append((i, sl, sp, lp))
            # bump attempt counters now (so a hung box that returns nothing counts)
            for fid in sl:
                attempts[fid] = attempts.get(fid, 0) + 1
        save_attempts(attempts)
        # launch
        if USE_POOL:
            # ONE persistent box grades all slices; combined log shared by every
            # slice (parse_log keys by instance id, so a shared log is correct).
            pool_log = f"{LOGDIR}/sweep-w{wave}-pool.log"
            run_pool([sp for (_, _, sp, _) in jobs], pool_log)
            log_for = {i: pool_log for (i, _, _, _) in jobs}
        else:
            with ThreadPoolExecutor(max_workers=PARALLEL) as ex:
                futs = [ex.submit(run_box, sp, lp) for (_, _, sp, lp) in jobs]
                for fu in futs:
                    fu.result()
            log_for = {i: lp for (i, _, _, lp) in jobs}
        # harvest
        tcnt = load_transient()
        try:
            infra = json.load(open(INFRA_CNT))
        except Exception:
            infra = {}
        wave_pass = wave_miss = wave_ginv = wave_trans = 0
        # Parse each slice's log ONCE. A batch (esp. a pool super-wave) that
        # produced ZERO verdicts across ALL slices = box death / POOL_TIMEOUT —
        # an INFRA failure, NOT any instance's fault. In that case we roll the
        # attempt back below so a transient infra hiccup can't burn 16-32 instances
        # toward MAX_ATTEMPTS and silently drop them. If SOME instances DID get a
        # verdict, the box worked and a missing one genuinely hung → keep its
        # attempt (MAX_ATTEMPTS still caps a real per-instance hang).
        parsed_logs = {i: parse_log(log_for[i]) for (i, _, _, _) in jobs}
        batch_had_verdicts = any(
            parsed_logs[i].get(fid) for (i, sl, _, _) in jobs for fid in sl
        )
        for (i, sl, sp, lp) in jobs:
            res = parsed_logs[i]
            passed = []
            for fid in sl:
                outcome = res.get(fid)
                if not outcome:
                    # no verdict. If the WHOLE batch died (infra), roll back the
                    # attempt so this instance isn't penalised for a box death /
                    # timeout — but only up to MAX_INFRA_ROLLBACK times, so a poison
                    # instance that HANGS the serial box (and thus zeroes the whole
                    # batch every wave) can't be rolled back forever. After the cap
                    # the attempt sticks → MAX_ATTEMPTS eventually marks it dead.
                    # If the batch otherwise worked, this instance specifically hung
                    # → keep the attempt immediately (MAX_ATTEMPTS caps it).
                    if not batch_had_verdicts and infra.get(fid, 0) < MAX_INFRA_ROLLBACK:
                        attempts[fid] = max(0, attempts.get(fid, 1) - 1)
                        infra[fid] = infra.get(fid, 0) + 1
                    continue
                kind, turns = outcome
                if kind == "transient":
                    # 429 / rate-limit: DO NOT record as miss. Count and retry;
                    # also roll back the attempt tick so a real verdict still gets
                    # MAX_ATTEMPTS tries later.
                    tcnt[fid] = tcnt.get(fid, 0) + 1
                    attempts[fid] = max(0, attempts.get(fid, 1) - 1)
                    if tcnt[fid] >= MAX_TRANSIENT:
                        with open(DEFERRED, "a") as df:
                            df.write(fid + "\n")
                    wave_trans += 1
                    continue
                rec = {"id": fid, "outcome": kind, "turns": turns,
                       "wave": wave, "slice": i}
                with open(RESULTS, "a") as rf:
                    rf.write(json.dumps(rec) + "\n")
                if kind == "pass":
                    passed.append((fid, turns)); wave_pass += 1
                elif kind == "ginvalid":
                    with open(GINVALID, "a") as gf:
                        gf.write(fid + "\n")
                    wave_ginv += 1
                else:
                    with open(MISS, "a") as mf:
                        mf.write(fid + "\n")
                    wave_miss += 1
            append_runblock(wave, i, passed)
        save_attempts(attempts)
        save_transient(tcnt)
        json.dump(infra, open(INFRA_CNT, "w"))
        log(f"wave {wave} done: pass={wave_pass} miss={wave_miss} "
            f"grader_invalid={wave_ginv} transient429={wave_trans}")
        if wave_trans and not wave_pass:
            # whole wave got rate-limited (shared OAuth quota likely exhausted) —
            # exponential backoff so we only spawn a probe box occasionally instead
            # of burning boxes that all 429. Cap at 30min; resets on any pass.
            consec_rl += 1
            backoff = min(1800, WAVE_BACKOFF * (2 ** consec_rl))
            log(f"wave {wave} fully rate-limited (#{consec_rl} in a row); "
                f"backing off {backoff}s")
            time.sleep(backoff)
        else:
            consec_rl = 0
            time.sleep(WAVE_BACKOFF)
    log("exiting")

if __name__ == "__main__":
    main()
