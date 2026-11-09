# Version 0.3.3 verification

Initial November 9, 2026 checkpoint: changes were uncommitted on top of
`091de5023a1e042661c8e141f1c162a064231990`.

## Implemented

- Sync remains off on new and existing installations until explicit data-sharing consent and enablement. Consent is bound to the chosen relay origin.
- The popup requests optional access for the chosen relay hostname during Save. It rejects remote HTTP, credentials embedded in URLs, paths, and queries. The background checks the grant and rechecks consent/settings after the asynchronous permission lookup. Requests reject redirects and omit ambient cookies.
- Withdrawal stops new relay requests and playback controls. Forget clears local connection settings. Changing an active relay or room token detaches old-room controls and requires a streaming-tab reload.
- The Roku readiness timeout resumes native playback instead of leaving Chrome paused. Existing sync and private Netflix player bridge functionality are retained.
- A bundled privacy policy, accurate experimental-service/setup disclosures, store copy, dashboard instructions, and an authentic unconfigured popup screenshot are included.

## Passed checks

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
for test in tests/*.cjs; do node "$test" || exit 1; done
./bin/package-extension.sh
unzip -t dist/roku-netflix-sync-extension.zip
git diff --check
```

At the initial extension checkpoint, all 146 Python tests and the JavaScript checks passed. Added coverage exercises
missing and withdrawn consent, relay changes, permission denial/revocation,
withdrawal during the permission check, credential forgetting, and readiness
timeout recovery. Existing content/background fixtures now explicitly model
consented users rather than relying on implicit enablement.

Google Chrome for Testing 143.0.7499.4 loaded the unpacked extension in an
isolated temporary profile. The default-off popup rendered without page errors,
and its privacy link opened the packaged policy successfully. The actual popup
was captured at 1280 x 800 in `screenshots/popup-0.3.3.png`. It represents setup,
not an active playback demonstration.

## Still external or unverified

- Headless Chromium displayed/pended the optional host permission request but did not resolve its native approval dialog. Interactive Chrome approval still needs checking. Grant and denial behavior is covered by the popup/background tests.
- No live streaming-account or physical Roku end-to-end test was performed in this change. Service parity and exact timing are not claimed.
- At the initial source-verification checkpoint, the developer dashboard had not yet been modified. Publish the public policy, confirm deployed relay operators/providers/logging, replace rejected screenshots, and update listing/privacy/reviewer fields using `chrome-web-store.md` before resubmission.
- The original blank-block screenshot remains on disk for preservation and must not be uploaded again.
- Automatic Netflix synchronization still has unverified contractual compatibility. The changes do not establish Netflix authorization, legal approval, or Chrome Web Store acceptance. Removing automatic Netflix control would materially change the app and was not done.

## Developer dashboard update

On November 9, 2026, the signed-in Chrome Web Store dashboard was updated as
a draft. The detailed description and public links were corrected, the rejected
blank-block screenshot was replaced with the actual popup, and data categories
were set to authentication information, location (connection IP), web history
(current media), user activity, and website content. The original three
limited-use declarations were already selected and were preserved. Remote code
remains No. Distribution was already Unlisted and was preserved.

Public policy: https://sjiogg.github.io/roku-sync-privacy/
Public policy/support repository: https://github.com/SjioGG/roku-sync-privacy
Pages build commit: `24b24a9f0cd1cc0da3202b6d09aa9d0621e815f4`.
The policy page was verified in an anonymous browser profile. At that dashboard-update checkpoint, the app repository was still private. An earlier temporary Sites copy was changed
to owner-only access after GitHub Pages was chosen.

The draft package was verified as version 0.3.3 after upload. The saved privacy
policy URL was rechecked as https://sjiogg.github.io/roku-sync-privacy/ and the
Submit for review button became available. It was not clicked.

At that checkpoint, reviewer instructions still required a usable dedicated
review relay/token or relay-source access; making the audited source public
would enable the documented local-review procedure. No personal room credentials were supplied to
Google, and no review submission was made.

## Subsequent publication-security verification

The subsequent repository audit passed all 154 Python tests and all JavaScript
checks, including 40 desktop checks. Local settings are ignored and owner-only;
public fixtures use fictional device identifiers. See `publication-audit.md` for
scope, fixes, historical-data limits, and the pending publication migration.

## Resubmission verification, version 0.3.4

Terra independently reviewed consent, optional permissions, metadata, and the
reviewer procedure. No new consent/permission bypass was identified. Interactive
Chrome testing then reproduced a popup lifecycle bug: the native host-permission
dialog closed the popup before Save could finish. Setup now carries its draft in
extension-only session storage to a persistent settings tab and commits only
after the user Saves there and grants access. Regression coverage fails on the
old flow and passes on the replacement.

Chrome's real host-permission approval and subsequent Saved state were observed.
Two YouTube tabs demonstrated play/pause, seek following, and master-baton
transfer. Both paused at the same reported playback position. Disabling sync and
Forget were checked interactively.

After the owner explicitly resumed on their private network, the configured
Roku Smart Soundbar was identified against private local reference values. The
public Blender test film opened on the TV, confirmed through the camera, and
Chrome play/pause changes matched the soundbar's reported play/pause states.
The initial launch status timed out before playback started; launch timing and
frame accuracy remain unproven. No Netflix account playback was tested.

The sanitized source repository is now public, while the original history and
releases remain in a separate private archive. The public policy is canonical
in PRIVACY.md. The Web Store must receive the new 0.3.4 package before submission.
The final 0.3.4 JavaScript checks and generated-policy check passed. A fresh
real setup-tab capture was cropped to the extension form and padded to 1280 x 800 for the listing, preserving its
visible contents. After Disable/Forget, client telemetry remained unchanged;
the test relay was then stopped and the TV left paused.

## Submitted for review

On November 9, 2026, the Chrome Web Store accepted resubmission of version
0.3.4. The dashboard showed “Afventer gennemgang” (Awaiting review). Unlisted
distribution was verified and preserved. Automatic publication after approval
remained selected in Google's submission dialog.

The submitted ZIP was built from code revision `af3a3d6`, with the actual
0.3.4 setup-tab screenshot, updated disclosure/storage justifications, public
source/support links, and canonical public privacy-policy URL:
https://github.com/SjioGG/roku-netflix-sync/blob/main/PRIVACY.md .
Anonymous policy access was verified. The separate free Pages copy was also
updated, and its build completed successfully.

The saved reviewer field provides the public source/setup guide and a local
loopback relay command using only a synthetic fixture token. It explicitly
requires no Roku hardware or streaming login and covers the second Save in
the persistent setup tab, two-tab playback, baton transfer, and disabling sync.
No personal relay credentials or device addresses were provided to Google.

Public release: https://github.com/SjioGG/roku-netflix-sync/releases/tag/v0.3.4
with fresh `build.tar.gz` and extension ZIP assets. Older original releases
remain in the private archive. The test relay was stopped, sync settings
cleared, camera application closed, and the soundbar left paused. Store review
is pending; acceptance, contractual authorization, frame accuracy, and other
service/hardware combinations have not been established.

## Metadata correction after Yellow Argon

Google subsequently rejected the description for keyword spam (Yellow Argon),
identifying its streaming-service brand list. The public listing description
was rewritten around actual playback controls, setup requirements, data sharing,
and limitations. The brand catalogue and remaining third-party service names
were removed from that description. This changes metadata only; the submitted
0.3.4 package, permissions, policy, screenshot, and functionality were retained.
No device connection or TV testing was needed for this correction.

The developer dashboard confirmed the revised description was saved (1,684
characters). Resubmission succeeded, and the item again showed
“Afventer gennemgang” (Awaiting review). Existing unlisted distribution and
automatic publication after approval were retained. This is a submission
record, not a guarantee of approval.

Reference: https://developer.chrome.com/docs/webstore/program-policies/listing-requirements
