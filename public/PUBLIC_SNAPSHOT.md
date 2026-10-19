# Public source snapshot · {{DATE}}

This tree was exported with `git archive` from private `main` at commit `{{COMMIT}}` by
`scripts/public-snapshot.mjs` (that script stays in the private repository). The working repository stays private and
is where AI Term is developed. This snapshot has its own one-commit history; none of the private history is in it.

## Left out, and why

{{LEFT_OUT}}

**Add-on guides.** Each model add-on bundles its own guide from `addons/guides/` ({{GUIDES}} guides). They were
written for AI Term, without the earlier adapted copies whose sources stated no license, and are under its MIT license.

Some documents still mention files that are left out (PROGRESS.md, `docs/reviews/`, `docs/addons/inventory.md`, three
`docs/spikes/` reports). Their absence is deliberate. AGENTS.md and CLAUDE.md describe the private development rules
(they mention PROGRESS.md and `.claude/`); they are kept as context, not as instructions for this repository. Before the export, the private repository replaced a real Azure resource name, a key
label, a key's last four characters and a time zone in tests and docs with example values.

## Added for the public tree

- `README.md`: a public introduction (what it is, honest status, the security model, no affiliation) followed by the
  private README from its Install section on, which holds the full list of commands and keys.
- `LICENSE` (MIT), `SECURITY.md` (private vulnerability reporting), `THIRD_PARTY_NOTICES.md`, `.gitleaks.toml`
  (gitleaks' default rules, nothing allowlisted), and this file.
- In `docs/design.md`, the links to the private design mockups are replaced by a sentence saying they are private.

## Verification

{{VERIFICATION}}

To check a fresh checkout yourself (Node 22 or newer, git 2.41 or newer):

```sh
npm ci
npm run typecheck
npm run lint
npm run build
npm test
gitleaks git --redact --config .gitleaks.toml .
```

Some tests are skipped with their reason in the title where a platform tool is missing (bubblewrap on Linux, vim,
xdg-open) or when they run as root. Checks that need real logins, real keys, a phone or the packaged app are manual
and not part of this snapshot.

## Future refreshes

Export a newer private commit into a new, empty folder with `node scripts/public-snapshot.mjs <folder> <commit>`,
run the checks above and the script's own personal-marker check, then compare it with the published tree. Copy only
the curated content into the public checkout, keep its `.git`, and add one new commit. Never mirror or fork the
private repository or import its refs.

## Publishing (for the maintainer)

Nothing here has been published. The folder holds one commit. From this folder, first scan it, then create the
repository, turn on private vulnerability reporting before any code is public, and only then push:

```sh
gitleaks git --redact --config .gitleaks.toml .
gh repo create yanivsp2909/ai-term-public --public --description "AI Term: one terminal homepage for AI coding agents (source snapshot)"
gh api --method PUT repos/yanivsp2909/ai-term-public/private-vulnerability-reporting
gh api repos/yanivsp2909/ai-term-public/private-vulnerability-reporting
git remote add origin https://github.com/yanivsp2909/ai-term-public.git
git push -u origin main
```

The fourth command should show `"enabled": true`. If gitleaks reports a test fixture, build that value from parts at
run time in the private repository and export again rather than allowlisting it. After the push, open
https://github.com/yanivsp2909/ai-term-public/security/advisories/new to see the reporting form SECURITY.md links to.
If the repository gets another name, update the URL in SECURITY.md first.
