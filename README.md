# Genesis G2

A standalone controller and conversation reader for Even Realities G2. It has its own app ID (`com.pybird.genesisg2`), pairing, browser storage, and Mac bridge. It does not replace Home, the Genesis iPhone controller, or Genesis Mini firmware.

The native iPhone/iPad controller and Mac companion are maintained in the separate [Genesis Microcontroller App repository](https://github.com/rickndanger-ctrl/genesis-microcontroller-app). Use native build 18 or later and the updated companion on every paired Mac. G2 0.4.1 adds automatic connection recovery when Even changes its local address, alongside local Claude Code conversation reading; see [validation](VALIDATION.md) for deployment and physical-test status.

This preview opens existing Codex and Claude chats on a paired Mac. Its terminal-style view shows recent **YOU** and **CODEX** or **CLAUDE** messages above a separate draft box. Claude reading requires an identifiable local Claude Code session; ordinary Claude web chats are not supported by this reader. It keeps the six existing slot assignments and colors on the phone; G2 uses monochrome green with A1–A6 / C1–C6 labels. Longer text and older messages have separate pages.

## What is connected

- Existing six-slot profiles and chat lists from the Genesis Mac companion.
- Codex and Claude chat selection through that companion, with exact chat IDs and mapping checks.
- A read-only Codex conversation reader, with up to six recent visible messages, progress versus final-response phase, and explicit unknown activity state.
- A read-only Claude Code reader bound to the current account's unique active Desktop session and exact local transcript. It returns visible user/assistant text only, with the same six-message limit.
- Glasses chat list, conversation pages, a separate composer, computer/agent menus, and a matching phone preview.
- Separate private pairing over Tailscale HTTPS. No public tunnel or cloud transcript service.

G2 itself does not capture voice or execute Send. **Follow this controller** uses the native Genesis iPhone/iPad app for dictation, review, and explicit Send through its existing route, while G2 displays the selected chat, draft, delivery state, and supported conversation pages. Approvals, multiple-choice answers, shortcut execution, and artifact controls remain outside G2. A successful Codex open request means the OS accepted the request; the real visible selection still needs device observation.

## Try the private preview

The paired iPhone must have Tailscale connected, the Even app, and the G2 connected. The Mac must be awake and logged in, with the Genesis companion and selected agent app running.

1. Display the private pairing QR on the Mac using the local-generation step below. Treat it like a password; do not publish or share it.
2. In the **Even app**, open **Even Hub**, then the **developer control at the top right → Scan QR**. If the developer control is absent, sign in at [Even Hub](https://hub.evenrealities.com/login) with the same Even account and reopen the Even app.
3. Scan the QR. It opens Genesis G2 and pairs the Mac. The token is carried in the URL fragment, removed immediately, and saved only in this app's local storage.
4. On the glasses, swipe to a slot and tap to open it. Swipe to page through its reply; double-tap returns to the slot list. Use Menu to change computer or agent.

The phone's **Explore preview** is explicitly simulated and makes no computer requests. It is useful for exploring the layout, not proof of a live glasses connection.

Developer QR previews can suspend when the iPhone locks or the Even app backgrounds. Use the separate private Beta for the authorized tester account: Even → Me → Beta tester → Genesis G2 → Install or Update. Update each Mac bridge as well. The Codex conversation layout, paging, separate released draft, and same-iPhone native control with Even in the background are user-confirmed. Locked-phone relay and long-duration reliability remain unverified. Never replace the Home package to install Genesis G2.

To add another Mac to the installed Beta, tap **+** beside the computers and fill **Computer name**, **Bridge address**, and that Mac's private **G2 pairing token**, then **Save and connect**. A developer QR preview may not import its pairing into the installed Beta; reopen the Beta and verify that both computers are listed. Never use the native companion's separate token. If transferring a private token file, verify the exact receiving device name first.

## Use the native controller with G2

Use native Genesis build 16 or later and the updated Mac companion. Build 17 adds exact duplicate-slot labeling and clearer conversation controls; build 18 corrects the same-iPhone setup help. Keep both apps paired to the same Mac. The simplest setup uses the **iPad** for native controls and the **iPhone** for the Even glasses relay.

1. On the iPhone, open Genesis G2 inside Even and connect the glasses.
2. On the iPad, open Genesis Controller, choose the same Mac and Codex, then turn on **Follow this controller** below the controller.
3. Tap an assigned chat. G2 follows only after the normal chat-open receipt, without issuing a second open command.
4. Hold the native microphone, speak, and release to review. The glasses can show the draft, but only **Send draft** in the native app sends it. A queued receipt is shown as queued, never as confirmed delivery.
5. Use **Conversation** (**Reply** in build 16), **Draft**, **Home**, page arrows, and **Refresh** from the native follow panel. Conversation pages the recent exchange; Draft pages all words in the bottom draft box. Page 1 is latest, and the right arrow moves toward older text. A display acknowledgment shows which page the glasses accepted.

One native device controls the display at a time. Taking over from another iPhone/iPad is explicit. Leaving the native app or changing computer/agent ends follow; the display lease also expires after 45 seconds without renewal. Transient display drafts are held in memory only, and expiry clears them. Original native drafts and Send receipts retain their existing storage behavior. Turning Follow on keeps that controller's screen awake until Follow stops.

Claude selection, draft preview, and native Send status can follow too. With the updated bridge, a locally indexed Claude Code chat also shows its conversation. The reader rejects duplicate active titles, mismatched accounts, missing local transcripts, and changed session identities instead of guessing. Its identity binding remains pinned until the G2 bridge restarts; intentionally replacing a same-named Claude session or changing accounts requires restarting that bridge. Use **Leave follow** inside Genesis G2 to return to its standalone controls; this does not steal ownership from the native device.

When the current Mac has no active Follow session, G2 can discover exactly one active session on another explicitly paired Mac. It uses each Mac's own token, preserves an active current Mac, rejects ambiguous choices, and sends no chat-open or Send commands while discovering. A failed current connection does not trigger an automatic switch. Choosing **Leave follow** pauses this discovery until **Resume follow** or an explicit different-computer selection.

A same-iPhone workflow requires the installed Even Beta. Inside Genesis G2, enable **Try background relay — Even Beta only**, then open the native Genesis app and enable Follow. In G2 0.4.1, this explicit choice is saved in Even’s native storage and restored when the app reopens; it defaults off until you enable it. A saved preference cannot prevent iOS from suspending Even. If an iPad still owns the display, either turn its Follow off first, or tap **Take over from iPad**, then **Follow this iPhone**. The native controller must stay open; leaving it intentionally releases Follow. Initial same-phone control is user-confirmed; phone lock is a separate pending test. [Follow protocol](FOLLOW_PROTOCOL.md) documents the display-only boundary.

Even can change its local `http://127.0.0.1:<port>` address when it restarts. In G2 0.4.1, the installed Even app saves a separate recovery credential in Even’s native storage and enrolls it with each paired Mac after a trusted connection. On a later restart, the existing pairing token plus that saved credential authorize only the new exact address. Read-only warm-up enrolls all paired Macs without switching chats. Recovery never replays a chat-open command whose response was lost.

The bridge stores credential hashes in owner-only `origin-recovery.json` beside its configuration. Credentials expire after 90 days without successful enrollment or renewal; rotating the G2 pairing token invalidates them. Remove an installation from that file to revoke its recovery access. The app requires durable native storage and will not enroll credentials saved only in browser storage. Normal API requests retain bearer authentication and exact-origin checks; unknown and opaque-null origins remain blocked.

The first installation of 0.4.1 still needs one trusted connection to save and enroll recovery. If this first launch changes the address before enrollment, inspect the private network diagnostic and add only that observed exact address to each paired bridge configuration once. Restart only the G2 service. Subsequent address changes should use automatic renewal; device acceptance is recorded separately in [validation](VALIDATION.md). Re-running setup preserves already verified exact origins.

## Build and local setup

Requirements: macOS, Node 22.13 or newer, Apple Swift toolchain, Tailscale, and the existing Genesis Mac companion with remote pairing enabled. Even SDK 0.0.16 is pinned. The packaged build requires Even app 2.2.10 or newer.

```sh
npm ci
npm run build
npm run test:frontend
node --test tests/bridge.test.mjs bridge/origin-recovery.test.mjs
node --test bridge/claude/reader.test.mjs
bash bridge/codex/test.sh
bash bridge/codex/build.sh
node bridge/setup.mjs --name 'Mini 2' --origin 'https://YOUR-MAC.YOUR-TAILNET.ts.net:8453'
```

Setup creates a private `~/Library/Application Support/Genesis G2/config.json` and `pairing-url.txt`. It reuses the local Genesis companion's existing token without copying it into source, the browser bundle, or a package. The G2 token is independent. Setup does not change slot assignments.

Generate the pairing QR locally from the repository root; do not paste its contents into an online QR service:

```sh
npm install --prefix .local/qr-tools qrcode@1.5.4
node --input-type=module <<'JS'
import QRCode from './.local/qr-tools/node_modules/qrcode/lib/index.js';
import { readFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
await chmod('.local', 0o700);
const url = (await readFile(homedir() + '/Library/Application Support/Genesis G2/pairing-url.txt', 'utf8')).trim();
await QRCode.toFile('.local/private-pairing.png', url, { width: 480, margin: 3 });
await chmod('.local/private-pairing.png', 0o600);
JS
open .local/private-pairing.png
```

The QR contains a pairing credential and stays in the Git-ignored `.local` directory. Scan it inside Even, not a general phone browser.

Run manually:

```sh
GENESIS_G2_CONFIG="$HOME/Library/Application Support/Genesis G2/config.json" node bridge/server.mjs
```

Or install the dedicated login service after stopping the manual process:

```sh
node bridge/service.mjs
```

It binds only `127.0.0.1:18767`. Expose it privately in the tailnet:

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8453 http://127.0.0.1:18767
```

Choose an unused port; preserve other Tailscale Serve entries. Do not use Funnel. The bridge requires its own bearer token, even within the tailnet, and accepts only configured or credential-renewed exact browser origins. Add another Mac by installing its own bridge and pairing it from Genesis G2 Settings. Cross-Mac origins must be explicitly allowed in each private config.

## Package without publishing

Install the official `@evenrealities/evenhub-cli` if it is not already available. Generate a local manifest with this Mac's exact HTTPS origin:

```sh
node bridge/package-config.mjs
evenhub pack .local/app.json dist -o .local/genesis-g2-0.4.1.ehpk --sdk-ver 0.0.16
```

`.local`, generated packages, build products, tokens and logs are excluded from Git. The shared `app.json` has an empty network whitelist deliberately; a private package must name its destination explicitly. The package contains no pairing token. Uploading, Beta distribution and public publication are separate from packaging.

`package-config.mjs` adds only the current Mac's exact HTTPS origin. A packaged multi-Mac setup must list every intended Mac's exact origin in `.local/app.json` before packing, and configure the matching private bridges. Mini 2 Codex and Mini 1 Claude Follow/draft/send were user-confirmed; the latter's original acceptance did not include conversation reading. New reader acceptance is tracked separately in `VALIDATION.md`.

## Safety and verification

The bridge exposes read-only status/profile/chat/reply/follow routes, bounded display acknowledgments, narrowly scoped connection-recovery enrollment/renewal, and one `openChat` operation. G2 cannot claim native display ownership; only the paired native app can do that. It has no Send, approval, generic shell, arbitrary URL or arbitrary command endpoint. Chat changes are serialized and checked against current account inventory; slot selections are rejected if the mapping has changed. The Codex reader never starts a daemon, resumes a thread or sends a message. Replies and bearer tokens are not logged.

Connection diagnosis uses an authenticated, bounded in-memory trace: at most 128 records, visible for 15 minutes. It accepts only named connection stages and integer counters. Chat text, chat IDs, device serial numbers, and credentials are rejected. These diagnostics go only to the paired Mac, never an analytics service.

The Mac also retains up to 64 recent request results for 15 minutes to distinguish network, origin and authorization failures. These contain only a fixed route category, HTTP method/status, validated origin and timestamp. No URL queries, bodies, tokens, IP addresses or user-agent strings are retained.

Tests cover stale host/agent/selection callbacks, reply targeting and pagination, SDK event handling, authorization and origins, mapping changes, concurrent opens, output bounds, and read-only Codex message selection. Passing tests do not prove Bluetooth input/display behavior, background operation or physical readability. See [VALIDATION.md](VALIDATION.md) for observed results and outstanding acceptance checks.

## Roll back only Genesis G2

```sh
node bridge/service.mjs --remove
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=8453 off
```

Use Genesis G2 Settings to forget the paired computer on the phone. Its local pairing files can be retained for later use. Other apps, existing controller mappings, Home, firmware and unrelated Tailscale routes are unchanged by these rollback steps.

## Official platform references

- [Even Hub architecture](https://hub.evenrealities.com/docs/get-started/architecture)
- [Display and container limits](https://hub.evenrealities.com/docs/build/display)
- [Hardware preview workflow](https://hub.evenrealities.com/docs/get-started/quickstart/hardware)
- [Networking](https://hub.evenrealities.com/docs/build/networking)
- [Contextual menu lifecycle](https://hub.evenrealities.com/docs/build/contextual-menu)
