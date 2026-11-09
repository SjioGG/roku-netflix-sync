# Public-release audit

Audit date: November 9, 2026. This is a publication-preparation record, not a
claim that the application repository is already public.

## Scope and evidence

The audit covered the working tree, all local Git refs, the 12 commits reachable
from the original remote main branch, eight release tags, all 16 downloaded
release assets and their expanded files, deployment templates, and repository
metadata. GitHub reported no issues, pull requests, repository hooks, custom
Actions secrets, Actions variables, or environments to migrate.

Gitleaks 8.30.1 reported no credential findings in the original working tree,
history scan (17 commits at that checkpoint), or expanded release files. The
independent Cursor / DeepSeek V4.1 Flash review also found no current credentials.
Secret scans do not establish the absence of every kind of private information.
Manual review found real device/network identifiers in historical test fixtures,
which the owner confirmed were personal. None of those three identifiers was
found in the downloaded release assets.

The original source also contained a personal relay default and a personal
filesystem path in a launchd template. Ordinary commit authorship and private
project-ticket references are provenance, not credentials; they have not been
removed or misrepresented. No company-internal service endpoints or credentials
were identified in this personal repository.

## Fixed in the prepared working tree

- Public device fixtures now use explicitly labeled fictional identifiers and
  Wi-Fi names. LAN addresses are documented examples.
- Personal connection settings and device reference notes live in an ignored,
  owner-only `.env`. The Python and desktop entry points load local settings as
  literal data without shell evaluation. Exported settings take precedence;
  saved desktop settings remain intact. Public fixtures do not load these notes.
- Git and Docker ignore rules exclude local settings, recordings, logs, build
  output, and desktop credentials. The extension package contains only its
  manifest and referenced assets.
- The desktop defaults to a loopback relay rather than the author's server.
  The launchd template uses a path placeholder.
- The desktop HTTP API and diagnostic dashboard reject cross-site browser
  operations, foreign Host/Origin values, and non-JSON writes. The desktop
  refuses non-loopback binds. The Docker relay port is loopback-bound by default.
- Routine desktop state responses omit the room token. Show/Copy explicitly
  retrieve it, and other settings changes preserve a masked token. Config writes
  use owner-only file permissions.
- Electron rejects unexpected navigation, new windows, and IPC from other
  renderer frames. Relay clients require HTTPS except on loopback; authenticated
  bridge requests do not follow redirects.
- The sync estimate no longer claims measured frame alignment. `PRIVACY.md` is
  canonical and generates the bundled policy through `bin/render-privacy.py`.

## Verification

All 154 Python tests and the JavaScript checks passed, including the 40 desktop
checks. New regressions cover the actual localhost HTTP routes, DNS rebinding,
non-JSON requests, explicit token retrieval, preserved/cleared saved tokens,
transport redirects, unsafe relay URLs, local settings loading, and permissions.
The extension package and generated privacy policy checks passed.

## Remaining boundaries

The desktop HTTP UI trusts local processes and has no separate account login;
it is for a trusted desktop. The shared room token grants full room/device
control. There is no built-in authentication rate limiter. Hosted deployments
need a suitable HTTPS proxy and operator controls.

No live streaming-account/Roku or native permission-dialog end-to-end validation
was added by this audit. Netflix contractual authorization remains unverified.
Older code versions remain older code even if their identifying examples are
sanitized. The initially uploaded Web Store draft predates these additional
repository hardening changes. See compliance-verification.md for the subsequent
0.3.4 interactive checks and resubmission record.

## Publication gate

Replacing current fixtures does not remove their original values from Git
history. The original remote therefore remains private pending a reviewed
migration. GitHub documents that force-pushing rewritten history alone may leave
old commits accessible through cached references. A separate, non-fork public
repository with sanitized history avoids exposing the private object store.
Keep an owner-only backup of the original repository and releases. Do not push
local agent checkpoint refs, private `.env` files, or old release archives to the
public repository.

Reference: [GitHub's sensitive-data removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

## Publication completed

The owner approved the archive/replacement migration. Sanitized main and eight
sanitized version tags were published to a fresh independent public repository
at the original URL. The original repository, object history, and eight releases
remain private in a separate archive. Local private settings were preserved.
Actions were disabled during import to avoid releasing historical versions.
