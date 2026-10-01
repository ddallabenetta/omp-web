# Release Checklist

This repo publishes one artifact: a **GitHub Release** in
`steimerbyte/omp-web`.

There is no npm package. The `publish-npm.yml` workflow inherited from the
fork is disabled, and `OMP_WEB_*` releases are installed from a checkout or a
release tarball. Do not re-enable it without deciding to publish to the
registry again — the package name `omp-web` belongs to the upstream line.

There is also no upstream remote. Pulling upstream changes in is a deliberate
operation: re-add the remote, fetch, and reconcile by hand. See the Provenance
section in the README.

## Before tagging

From a clean checkout of the branch you are releasing:

```bash
git status --porcelain            # must be empty
bun run typecheck
bunx eslint components/ app/ lib/
bun test
bun run build
```

`package.json` and the tag must agree. The release workflow does not check
this, and a mismatch ships a release whose tarball reports the wrong version.

Update `CHANGELOG.md` with what changed, grouped by kind. Say plainly what was
*not* verified — a release note that claims more than was tested is worse than
one that admits the gap.

## Tagging

```bash
git tag -a v0.9.0 -m "v0.9.0"
git push fork v0.9.0
```

Pushing a `v*` tag starts two workflows:

- `publish-desktop.yml` builds macOS (universal) and Windows bundles and uploads
  them to the release. It needs `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` configured; without them the job fails
  and no desktop artifact is produced. The web release is unaffected.
- `update-omp.yml` checks the pinned omp version upstream.

## Writing release notes

`gh release create v0.9.0 --title "v0.9.0" --notes-file CHANGELOG.md`

The notes go on the release page. Keep them honest about what a user has to
configure — an admin deploying this for the first time needs to know that
account creation needs `OMP_WEB_HOME_ROOT` set, and that finding out through a
raw `EACCES` naming the server's own path is a bad first impression.

## Verifying a release

After tagging, check that the thing actually works, not that the workflow went
green:

```bash
gh release view v0.9.0                    # assets present
git ls-remote --tags fork v0.9.0          # tag points where you expect
```

Then install it the way a user would — clone, `bun install`, `bun run build`,
start it — and exercise the multi-account path with two real accounts. A
release that has not been signed into is not a verified release.
