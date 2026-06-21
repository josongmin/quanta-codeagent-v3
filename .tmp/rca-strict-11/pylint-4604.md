# pylint-4604  (repo: pylint-dev/pylint)
HASH: 0/134 solved it · tier ×
GRADE: {"resolved":false,"failToPassFailed":21,"passToPassFailed":0,"passToPassTotal":0}
FAIL_TO_PASS: ["tests/checkers/unittest_variables.py::TestVariablesChecker::test_bitbucket_issue_78", "tests/checkers/unittest_variables.py::TestVariablesChecker::test_no_name_in_module_skipped", "tests/checkers/unittest_variables.py::TestVariablesChecker::test_all_elements_without_parent", "tests/checkers/unittest_variables.py::TestVariablesChecker::test_redefined_builtin_ignored", "tests/checkers/unittest_variables.py::TestVariablesChecker::test_redefined_builtin_custom_modules", "tests/checkers/unittest_variables.py::TestVariablesChecker::test_redefined_builtin_modname_not_ignored", "tests/checkers/unittest_variables.py::TestVariablesChecker::test_redefined_builtin_in_function", "tests/checkers/unittest_variables.py::TestVariablesChecker::test_unassigned_global", "tests/checkers/unittest_variables.py::TestVariablesChecker::test_listcomp_in_decorator", "tests/checkers/unittest_variables.py::TestVariablesChecker::test_listcomp_in_ancestors", "tests/checkers/unittest_variables.py::TestVariablesChecker::test_return_type_annotation", "tests/checkers/unittest_variables.py::TestVariablesChecker::test_attribute_in_type_comment", "tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_custom_callback_string", "tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_redefined_builtin_modname_not_ignored", "tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_redefined_builtin_in_function", "tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_import_as_underscore", "tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_lambda_in_classdef", "tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_nested_lambda", "tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_ignored_argument_names_no_message", "tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_ignored_argument_names_starred_args", "tests/checkers/unittest_variables.py::TestMissingSubmodule::test_package_all"]
PASS_TO_PASS_count: 0

## PROBLEM STATEMENT
unused-import false positive for a module used in a type comment
### Steps to reproduce

```python
"""Docstring."""

import abc
from abc import ABC

X = ...  # type: abc.ABC
Y = ...  # type: ABC
```

### Current behavior

```
************* Module a
/tmp/a.py:3:0: W0611: Unused import abc (unused-import)

-----------------------------------
Your code has been rated at 7.50/10
```

### Expected behavior

`unused-import` should not be emitted.

### pylint --version output

Result of `pylint --version` output:

```
pylint 2.8.3
astroid 2.5.6
Python 3.9.2 (default, Feb 28 2021, 17:03:44) 
[GCC 10.2.1 20210110]
```

This is a follow up to #3112.


## GOLD PATCH (oracle — canonical correct fix)
diff --git a/pylint/checkers/variables.py b/pylint/checkers/variables.py
--- a/pylint/checkers/variables.py
+++ b/pylint/checkers/variables.py
@@ -1826,6 +1826,10 @@ def _store_type_annotation_node(self, type_annotation):
             self._type_annotation_names.append(type_annotation.name)
             return
 
+        if isinstance(type_annotation, astroid.Attribute):
+            self._store_type_annotation_node(type_annotation.expr)
+            return
+
         if not isinstance(type_annotation, astroid.Subscript):
             return
 
diff --git a/pylint/constants.py b/pylint/constants.py
--- a/pylint/constants.py
+++ b/pylint/constants.py
@@ -1,6 +1,7 @@
 # Licensed under the GPL: https://www.gnu.org/licenses/old-licenses/gpl-2.0.html
 # For details: https://github.com/PyCQA/pylint/blob/master/LICENSE
 
+import platform
 import sys
 
 import astroid
@@ -11,6 +12,7 @@
 PY39_PLUS = sys.version_info[:2] >= (3, 9)
 PY310_PLUS = sys.version_info[:2] >= (3, 10)
 
+IS_PYPY = platform.python_implementation() == "PyPy"
 
 PY_EXTS = (".py", ".pyc", ".pyo", ".pyw", ".so", ".dll")
 


## TEST PATCH (the tests grading uses)
diff --git a/tests/checkers/unittest_variables.py b/tests/checkers/unittest_variables.py
--- a/tests/checkers/unittest_variables.py
+++ b/tests/checkers/unittest_variables.py
@@ -21,11 +21,13 @@
 import os
 import re
 import sys
+import unittest
 from pathlib import Path
 
 import astroid
 
 from pylint.checkers import variables
+from pylint.constants import IS_PYPY
 from pylint.interfaces import UNDEFINED
 from pylint.testutils import CheckerTestCase, Message, linter, set_config
 
@@ -191,6 +193,24 @@ def my_method(self) -> MyType:
         with self.assertNoMessages():
             self.walk(module)
 
+    @unittest.skipIf(IS_PYPY, "PyPy does not parse type comments")
+    def test_attribute_in_type_comment(self):
+        """Ensure attribute lookups in type comments are accounted for.
+
+        https://github.com/PyCQA/pylint/issues/4603
+        """
+        module = astroid.parse(
+            """
+        import foo
+        from foo import Bar, Boo
+        a = ... # type: foo.Bar
+        b = ... # type: foo.Bar[Boo]
+        c = ... # type: Bar.Boo
+        """
+        )
+        with self.assertNoMessages():
+            self.walk(module)
+
 
 class TestVariablesCheckerWithTearDown(CheckerTestCase):
 


## OUR PATCH (gpt-5.4, agentless-v3-thin-strict) — FAILED
diff --git a/pylint/checkers/variables.py b/pylint/checkers/variables.py
index 3ddafd599..8036514ff 100644
--- a/pylint/checkers/variables.py
+++ b/pylint/checkers/variables.py
@@ -1241,6 +1241,7 @@ class VariablesChecker(BaseChecker):
 
     def leave_assign(self, node):
         self._store_type_annotation_names(node)
+        self._store_type_annotation_node(node.type_annotation)
 
     def leave_with(self, node):
         self._store_type_annotation_names(node)

