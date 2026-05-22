# SWE-bench smoke — recorded run (PENDING official certification)

- **Model / provider**: gpt-5 / openai
- **Date**: 2026-05-22
- **Status**: ⚠️ RECORDED, NOT CERTIFIED. Local `bench` uses `testCmd:"true"` (no-op) and
  the docker daemon is blocked here, so these patches are the agent's *attempts* —
  not yet graded by the official `swebench.harness.run_evaluation`. They all touch the
  correct gold file in a single-file edit, which is necessary but NOT sufficient.
- **Local run**: 6/6 completed (agent produced a patch each, 9–20 turns).

## Certify offline (Docker host)

```sh
# feed these recorded patches to the official harness on a docker-capable machine:
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path tests/smoke/swebench/recordings/predictions.jsonl \
  --run_id quanta-smoke-gpt5
# only instances in resolved_ids are safe to freeze as the always-pass baseline.
```

## Per-instance

| instance | turns | gold file | patch | gold-file hit |
|---|---|---|---|---|
| `psf__requests-5414` | 16 | `requests/models.py` | 29L | ✓ |
| `pallets__flask-5014` | 15 | `src/flask/blueprints.py` | 14L | ✓ |
| `pylint-dev__pylint-4970` | 11 | `pylint/checkers/similar.py` | 27L | ✓ |
| `pytest-dev__pytest-7982` | 20 | `src/_pytest/pathlib.py` | 13L | ✓ |
| `sympy__sympy-16886` | 9 | `sympy/crypto/crypto.py` | 13L | ✓ |
| `sympy__sympy-13480` | 16 | `sympy/functions/elementary/hyperbolic.py` | 13L | ✓ |

## Recorded patches (for eyeball review)

### psf__requests-5414

```diff
diff --git a/requests/models.py b/requests/models.py
index e7d292d5..1a0da30f 100644
--- a/requests/models.py
+++ b/requests/models.py
@@ -394,16 +394,14 @@ class PreparedRequest(RequestEncodingMixin, RequestHooksMixin):
         if not host:
             raise InvalidURL("Invalid URL %r: No host supplied" % url)
 
-        # In general, we want to try IDNA encoding the hostname if the string contains
-        # non-ASCII characters. This allows users to automatically get the correct IDNA
-        # behaviour. For strings containing only ASCII characters, we need to also verify
-        # it doesn't start with a wildcard (*), before allowing the unencoded hostname.
-        if not unicode_is_ascii(host):
-            try:
-                host = self._get_idna_encoded_host(host)
-            except UnicodeError:
-                raise InvalidURL('URL has an invalid label.')
-        elif host.startswith(u'*'):
+        # Validate the hostname and ensure it conforms to IDNA/URL rules.
+        # Always attempt IDNA processing to catch invalid ASCII cases like
+        # leading dots (e.g., '.example.com') in addition to non-ASCII hosts.
+        if host.startswith(u'*'):
+            raise InvalidURL('URL has an invalid label.')
+        try:
+            host = self._get_idna_encoded_host(host)
+        except UnicodeError:
             raise InvalidURL('URL has an invalid label.')
 
         # Carefully reconstruct the network location
```

### pallets__flask-5014

```diff
diff --git a/src/flask/blueprints.py b/src/flask/blueprints.py
index eb50585d..1aa82562 100644
--- a/src/flask/blueprints.py
+++ b/src/flask/blueprints.py
@@ -190,6 +190,9 @@ class Blueprint(Scaffold):
             root_path=root_path,
         )
 
+        if not name:
+            raise ValueError("'name' may not be empty.")
+
         if "." in name:
             raise ValueError("'name' may not contain a dot '.' character.")
```

### pylint-dev__pylint-4970

```diff
diff --git a/pylint/checkers/similar.py b/pylint/checkers/similar.py
index c65b1c893..2279a4bcc 100644
--- a/pylint/checkers/similar.py
+++ b/pylint/checkers/similar.py
@@ -394,6 +394,9 @@ class Similar:
 
     def _compute_sims(self) -> List[Tuple[int, Set[LinesChunkLimits_T]]]:
         """compute similarities in appended files"""
+        # Treat non-positive threshold as disabled: no similarities computed
+        if self.min_lines <= 0:
+            return []
         no_duplicates: Dict[int, List[Set[LinesChunkLimits_T]]] = defaultdict(list)
 
         for commonality in self._iter_sims():
@@ -830,6 +833,12 @@ class SimilarChecker(BaseChecker, Similar, MapReduceMixin):
 
     def close(self):
         """compute and display similarities on closing (i.e. end of parsing)"""
+        # If the user explicitly set min-similarity-lines to 0 or less,
+        # treat it as disabling the duplicate code checker. This mirrors the
+        # behaviour of other linters where a threshold of 0 disables a check
+        # and avoids producing a flood of false positives.
+        if self.min_lines <= 0:
+            return
         total = sum(len(lineset) for lineset in self.linesets)
         duplicated = 0
         stats = self.stats
```

### pytest-dev__pytest-7982

```diff
diff --git a/src/_pytest/pathlib.py b/src/_pytest/pathlib.py
index f0bdb1481..b96cba069 100644
--- a/src/_pytest/pathlib.py
+++ b/src/_pytest/pathlib.py
@@ -558,7 +558,7 @@ def visit(
     entries = sorted(os.scandir(path), key=lambda entry: entry.name)
     yield from entries
     for entry in entries:
-        if entry.is_dir(follow_symlinks=False) and recurse(entry):
+        if entry.is_dir() and recurse(entry):
             yield from visit(entry.path, recurse)
```

### sympy__sympy-16886

```diff
diff --git a/sympy/crypto/crypto.py b/sympy/crypto/crypto.py
index ca552191c0..0c556b6efb 100644
--- a/sympy/crypto/crypto.py
+++ b/sympy/crypto/crypto.py
@@ -1520,7 +1520,7 @@ def decipher_kid_rsa(msg, key):
     "..-": "U", "...-": "V",
     ".--": "W", "-..-": "X",
     "-.--": "Y", "--..": "Z",
-    "-----": "0", "----": "1",
+    "-----": "0", ".----": "1",
     "..---": "2", "...--": "3",
     "....-": "4", ".....": "5",
     "-....": "6", "--...": "7",
```

### sympy__sympy-13480

```diff
diff --git a/sympy/functions/elementary/hyperbolic.py b/sympy/functions/elementary/hyperbolic.py
index 2a4555d919..5fbb73c786 100644
--- a/sympy/functions/elementary/hyperbolic.py
+++ b/sympy/functions/elementary/hyperbolic.py
@@ -587,7 +587,7 @@ def eval(cls, arg):
                 x, m = _peeloff_ipi(arg)
                 if m:
                     cothm = coth(m)
-                    if cotm is S.ComplexInfinity:
+                    if cothm is S.ComplexInfinity:
                         return coth(x)
                     else: # cothm == 0
                         return tanh(x)
```

