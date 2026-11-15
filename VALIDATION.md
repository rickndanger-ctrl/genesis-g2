# Genesis G2 0.4.0 validation

Date: 2026-11-14 (PST). Targets: Mini 1 and Mini 2. This release adds verified local Claude Code conversation reading and automatic Follow handoff among explicitly paired Macs.

## Software and deployed runtime checks

- 300 checks passed: 155 frontend, 34 HTTP bridge, 25 Claude reader, and 86 Codex reader checks. TypeScript, Vite production build, and diff checks passed.
- Cross-host tests cover the current Mac retaining priority, ambiguous active hosts, bounded offline probes, stale responses, Leave-follow intent, and the current Mac resuming during the final candidate check. Discovery performs authenticated reads only and clears the previous chat/draft before a handoff.
- The Claude reader binds the exact current-account desktop session to its indexed CLI transcript. It rejects ambiguous titles, account/session changes, unsafe paths, and foreign transcript ownership; filters tools, hidden reasoning, generated user scaffolding, and sidechains; and returns a bounded recent excerpt. Identity pins prevent a same-title chat from silently switching accounts or sessions between polls. An intentional account/session replacement requires restarting the G2 bridge.
- Both dedicated Mac G2 runtimes are deployed as 0.4.0 with `claudeReaderEnabled: true`. Mini 1 authenticated HTTP reads for C1 and C2 returned 200 with exact requested targets, five and six visible messages, in 388 ms and 291 ms respectively. Mini 2's Codex regression read returned 200 with the exact requested target in 203 ms. No message content or private session identifiers are retained here.
- Claude was closed on Mini 2, and its unavailable state was confirmed. Live Claude conversation reading on Mini 2 has not been verified.
- Published private Beta: `com.pybird.genesisg2` 0.4.0, 62,450 bytes; SHA-256 `89043a5a334e4b2f09d8795acd64ba4abc0e0356011744799f2fe0c9846a30e7`. Even Hub showed **Beta build v0.4.0 Published** after reloading, for the existing one-person testing group. Local proof: `.local/beta-v040-proof.jpg`. The prior 0.3.1 package remains private. Phone installation and physical Claude conversation acceptance are still pending.

## Physical acceptance and remaining checks

- Mini 1 Follow synchronization, native draft display, and explicit Send were user-accepted before the Claude reader was added. These results do not establish physical acceptance of Claude conversation text on G2.
- Actual Claude conversation display, readability, and paging on the glasses remain pending user confirmation for 0.4.0. No successful optical render is inferred from the HTTP reads or automated checks.
- Background relay remains an explicit opt-in and may need re-enabling after reopening Even. Locked-phone relay and long-duration reliability remain unverified.

---

# Genesis G2 0.3.0 validation (historical)

Date: 2026-11-14 (PST). Native companion: 0.2.1 / build 18 (physical flow tested on build 17; build 18 changes help text only). Target Mac: Mini 2.

## Built, installed, and published

- 123 frontend tests passed, including bounded conversation history, latest user visibility, separate draft paging, stale target/owner rejection, literal boolean display acknowledgments, and layout geometry. TypeScript and Vite production build passed.
- 27 HTTP bridge tests and 86 read-only Codex reader checks passed. The reader's bounded scan now finds the latest user message even when hundreds of intervening tool events appear. It excludes private scaffolding, tool output, and hidden reasoning, preserves exact current-account targeting, and never sends or resumes a thread.
- A live authenticated read of this long conversation returned the exact requested target and six messages, including a user message, in 422 ms. Only roles, lengths, timing, and target equality were recorded. The dedicated bridge reports 0.3.0; the deployed reader SHA-256 is `743301c00dd5601bd3f79ee97323ce475273604a879859388b13eb9779d5f38e`.
- Native 0.2.1 / build 17 installed in place and independently queried on the intended iPhone 17 Pro and iPad (A16). Native app executable SHA-256 is `0b496b4ee4c7a8900efc060b5a42ffae2dda4d4a813e49be34392427e3bd8924`. The other paired iPhone was not changed. Existing mappings and drafts were preserved.
- The native exact-duplicate-slot regression fails before the repair and passes afterward; 26 targeted Codex/Claude checks passed. The Conversation/Draft follow-panel UI check passed on iPhone. Build-15 speech implementation remains unchanged.
- The isolated browser fixture verified role-labeled history above a separate composer, draft tail and older-draft paging without replacing history, and full “Draft, not sent” status. The fixture cannot execute desktop commands. Local screenshot: `.local/conversation-v030-preview.jpg`. This verifies the preview, not optical readability on G2.
- Official package `com.pybird.genesisg2` 0.3.0: 61,621 bytes; SHA-256 `92a57dbaf50622e89d812d4bf1288d3e8928cd4009fcf7dcb720885cbf10e473`; SDK 0.0.16; minimum Even app 2.2.10. Package-input scans found neither private pairing token. No conversation content is included.
- The existing authorized private testing group remains one person. Even Hub visibly confirms **Beta build v0.3.0 Published**. Local publication screenshot: `.local/beta-v030-proof.jpg`. The intermediate 0.2.1 package remains private, superseded by 0.3.0. Home's package was not changed.
- Accepted rollback tags retained: G2 `g2-follow-0.2.0-accepted` and native `g2-follow-build16-accepted`. The previous reader binary is retained locally.

## Physical acceptance for 0.3.0

- The user confirmed the 0.3.0 Even Beta was updated and opened, then confirmed the opt-in background relay was enabled. The updated package emitted a new exact loopback origin; that observed origin was added to the private allowlist. Authenticated Follow requests returned 200 after restarting only the dedicated G2 bridge. Bearer authentication, other routes, and pairing tokens were unchanged.
- The user confirmed the new YOU / CODEX conversation and separate draft box are visible after selecting this chat from native Genesis on iPhone. Live state independently shows iPhone ownership and matching connected feedback for the selected slot. The new package's body/footer updates returned literal boolean success in the numeric-only SDK trace. This also confirms the updated native-foreground / Even-background path is operating on this setup.
- The first paging attempt was not a pass: the user could not see this conversation, and live state showed Home with no selected chat. The exact current thread was mapped to A6. After tapping A6, the user confirmed this conversation appeared, then confirmed the right arrow showed older text. Live state independently showed this exact thread, slot 6, requested page 1, and matching connected feedback for page 2 of 6.
- The user then followed the return-to-latest and dictation-review check and confirmed both the conversation and released draft stay visible in their separate areas. Live state independently showed the exact current thread, iPhone ownership, Draft view/page zero, recording false, a 48-scalar draft, and matching connected feedback. No test draft was submitted by the agent. Native Send-once behavior was already user-accepted on 0.2.0 and its implementation is unchanged.
- Native build 18 corrects only two same-iPhone helper messages and increments the build number. Signed Release build and strict signature verification passed. It was installed in place on both intended devices and independently queried as 0.2.1 / 18. Executable SHA-256: `ad5243d2a54e825261533799eb5ab7f57df2bed0d459e747afad57a134b3bb98`; native source commit `390b6af`. No routing, dictation, Send, or Follow logic changed after the physical check. Reopening the native app and re-enabling Follow after installation is normal; returning from background does not silently claim display ownership.
- Initial switching, dictation review, explicit Send once, and same-iPhone background control were accepted on 0.2.0 below. Do not treat those as optical acceptance of the new layout.
- Full Even restart, a five-minute locked relay-phone test with the iPad as controller, and long-duration reliability remain unverified. Claude reply reading is still explicitly unavailable.

The scoped Mini 2 / Codex native Follow and conversation/composer update is accepted. The optional reliability checks and unsupported provider reading above are not claimed as complete.

---

# Genesis G2 0.2.0 validation (historical)

Date: 2026-11-14. Native companion build: 16 (0.2.0). Target Mac: Mini 2.

## Current version checks

- Native signed Release build passed. Build 16 / 0.2.0 installed in place and independently queried on the intended physical iPhone 17 Pro and iPad (A16). The other paired iPhone was not changed.
- Native checks: 36 Follow session, 184 HTTP/store integration, 144 transcript, 112 audio lifecycle, and 83 remote-core assertions passed. Build-15 speech implementation files have no diff.
- Native Follow UI passed in iPhone portrait and iPad landscape. Page controls, Home/Reply, Refresh and button boundaries were exercised in an explicitly simulated, no-network fixture.
- Mac display ownership/state suite: 107 checks passed; existing Mac/controller and Codex menu/queue/inventory suites passed. Signed installed executable matches the build, and the existing Accessibility signing identity was preserved. A pre-update app rollback copy is retained locally.
- G2 HTTP bridge: 24 tests passed; read-only Codex reader: 50 checks passed.
- Live private-HTTPS route check: native Home and exact selected Codex target reached the G2 adapter with explicit nullable fields and inventory-derived title. Lease secrets were stripped, stale sequence/feedback rejected, and release removed transient state. No chat was opened or prompt sent by this test, and no physical render success was fabricated.
- Browser fixture: paired connection followed two distinct chat IDs, moved to page 3, showed a draft and “Send queued,” then cleared the draft on follow termination. Fixture cannot execute real Mac commands.

## Pending current version acceptance

- Real iPad paging of a longer reply on G2. Chat switching, draft/review, and explicit Send are now user-confirmed; an earlier delayed update still needs observation under repeated use.
- Pairing and the packaged origin surviving a complete Even restart. The initial Beta installation and connection are confirmed below.
- Repeated-use reliability of same-iPhone native Genesis with Even in the background; the initial working flow is now user-confirmed below.
- Five-minute locked-phone relay test while the iPad retains native ownership. Locking the controller itself intentionally releases Follow.

No new physical G2 result is implied by the tests above. Earlier hardware acceptance below applies to the independent G2 reader path.

---

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

### Final 0.2.0 build evidence

- 64 G2 frontend checks passed, including render ACK freshness, disconnect revocation, and late-native pairing storage migration; TypeScript/Vite build passed.
- Official package generated: `com.pybird.genesisg2` 0.2.0, SDK 0.0.16, minimum Even app 2.2.10, 59,776 bytes. SHA-256 `662d4dca795e6bfb7047fbecc1fc87687f520eed7f965d5b8d4bb6384a111b55`.
- Package input scan found neither the G2 pairing token nor the native companion token. Separate app identity and version verified.
- With explicit user authorization, the package was uploaded to its separate Even Hub project and promoted to private Beta. Portal visibly confirmed “Beta build v0.2.0.” The requested invitation was sent only to the user’s own Even account; after the user accepted, a fresh portal load confirmed Active membership. Home remained a separate project at its existing build. Phone installation is the next acceptance step.

### Installed Beta connection

The user confirmed Genesis G2 0.2.0 was installed and opened in Even. Its packaged WebView retained the Genesis pairing but emitted Origin `http://127.0.0.1:65028`; the existing exact-origin check rejected its preflights. Only that observed origin was added to the private configuration, with no wildcard/null origins or bearer changes. After restarting the dedicated G2 service, its authenticated follow/reply/feedback requests returned 200. Real Even transport reported successful display ACKs, and the iPad-owned current revision received matching connected feedback. Continued polls and fresh ACKs remained active afterward.

During native A1/A2 testing, the user first reported one switch, then clarified that the Mac changed while the glasses stayed behind. The user subsequently reported "It just worked again" and "Now it's working" without another installation or service restart. Count current native-to-glasses chat switching as user-confirmed, but retain the intermittent delay as unresolved reliability evidence. Footer keepalive ACKs alone do not prove a changed reply was physically displayed.

The user then confirmed that dictation from the native iPad appeared on G2 and remained after release for review. After personally tapping Send draft once, the user confirmed one message in the selected Mac chat and the glasses returning to the reply. Those checks used build 16 and the installed 0.2.0 Beta. Longer-reply paging and background acceptance remain pending.

### Same-iPhone native control

The user enabled the installed Beta's explicit background-relay option. The first attempt changed the Mac but not the glasses; the live session still belonged to the iPad, so that was not valid evidence of a background relay failure. After turning off Follow on the iPad and enabling it on the iPhone, the user confirmed "This iPhone controls the display," then "Now it works." The user further confirmed that the latter message was sent through the controller-and-glasses flow. Initial same-iPhone control with the native app foreground and Even background is accepted. This does not establish locked-phone relay or long-duration reliability.

### Intermediate 0.2.1 hardening (superseded by 0.3.0 above)

- Native build 17 preserves the exact tapped slot when multiple slots map to the same chat. The regression failed before the repair; 26 targeted Codex/Claude checks pass afterward. The signed native Release build passes. This is separate from the earlier intermittent display delay.
- G2 rebuild and text-update results now require literal boolean success, matching the documented SDK contract. Numeric-only diagnostics retain raw result type/code without payload text. 98 frontend checks, TypeScript/build, and 24 bridge checks pass.
- Prepared package: `com.pybird.genesisg2` 0.2.1, 59,862 bytes, SHA-256 `405e4a433648c8e76ef845a9b6dab5a5474e5ec28fbcc808caa4d35321ab648d`. Package inputs contain neither private token.
