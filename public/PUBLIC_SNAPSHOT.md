# Public source snapshot · {{DATE}}

This tree was exported with `git archive` from private `main` at commit `{{COMMIT}}` by
`scripts/public-snapshot.mjs` (that script stays in the private repository). The working repository stays private and
is where AI Term is developed. This snapshot has its own one-commit history; none of the private history is in it.

## Left out, and why

{{LEFT_OUT}}

**Shared add-on guides.** Add-ons bundle short guides adapted from skills and agents (`addons/_shared/`). A copy is
kept only when its source states MIT, Apache-2.0 or a BSD license. {{COPIES}} copies state no license (or a mixed one),
so they are left out; `addons/_shared/LEFT_OUT.txt` lists them. Those add-ons still work: an add-on whose guide is
missing runs on its own steps, and its prompt says which guide this build leaves out (`src/daemon/addons.ts`). The
add-ons that run without their guide here: {{FALLBACKS}}.

Some documents still mention files that are left out (PROGRESS.md, `docs/reviews/`, three `docs/spikes/` reports).
Their absence is deliberate. Before the export, the private repository replaced a real Azure resource name, a key
label, a key's last four characters and a time zone in tests and docs with example values.

## Added for the public tree

- `README.md`: a public introduction (what it is, honest status, the security model, no affiliation) followed by the
  private README from its Install section on, which holds the full list of commands and keys.
- `LICENSE` (MIT), `SECURITY.md` (private vulnerability reporting), `THIRD_PARTY_NOTICES.md`, `licenses/Apache-2.0.txt`
  (for the one kept guide adapted from an Apache-2.0 skill), `.gitleaks.toml` (gitleaks' default rules, nothing
  allowlisted), `addons/_shared/LEFT_OUT.txt`, and this file.

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

Nothing here has been published. To publish this snapshot as `yanivsp2909/ai-term-public`, from this folder:

```sh
gh repo create yanivsp2909/ai-term-public --public --description "AI Term: one terminal homepage for AI coding agents (source snapshot)"
git remote add origin https://github.com/yanivsp2909/ai-term-public.git
git push -u origin main
gh api --method PUT repos/yanivsp2909/ai-term-public/private-vulnerability-reporting
gh api repos/yanivsp2909/ai-term-public/private-vulnerability-reporting
```

The last command should print `{"enabled":true}`. Then open
https://github.com/yanivsp2909/ai-term-public/security/advisories/new to see the reporting form SECURITY.md links to.
If the repository gets another name, update the URL in SECURITY.md first.
