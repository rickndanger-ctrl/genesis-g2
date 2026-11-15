# Genesis G2 0.1.0 validation

Date: 2026-11-14. Target: Mac Mini 2. This records a working private preview, not verified glasses hardware acceptance or a public release.

## Passed

- TypeScript type check and Vite production build.
- 33 frontend tests: host/provider races, stale reply rejection, serialized chat opening, pagination and Unicode retention, pairing, guarded SDK events, stale physical frame rejection, omitted row-zero selection, contextual-menu lifecycle, serialized reconnect, numeric-only diagnostics, delayed callbacks after disconnect, and native browser fetch receiver requirements.
- 18 bridge tests: private bearer authentication, exact allowed origins, six-slot profile translation, mapping changes, wrong-thread rejection, concurrent streaming open requests, bounded replies, phase/runtime separation, static file boundary, bounded private connection/network diagnostics, and no send/command escalation.
- 50 read-only Codex reader checks.
- Real Mini 2 companion inventory: six mapped Codex chats and three mapped Claude chats available at validation time. No titles or IDs are retained in this report.
- Real authenticated read of an assigned Codex thread: exact requested ID returned, 243 characters, `final_answer` phase, runtime state honestly `unknown`; latest check completed in approximately 248 ms over private HTTPS. This did not open, resume, or send to the thread.
- Private Tailscale HTTPS health and authenticated status return 200; unauthenticated status returns 401.
- Dedicated G2 login bridge is running on loopback. The five pre-existing Tailscale web routes were preserved; the new route is private port 8453, without Funnel.
- Browser UI walkthrough: preview slots, paged response, back navigation, agent menu, Claude selection, and ordinary-browser glasses fallback.
- Live browser regression: an isolated paired fixture reproduced the user's exact "Could not reach this computer" error before the fetch binding repair. The same tab and server connected and loaded its mapped A1 after the repair. The fixture could not execute real Mac actions and was shut down afterward.
- Official CLI produced `.local/genesis-g2-0.1.0.ehpk`; SDK 0.0.16 and minimum Even app 2.2.10 stamped successfully.
- Source credential scan passed. The package contains generic UI and an exact network origin, not pairing credentials. The private QR and pairing URL are excluded from source control.
- Existing `genesis-microcontroller-app` checkout remained clean. Home, current controller app installations and physical firmware were not changed.
- Physical connection after the browser repair: the user confirmed both "Mac connected · Mini 2" and A1–A6 visible on the G2. The private trace independently recorded native Even transport, connected G2 device state, successful startup acknowledgment, successful list rebuild, and successful Mac status/profile/chat requests.
- Physical A1 flow: the user confirmed tapping A1 on the glasses opens its assigned Codex chat on Mini 2 and displays the reply on the glasses.
- Physical second-thread flow: the user confirmed double-tap back, swipe to A2, and tap open A2 on Mini 2 and replace the glasses reply. The trace independently recorded glasses text swipes, double-tap back, a native list selection for row 1, and successful open/reply requests. Core chat selection and reading are accepted on real G2 hardware.

## Pending physical acceptance

1. Page a longer reply; change agent from the Even contextual menu and repeat navigation. Claude reply reading must display its explicit unavailable state.
2. Change agents on the phone while looking at a glasses list. A stale tap must never open a different agent's slot.
3. Disconnect and reconnect the glasses. Confirm a fresh screen and working gestures. Developer-page reopen and connection have already worked during setup.

During the first check, the user clarified that A1 was not visible in the glasses and the app was disconnected. That initial response was not counted as a G2 render. The later confirmations below apply to the repaired build.

The user confirmed Genesis G2 was opened inside the Even app and reported the Mac-unreachable message. A native browser fetch receiver defect was reproduced and fixed in both API and diagnostic clients. The repaired build is served at the same private URL. The app also now separates Mac/glasses states at the top, handles late native bridge availability, reports phase-specific errors, and marks glasses connected only after display acknowledgment. After reopening this repaired build, the user confirmed the Mac connection, visible G2 chat slots, opening A1 on Mini 2, reading its reply on the glasses, and switching to A2 with the matching reply.

## Deliberate limits

- Only Mini 2 is paired/configured for this prototype; Mini 1 and Neo remain separate future bridge setups.
- Codex chat-open receipt confirms request acceptance, not a screen observation. Claude's existing companion performs its own selection confirmation; G2 hardware-triggered switching still needs the checks above.
- Voice, Send, permissions, artifacts, shortcut execution and Claude reply reading are not implemented in G2 0.1.0.
- Developer QR mode is temporary and may suspend on phone lock or backgrounding. No always-on/locked-phone result is claimed.
- The standalone package has not been uploaded or published. A future packaged deployment must verify its actual runtime origin and explicitly add that origin to the private bridge allowlist if different from the development URL.
- Phone/G2 rendering can differ. Container sizes and UTF-8 limits were checked in code; physical readability and Bluetooth latency remain unverified.
