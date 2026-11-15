# Genesis G2 0.1.0 validation

Date: 2026-11-14. Target: Mac Mini 2. This records a working private preview, not verified glasses hardware acceptance or a public release.

## Passed

- TypeScript type check and Vite production build.
- 24 frontend tests: host/provider races, stale reply rejection, serialized chat opening, pagination and Unicode retention, pairing, guarded SDK events, stale physical frame rejection, omitted row-zero selection, contextual-menu lifecycle and serialized reconnect.
- 13 bridge tests: private bearer authentication, exact allowed origins, six-slot profile translation, mapping changes, wrong-thread rejection, concurrent streaming open requests, bounded replies, phase/runtime separation, static file boundary, and no send/command escalation.
- 50 read-only Codex reader checks.
- Real Mini 2 companion inventory: six mapped Codex chats and three mapped Claude chats available at validation time. No titles or IDs are retained in this report.
- Real authenticated read of an assigned Codex thread: exact requested ID returned, 243 characters, `final_answer` phase, runtime state honestly `unknown`; latest check completed in approximately 248 ms over private HTTPS. This did not open, resume, or send to the thread.
- Private Tailscale HTTPS health and authenticated status return 200; unauthenticated status returns 401.
- Dedicated G2 login bridge is running on loopback. The five pre-existing Tailscale web routes were preserved; the new route is private port 8453, without Funnel.
- Browser UI walkthrough: preview slots, paged response, back navigation, agent menu, Claude selection, and ordinary-browser glasses fallback.
- Official CLI produced `.local/genesis-g2-0.1.0.ehpk`; SDK 0.0.16 and minimum Even app 2.2.10 stamped successfully.
- Source credential scan passed. The package contains generic UI and an exact network origin, not pairing credentials. The private QR and pairing URL are excluded from source control.
- Existing `genesis-microcontroller-app` checkout remained clean. Home, current controller app installations and physical firmware were not changed.
- Physical G2 display: the user scanned the private QR and confirmed that the A1–A6 chats appear on the glasses.

## Pending physical acceptance

1. Swipe between A1 and A2; tap each and confirm the assigned Mac chat opens and the matching reply appears on the glasses.
2. Page a longer reply; double-tap back; change agent from the Even contextual menu and repeat navigation. Claude reply reading must display its explicit unavailable state.
3. Change agents on the phone while looking at a glasses list. A stale tap must never open a different agent's slot.
4. Exit and reopen the app; disconnect and reconnect the glasses. Confirm a fresh screen and working gestures.

The first display check passed by user confirmation. The chat-opening and reply-reading hardware check is pending.

## Deliberate limits

- Only Mini 2 is paired/configured for this prototype; Mini 1 and Neo remain separate future bridge setups.
- Codex chat-open receipt confirms request acceptance, not a screen observation. Claude's existing companion performs its own selection confirmation; G2 hardware-triggered switching still needs the checks above.
- Voice, Send, permissions, artifacts, shortcut execution and Claude reply reading are not implemented in G2 0.1.0.
- Developer QR mode is temporary and may suspend on phone lock or backgrounding. No always-on/locked-phone result is claimed.
- The standalone package has not been uploaded or published. A future packaged deployment must verify its actual runtime origin and explicitly add that origin to the private bridge allowlist if different from the development URL.
- Phone/G2 rendering can differ. Container sizes and UTF-8 limits were checked in code; physical readability and Bluetooth latency remain unverified.
