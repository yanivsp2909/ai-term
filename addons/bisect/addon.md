---
name: bisect
summary: "Find the first commit that broke a test with git bisect, no model"
args: "[--no-deps] <test command> [good ref]"
defaultEngine: none
engines: []
skills: []
agents: []
brain: none
worktree: no
readOnly: true
input: command-ref
local: bisect
---
No model and no tokens. AI Term clones the repository into a temporary folder that shares its objects, checks the test passes at the good ref and fails at HEAD, then runs git bisect run there under the test sandbox. Your installed dependency folders (node_modules, .venv, venv, vendor) are linked into the copy read-only, unless the command starts with --no-deps. It shows the first bad commit and its diff, then always runs git bisect reset and removes the temporary folder. Your checkout is never checked out, reset or bisected.
