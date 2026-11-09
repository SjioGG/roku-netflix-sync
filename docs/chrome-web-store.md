# Chrome Web Store submission

These materials describe the extension in this repository. Copy the reviewed
text into the developer dashboard and replace the previously rejected media.
Changing source files does not update an existing store listing or its privacy
declarations. Do not claim compliance or review completion until the checklist
below is complete.

## Listing copy

Name: **roku-sync**

Short description:

> Experimental playback sync between Chrome tabs or a Roku, using a relay you configure. Requires setup and authorized content access.

Detailed description:

> roku-sync synchronizes playback between Chrome tabs, or between Chrome and a
> Roku through a relay you configure.
>
> Setup is required. You need a running roku-sync relay and its room token. Roku
> mode also requires a reachable Roku and, for a cloud relay, the home bridge
> software. Browser-to-browser mode works without a Roku: participants open the
> same video, and one tab controls play, pause, and seek while others follow.
>
> Use your streaming site's normal playback controls. The extension adds a
> status badge and a popup for connection settings, mode selection, and turning
> sync off. Automatic synchronization is experimental. Playback accuracy is not
> guaranteed, exact Roku timestamp seeking is unsupported, and some titles or
> players may need manual alignment.
>
> Experimental integrations are included for Netflix, YouTube, Plex, Prime
> Video, Disney+, Max, Apple TV, Hulu, and Twitch. Capabilities vary by service.
> Netflix and YouTube have Roku title-launch requests. Other integrations may
> open only the Roku app, requiring manual title selection. Roku-to-browser
> playback handling and badge re-sync currently target Netflix watch pages.
>
> Before connecting, review and accept the data-sharing disclosure. While sync
> is enabled, the extension sends the current service and media identifier,
> playback position, play/pause and buffer state, timestamps, and a random
> per-tab identifier to your relay. The relay operator and anyone with the room
> token can access room state and control playback. Use a relay you trust.
> Disable sync in the popup to stop further relay requests.
>
> Each participant needs authorized access to the selected content. The
> extension does not supply subscriptions, bypass access restrictions, or
> distribute video. It is unofficial and is not affiliated with or endorsed by
> Roku, Netflix, or the other streaming services.
>
> A running relay and room token must be supplied by you or the publisher.
> Privacy policy: https://sjiogg.github.io/roku-sync-privacy/

Keep the data-sharing paragraph visible in the listing before installation.
Provide the public privacy-policy link in the dashboard's designated field.
The separate desktop microphone/ANC tools are not extension features and should
not appear as features or screenshots of this Chrome listing.

## Privacy practices

Single purpose:

> Synchronize playback among participating Chrome tabs and an optional Roku
> through a user-configured relay.

Permission justifications:

| Access | Justification |
| --- | --- |
| `storage` | Save the relay address, room token, sync mode, enable setting, explicit data-sharing consent, and optional timing trim locally so the user can reconnect without entering them each time. |
| Streaming-site content scripts | Detect the selected media and playback state, display the sync badge, and apply play/pause/seek synchronization on the listed services. Site matches cover single-page navigation between titles. No access to unrelated browsing sites is requested for content scripts. Netflix's packaged page-world bridge accesses its player for seeking. |
| Optional HTTPS relay hosts and loopback HTTP relay hosts | Connect to the relay selected by the user to exchange authenticated playback state and commands. Request access for the chosen host during setup, rather than granting access to every HTTPS host at installation. HTTP is allowed only for loopback relays. |

Use the dashboard's current category definitions. The implementation handles
user data even when the relay is self-hosted. Disclose at least these categories
where the dashboard offers them:

| Data category | Actual handling |
| --- | --- |
| Website content | Service and media identifiers derived from the currently viewed streaming page, including a title ID or normalized path/key. No video/audio stream is uploaded. |
| User activity | Playback position, play/pause and buffer state, timing, sync controls, and a random per-tab identifier. |
| Authentication information | The user-entered room token is saved in local extension storage and sent to the selected relay as bearer authorization. It is not a streaming-service password. |
| Location | The relay receives the connection IP address. The dashboard explicitly includes IP addresses in this category; no GPS or location API is requested. |
| Web history | The service/media identifiers reveal which supported streaming title is being viewed. Disclose this limited viewing activity where the dashboard's browsing-history category covers it; do not claim collection of general browsing history or complete page URLs. |

The relay receives network metadata such as the connecting IP address. If a
hosted relay, proxy, tunnel, or hosting provider stores access logs or processes
additional data, reflect its actual practices in the published policy and
dashboard categories. Do not infer that a random client ID makes viewing data
anonymous.

For remote code, select **No, I am not using remote code** for this package:
executable extension JavaScript is bundled locally. The relay exchanges JSON
state and fixed playback commands, not downloaded JavaScript. Recheck this
declaration if the implementation changes.

Data is used for the disclosed synchronization feature, not advertising,
profiling for unrelated purposes, or sale. Certify the dashboard's limited-use
statements only after confirming that the deployed relay and any providers also
follow them. Do not select a blanket “no user data” declaration.

## Publish the privacy policy

The canonical policy is [PRIVACY.md](../PRIVACY.md). The extension bundles HTML
generated from it by `bin/render-privacy.py`. After publication, the public
Markdown URL can replace the separate page:
`https://github.com/SjioGG/roku-netflix-sync/blob/main/PRIVACY.md`.
The public policy is published at https://sjiogg.github.io/roku-sync-privacy/
from the separate public repository https://github.com/SjioGG/roku-sync-privacy.
After the application repository passes its publication audit and becomes public,
reviewers can obtain the relay source there. Until then, use the existing public
policy/support repository; do not assume a private source URL works for reviewers.
GitHub Pages publishes `index.html` from `main` at the repository root. Update
the public copy when the bundled policy changes. A local path or
`chrome-extension://` URL is not a public policy URL.

Before offering a hosted relay, identify its operator and contact route, any
hosting/tunnel providers that process data, and actual retention/deletion
practices. The bundled relay keeps state in process memory. Removal of stale
client entries during subsequent telemetry does not guarantee all room state
is deleted after a fixed interval; a relay restart clears its in-memory state.
Infrastructure access logs and other operators' deployments may differ.

## Reviewer setup

Provide these instructions in the dashboard's reviewer/test instructions field.
Reviewers need access to the relay source or a dedicated review relay. The local
procedure below works after the application repository is public, or when source
access has otherwise been provided. Do not supply a personal room token.
Use a temporary review environment or run the supplied local relay. Do not
publish a real room token, personal playback history, or private device address.

1. Clone `https://github.com/SjioGG/roku-netflix-sync` (requires public visibility or separately provided access), enter its directory, and run `SYNC_HOST=127.0.0.1 SYNC_TOKEN='review-fixture-only' ROKU_BRIDGE_ONLY=1 python3 sync_server.py` with Python 3. The example token is only for an isolated local test; do not expose this relay publicly.
2. Install the submitted extension. Open its popup, use relay URL `http://127.0.0.1:8766` and token `review-fixture-only`, and choose **Browser-to-Browser (Master/Slave, No Roku)**.
3. Read the disclosure, explicitly accept data sharing, enable sync, and save. Approve Chrome's request for access to the chosen relay host if shown.
4. Open the same playable YouTube video in two tabs and interact with each player once to allow playback. Use content the reviewer is authorized to access, with matching playback versions; do not use a login, paid title, or geo-restricted video as the only review path. Reload the tabs after setup if needed.
5. Check the badge to identify the master and follower. Play, pause, and seek using the master's normal video controls. The follower should reflect the changes. Click the badge or popup baton button to transfer control.
6. Disable sync in the popup. Confirm subsequent playback stays local and relay polling stops. Re-enable to reconnect.

Roku mode is an additional path and requires real hardware. Configure a
reachable Roku or run `roku_client.py` on its LAN with the same relay/token, then
select **Roku + Browser**. Netflix and YouTube title-launch requests should be
checked on the TV; HTTP acknowledgements do not prove the correct title or
frame appeared. Do not claim this hardware path was verified by the
browser-only review procedure.

## Screenshots and submission checklist

Capture the actual submitted version. Use the dimensions and file formats
currently required by the dashboard. Do not upload mockups, generated
screenshots, developer dashboards, desktop ANC controls, or unrelated video
artwork as demonstrations of extension functionality.

- Capture the real popup showing relay setup, the data-sharing notice, sync mode, and enable control. Keep the token masked and use a local or public example relay rather than personal infrastructure details.
- A clean, unconfigured popup capture for version 0.3.3 is included at [screenshots/popup-0.3.3.png](screenshots/popup-0.3.3.png). It shows setup only, not evidence of working Roku or peer synchronization. Do not reuse the old blank-block `dist/cws-screenshot-1280x800.png`.
- Capture the real in-page badge during a successful browser-to-browser session, including the streaming player controls needed to understand the feature. Prefer content you own or have permission to reproduce, and exclude account names and personal recommendations.
- If showing Roku synchronization, use an authentic demonstration of the feature and describe the hardware/setup requirement. Do not label a browser-only screenshot as proof of Roku synchronization.
- Replace every rejected screenshot and inspect the title, short/detailed description, category, icons, and promotional media for the same mismatch.
- Upload the newly packaged ZIP and confirm its manifest version matches the tested version.
- Publish and verify the privacy-policy URL, then update data categories, permission explanations, single-purpose statement, and remote-code declaration.
- Add working review instructions and, if using a hosted review relay, supply its temporary credentials only in the private reviewer field. Revoke them after review.
- Check that the listing makes no affiliation, guaranteed timing, exact Roku seek, or equal-service-support claims.
- Verify the submitted package and reviewer flow before resubmission. Chrome Web Store approval does not establish Netflix authorization for injected automatic playback control; that contractual compatibility remains unverified.

Policy references: [listing requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements),
[privacy policy requirements](https://developer.chrome.com/docs/webstore/program-policies/privacy),
[disclosure requirements](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements),
[privacy dashboard fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy).
