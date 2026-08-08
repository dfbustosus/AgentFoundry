# Releasing AgentFoundry

This repository uses SemVer, API Extractor compatibility reports, GitHub
Releases, and npm trusted publishing. A release is a controlled promotion of
an artifact that already passed CI — never a build performed on a laptop.

## Version policy (0.x)

| Change | Version bump | Required evidence |
|---|---|---|
| Backward-compatible fix | patch | regression test + CHANGELOG |
| New backward-compatible public API | minor | tests + reviewed API report |
| Breaking public API | minor (while 0.x) | migration note + explicit API report review |
| Release candidate | `-rc.N` | all gates green; publish under npm tag `next` |

Stable releases publish under npm tag `latest`. Pre-release versions (`rc`,
`beta`, `alpha`) publish under `next`.

## Required local gate

Run from `agent-systems/`:

```bash
npm ci
npm audit
npm run lint
npm run typecheck
npm test
npm run package:verify
```

`package:verify` checks the committed API report, runs `publint` and
AreTheTypesWrong, packs the real tarball, installs it into a clean temporary
consumer, compiles the public API under strict TypeScript, and executes it.

## Intentional public API changes

```bash
npm run api:update
git diff -- etc/agent-systems-foundry.api.md
```

Review the API diff as a contract change. Commit it only when intentional.
CI runs `npm run api:check`; an accidental API change fails the package job.

## Release procedure

1. Move entries from `[Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD` in
   `CHANGELOG.md`; update compare links.
2. Set the exact same version in `agent-systems/package.json` and lockfile.
3. Run the full local gate above.
4. Commit and push; wait for every CI job to pass.
5. Create and push an annotated tag:

   ```bash
   git tag -a vX.Y.Z -m "Release X.Y.Z"
   git push origin vX.Y.Z
   ```

6. `release.yml` creates the GitHub Release from the matching CHANGELOG
   section. Hyphenated versions are marked pre-release.
7. The published GitHub Release triggers `npm-publish.yml`, which waits for
   approval in the protected `npm-production` environment, re-runs every gate,
   verifies tag/package-version equality, then publishes with OIDC.
8. The workflow verifies the exact version from the public registry.

## One-time npm bootstrap (maintainer action)

The package name `agent-systems-foundry` was unclaimed when checked on
2026-08-08. No npm account is authenticated on the development machine.

1. Sign in or create the owning npm account and enable 2FA.
2. If npm requires a package to exist before trusted publishing can be
   configured, perform the first publish manually with 2FA after all gates
   pass. Do not create an automation token.
3. On npmjs.com → package Settings → Trusted Publisher, configure:
   - Provider: GitHub Actions
   - GitHub user/organization: `dfbustosus`
   - Repository: `AgentFoundry`
   - Workflow filename: `npm-publish.yml`
   - Environment: `npm-production`
   - Allowed action: `npm publish`
4. Set publishing access to require 2FA and disallow tokens after trusted
   publishing is verified.

Trusted publishing requires npm CLI 11.5.1+ and Node 22.14+. The workflow pins
Node 24 and npm 11.19.0. It stores no `NPM_TOKEN`; GitHub mints a short-lived
OIDC token, and npm generates provenance automatically.

## Rollback

Do not unpublish a consumed version except for a security emergency that meets
npm's unpublish policy. Prefer:

1. `npm deprecate agent-systems-foundry@X.Y.Z "reason; use X.Y.(Z+1)"`;
2. publish a corrected patch;
3. update the GitHub Release with impact and migration notes.
