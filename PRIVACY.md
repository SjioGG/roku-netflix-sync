# roku-sync privacy policy

Effective November 9, 2026. This policy covers the roku-sync Chrome extension and its bundled reference sync relay. The separate desktop microphone/AEC companion has different functionality and is not part of the extension.

## What the extension handles

The extension stores your chosen relay URL, room token, sync mode, enable setting, timing trim, and data-sharing consent locally in your Chrome profile using Chrome local storage, not Chrome Sync. During setup, the draft settings are held temporarily in extension-only session storage while setup moves from the popup into a tab. That draft is removed when the setup tab reads it, when you choose Forget relay settings, or when the browser session ends. A room token is a shared credential that authorizes access to room data and playback controls. The extension does not request your streaming-service password or send streaming-service login cookies to the relay.

After you give consent and enable sync, the extension reads playback information on the streaming sites listed in its installation permissions. It sends the streaming service name, a media identifier derived from the playback URL, playback position, play/pause and buffer readiness state, timestamps, playback commands, and a random per-tab identifier to your configured relay. Playback updates are sent approximately every 750 milliseconds while a recognized video is present. The media identifier can reveal what you are watching, even though full browsing URLs and unrelated browsing history are not sent. Some identifiers, such as Plex keys and experimental URL-derived IDs, may describe local or private media.

The relay receives the room token in an authorization header and sees connection information such as your IP address. The extension does not record or upload audio, microphone input, video frames, or the video stream. It has no advertising or analytics SDK.

## Purpose and sharing

These data are used only to provide playback synchronization, timing estimates, room status, and playback control. Room playback data are returned to clients holding the same token, including the Roku LAN bridge where configured. An authenticated room participant can also request device information through the bridge, which may reveal the device name, model, serial number, network name, and other Roku device metadata. Share the token only with people you trust with that access. Everyone with that token can access room state and may control playback; it is not a private viewer identity or a read-only invite.

The chosen relay operator and their hosting or network proxy providers can process data sent through their systems. A locally run relay keeps this processing on your computer, apart from communication with your Roku and streaming service. A hosted relay sends playback data over HTTPS to its operator. Chrome host permission covers the chosen scheme and hostname across ports; it does not grant access to every HTTPS website. Do not enter a hosted relay or share its token unless you trust its operator and room participants.

The reference extension and relay contain no advertising, data sale, profiling, or unrelated data-use features. Use and transfer of information received through Chrome APIs adhere to the Chrome Web Store User Data Policy, including its Limited Use requirements. Streaming providers continue to handle their own account and playback data under their own policies.

## Storage and retention

The reference relay keeps current room, device, timing, and client state in process memory and does not write playback history to a database. Client entries older than 60 seconds are pruned when further telemetry arrives; this is not a timed deletion guarantee. Other latest room values, including the most recent title and playback state, can remain until replaced or until the relay process restarts. The reference HTTP handler suppresses request logs. Hosting platforms, tunnels, reverse proxies, and independently operated relays may retain connection or request logs according to their operator's policies. Ask the chosen operator about providers, access, retention, and deletion before use. Disabling the extension does not delete data already received by those systems.

## Your choices

Sync is off until you explicitly consent, enable it, save your settings, and grant access to the relay host. Existing installs also require this consent. Changing relay origins requires fresh consent. Untick Enable Roku sync to stop new relay requests and automatic playback controls. Untick the data-sharing consent to withdraw it. Already sent requests cannot be recalled, and a previously scheduled Roku start may still run.

Forget relay settings removes the extension's locally stored relay URL, room token, timing trim, mode, and consent. Uninstalling removes extension local storage. Chrome's extension settings let you revoke previously granted host permissions. For existing relay data, ask the operator to delete it or restart a relay you control; deleting local settings does not erase server or provider logs. Keep tokens secret, rotate a shared token if it leaks, and do not post tokens or private viewing information in public support requests.

## Contact and changes

The publisher of roku-sync is Simon Andersen. Use the developer contact and support options on the [roku-sync Chrome Web Store listing](https://chromewebstore.google.com/detail/roku-sync/imcpodcpiofpfnjegfiohdanfbggeikg) for extension privacy questions. The listing is unlisted and requires its direct link. Contact your chosen relay operator directly for private data requests. Do not post credentials or private viewing information in public support requests. Material changes to data use require an updated disclosure and consent before the new use.

roku-sync is an independent project and is not endorsed by Roku, Netflix, or other streaming services. Each participant needs their own authorized access to the content. This policy is not a grant of permission from streaming providers.
