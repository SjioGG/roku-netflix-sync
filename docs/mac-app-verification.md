# Local macOS app installation

November 12, 2026. Desktop version 0.4.0 uses the already installed Electron
40.4.1 arm64 runtime. `npm view electron version` returned latest stable
45.3.1 via the configured npm registry. Public npm downloads failed with
ENOTCONN; no new dependency was installed. The existing runtime is deliberately
retained for this local installation, with an exact 40.4.1 development pin
instead of the old floating selector. This is not a claim to use latest Electron.

Packaging uses the vendor's documented prebuilt-binary layout and rebranding.
`bin/install-mac-app.py` builds the local app; `bin/render-app-icon.swift` owns
the generated icon assets. Private settings and the absolute Python path live
in user Application Support, outside the bundle. Existing desktop configuration
is preserved.

The installed app was opened through native macOS app control. Its real window
loaded the saved configuration and enumerated microphone/virtual audio devices
without a shell. ANC and bridge remained stopped. Code-signature validation
exposed Python bytecode writes inside the bundle; a regression reproduced that
failure and now passes with bytecode writes disabled in child processes.

Verification: desktop runtime tests, all 40 desktop checks, desktop HTTP security
checks, local environment tests, Python installer compilation, icon generation,
and bundle signing/validation. Native app startup was observed; this task does
not claim new live ANC/playback validation or public notarization.

After reinstalling the fix and opening the app again, strict deep signature
verification passed and no Python bytecode or private settings appeared in the
bundle. The installed window was left open with ANC and bridge stopped.
