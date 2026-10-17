---
name: behavior-coverage
description: Find behavior no test checks and write tests that would fail if that behavior broke.
---
Source: ~/.claude/commands/test-coverage.md (2026-10-16).
License: not stated in the source definition; no redistribution grant inferred.
What changed: replaced the coverage-percentage target with untested behavior; added the rule that each test must fail when its behavior breaks; dropped the framework table and coverage-report parsing; tests only, never production code.

Look for behavior, not lines: branches, error paths, boundary values (empty, zero, negative, maximum), state changes, and what a caller sees. Priority: error handling, then branches, then edge values, then the happy path if it is unchecked. Follow the project's test layout, imports, assertion style and mocking approach; each test independent and named after the behavior. A test counts only if it would fail when its behavior breaks: name that breaking change for every test. Don't write tests that copy the implementation's logic into the expected value, snapshot internals, assert a mock was called with whatever the code passes, or only check that something exists. Run the new tests; a test that fails on the current code is a finding, so report it instead of bending the test. Change test files only.
