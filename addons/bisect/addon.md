---
name: bisect
summary: "Find the first commit that broke a test with git bisect, no model"
args: "<test command> [good ref]"
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
No model and no tokens. AI Term clones the repository into a temporary folder that shares its objects, checks the test passes at the good ref and fails at HEAD, then runs git bisect run there under the test sandbox. It shows the first bad commit and its diff, then always runs git bisect reset and removes the temporary folder. Your checkout is never checked out, reset or bisected.
