# astropy-13033  (repo: astropy/astropy)
HASH: 2/134 solved it · tier H
GRADE: {"resolved":false,"failToPassFailed":1,"passToPassFailed":1,"passToPassTotal":20}
FAIL_TO_PASS: ["astropy/timeseries/tests/test_sampled.py::test_required_columns"]
PASS_TO_PASS_count: 20

## PROBLEM STATEMENT
TimeSeries: misleading exception when required column check fails.
<!-- This comments are hidden when you submit the issue,
so you do not need to remove them! -->

<!-- Please be sure to check out our contributing guidelines,
https://github.com/astropy/astropy/blob/main/CONTRIBUTING.md .
Please be sure to check out our code of conduct,
https://github.com/astropy/astropy/blob/main/CODE_OF_CONDUCT.md . -->

<!-- Please have a search on our GitHub repository to see if a similar
issue has already been posted.
If a similar issue is closed, have a quick look to see if you are satisfied
by the resolution.
If not please go ahead and open an issue! -->

<!-- Please check that the development version still produces the same bug.
You can install development version with
pip install git+https://github.com/astropy/astropy
command. -->

### Description
<!-- Provide a general description of the bug. -->

For a `TimeSeries` object that has additional required columns (in addition to `time`), when codes mistakenly try to remove a required column, the exception it produces is misleading.

### Expected behavior
<!-- What did you expect to happen. -->
An exception that informs the users required columns are missing.

### Actual behavior
The actual exception message is confusing:
`ValueError: TimeSeries object is invalid - expected 'time' as the first columns but found 'time'`

### Steps to Reproduce
<!-- Ideally a code example could be provided so we can run it ourselves. -->
<!-- If you are pasting code, use triple backticks (```) around
your code snippet. -->
<!-- If necessary, sanitize your screen output to be pasted so you do not
reveal secrets like tokens and passwords. -->

```python
from astropy.time import Time
from astropy.timeseries import TimeSeries

time=Time(np.arange(100000, 100003), format='jd')
ts = TimeSeries(time=time, data = {"flux": [99.9, 99.8, 99.7]})
ts._required_columns = ["time", "flux"]                                   
ts.remove_column("flux")

```

### System Details
<!-- Even if you do not think this is necessary, it is useful information for the maintainers.
Please run the following snippet and paste the output below:
import platform; print(platform.platform())
import sys; print("Python", sys.version)
import numpy; print("Numpy", numpy.__version__)
import erfa; print("pyerfa", erfa.__version__)
import astropy; print("astropy", astropy.__version__)
import scipy; print("Scipy", scipy.__version__)
import matplotlib; print("Matplotlib", matplotlib.__version__)
-->
```
Windows-10-10.0.22000-SP0
Python 3.9.10 | packaged by conda-forge | (main, Feb  1 2022, 21:21:54) [MSC v.1929 64 bit (AMD64)]
Numpy 1.22.3
pyerfa 2.0.0.1
astropy 5.0.3
Scipy 1.8.0
Matplotlib 3.5.1
```


## GOLD PATCH (oracle — canonical correct fix)
diff --git a/astropy/timeseries/core.py b/astropy/timeseries/core.py
--- a/astropy/timeseries/core.py
+++ b/astropy/timeseries/core.py
@@ -55,6 +55,13 @@ class BaseTimeSeries(QTable):
     _required_columns_relax = False
 
     def _check_required_columns(self):
+        def as_scalar_or_list_str(obj):
+            if not hasattr(obj, "__len__"):
+                return f"'{obj}'"
+            elif len(obj) == 1:
+                return f"'{obj[0]}'"
+            else:
+                return str(obj)
 
         if not self._required_columns_enabled:
             return
@@ -76,9 +83,10 @@ def _check_required_columns(self):
 
             elif self.colnames[:len(required_columns)] != required_columns:
 
-                raise ValueError("{} object is invalid - expected '{}' "
-                                 "as the first column{} but found '{}'"
-                                 .format(self.__class__.__name__, required_columns[0], plural, self.colnames[0]))
+                raise ValueError("{} object is invalid - expected {} "
+                                 "as the first column{} but found {}"
+                                 .format(self.__class__.__name__, as_scalar_or_list_str(required_columns),
+                                            plural, as_scalar_or_list_str(self.colnames[:len(required_columns)])))
 
             if (self._required_columns_relax
                     and self._required_columns == self.colnames[:len(self._required_columns)]):


## TEST PATCH (the tests grading uses)
diff --git a/astropy/timeseries/tests/test_sampled.py b/astropy/timeseries/tests/test_sampled.py
--- a/astropy/timeseries/tests/test_sampled.py
+++ b/astropy/timeseries/tests/test_sampled.py
@@ -395,6 +395,14 @@ def test_required_columns():
     assert exc.value.args[0] == ("TimeSeries object is invalid - expected "
                                  "'time' as the first column but found 'banana'")
 
+    # https://github.com/astropy/astropy/issues/13009
+    ts_2cols_required = ts.copy()
+    ts_2cols_required._required_columns = ['time', 'a']
+    with pytest.raises(ValueError) as exc:
+        ts_2cols_required.remove_column('a')
+    assert exc.value.args[0] == ("TimeSeries object is invalid - expected "
+                                 "['time', 'a'] as the first columns but found ['time', 'b']")
+
 
 @pytest.mark.parametrize('cls', [BoxLeastSquares, LombScargle])
 def test_periodogram(cls):


## OUR PATCH (gpt-5.4, agentless-v3-thin-strict) — FAILED
diff --git a/astropy/timeseries/core.py b/astropy/timeseries/core.py
index c279f35f87..6f474752bb 100644
--- a/astropy/timeseries/core.py
+++ b/astropy/timeseries/core.py
@@ -76,6 +76,14 @@ class BaseTimeSeries(QTable):
 
             elif self.colnames[:len(required_columns)] != required_columns:
 
+                missing_columns = [name for name in required_columns
+                                   if name not in self.colnames]
+                if missing_columns:
+                    raise ValueError("{} object is invalid - missing required column{} '{}'"
+                                     .format(self.__class__.__name__,
+                                             's' if len(missing_columns) > 1 else '',
+                                             "', '".join(missing_columns)))
+
                 raise ValueError("{} object is invalid - expected '{}' "
                                  "as the first column{} but found '{}'"
                                  .format(self.__class__.__name__, required_columns[0], plural, self.colnames[0]))

