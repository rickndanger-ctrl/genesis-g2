# Keep-reading validation — G2 0.4.2

Date: 2026-11-16. Requires native Genesis build 20 or later and companion 0.5.2-preview or later. This note records implementation checks separately from device acceptance. The completed five-minute locked-phone results are recorded below.

## Implemented behavior

- **Keep reading when iPhone locks** (or **iPad locks**) defaults off in native Genesis. It requires a confirmed selected chat and a compatible Mac. The separate **Try background relay — Even Beta only** setting also requires explicit opt-in; neither switch enables the other.
- Locking/backgrounding an armed controller hands the selected Codex or Claude conversation to a read-only session. Its latest page remains the fixed target; G2 does not open the chat again, Send, change pages, or claim ownership.
- The microphone stops and the display draft is removed. The original unsent draft remains on the native device. G2 shows **Reading while phone sleeps** rather than a prompt to use the phone's microphone.
- Explicit handoff permits at most one hour. If the handoff is interrupted, the Mac converts the armed 45-second lease at its expiry, with the hour anchored to that expiry. Late polls, repeated handoffs, rearming, and display acknowledgments cannot extend the deadline.
- Resuming native control rotates the private lease and rejects late pre-lock writes. Mac lock, remote disable, companion restart, or expiry ends the session. Nothing restores a reading session from disk.
- Older bridges remain compatible with ordinary foreground Follow. Supplied reading flags must be real booleans. A reading-only snapshot containing a draft, recording, Send state, a nonzero page, or no selected chat is rejected.

Claude retains the existing verified local Claude Code transcript requirement. This feature does not add support for ordinary Claude web chats or unsupported reply sources.

## Automated evidence

| Check | Result |
| --- | --- |
| `npm run test:frontend` | Passed: 203 tests across 11 files |
| `node --test tests/bridge.test.mjs` | Passed: 43 tests |
| `npx tsc --noEmit` | Passed |
| `npm run build` | Passed: TypeScript and production bundle |
| `git diff --check` | Passed |

Nine new frontend tests cover old/new snapshots, malformed flags, rejected private parked state, both providers, same-chat park/resume races, obsolete physical acknowledgments, fixed expiry, bounded reply reads, and controls remaining paused. Three new bridge tests cover sanitized output, expired/inactive privacy, malformed state, unchanged deadlines, and absence of ownership/action routes.

Independent source review of the companion model and expiry scheduler found no blocking mismatch with G2's decoder. These checks prove software behavior under fixtures; they do not prove Bluetooth delivery, iOS background execution, or glasses readability while the phone is locked.

## Packaging and deployment

The private 0.4.2 package was created successfully: 65,760 bytes, Even SDK 0.0.16, minimum Even app 2.2.10. The existing private Beta was published and verified in the portal; local evidence is retained as `.local/keep-reading-beta-042.jpg`. The installed iPhone Beta listing confirms 0.4.2, and the app was reopened. Its pre-existing background-relay opt-in remained enabled. The workspace badge still contains the old hard-coded 04.1 label; this cosmetic issue is recorded for the queued UI pass and does not identify the installed package version.

Both Mac runtimes were deployed and checked on 2026-11-16. Only the dedicated `com.pybird.genesis-g2.bridge` service was restarted. Mini 1 received the built `dist` directory, `bridge/follow.mjs`, `bridge/server.mjs`, and package metadata; Mini 2 runs the same checkout. Runtime backups were saved privately before the update/restart.

| Deployment check | Mini 1 | Mini 2 |
| --- | --- | --- |
| `/healthz` | HTTP 200, version 0.4.2 | HTTP 200, version 0.4.2 |
| Authenticated `/api/follow` | HTTP 200, `supportsKeepReading: true` | HTTP 200, `supportsKeepReading: true` |
| Deployed file hashes and served index | Match the built runtime | Match the built runtime |
| Configuration, recovery state, credentials, and reader files | All seven recorded files unchanged | All seven recorded files unchanged |

Both Follow snapshots were inactive during this check. Verification did not claim ownership, open chats, or send commands. It confirms runtime deployment and companion capability, not a live locked-phone display session.

## Additional physical coverage

| Scenario | Acceptance evidence needed |
| --- | --- |
| Same iPhone controls Genesis and relays through Even | With both options explicitly enabled, lock for five minutes. Confirm newly produced text from the selected conversation appears during lock and that the old draft is absent. |
| iPad controls Genesis; iPhone relays through Even | Keep the iPad's Follow active, lock only the iPhone, then confirm a new conversation selection or reply reaches the glasses while the relay phone remains locked. This tests relay continuity separately from parking the owner. |
| Resume | Unlock/reopen Genesis. Confirm the same chat resumes, the native draft is retained, and no message was sent by locking or unlocking. |
| Provider and computer coverage | Confirm read-only updates for Codex and a supported Claude Code chat on the intended paired Macs. |
| Stop conditions | Confirm disabling Follow/reading, Mac lock, and the fixed deadline end the session; confirm companion restart does not recover a private session. |

Record the exact tested versions and user-observed result without copying drafts, tokens, or private conversation text into this document. A static page that survives lock is insufficient evidence of ongoing updates. Even's relay may still be suspended by iOS; the controls in this app cannot guarantee background execution.

Official platform guidance: [testing modes and lock support](https://hub.evenrealities.com/docs/test), [Beta testing's five-minute lock check](https://hub.evenrealities.com/docs/test/beta-testing), and [background lifecycle](https://hub.evenrealities.com/docs/build/background-lifecycle). The application boundary is documented in [FOLLOW_PROTOCOL.md](../FOLLOW_PROTOCOL.md).


## Locked-phone acceptance, 2026-11-16

The actual iPhone was removed from Mirroring for each test; device diagnostics reported passcodeRequired=true during both runs. Both tests collected11 samples30 seconds apart over300 seconds, with active read-only mode, a fixed expiry, zero draft characters, recording=false, and fresh connected glasses acknowledgments throughout.

- Mini2 / Codex: read-only handoff began17:20:20 UTC; the observation ran17:20:57–17:25:57 UTC. Replies and SDK acknowledgments remained fresh. One sampled reply request returned503 and recovered automatically to200 at the next sample, without losing the session. The user confirmed the conversation remained visible and updating while locked. Reopening Mirroring resumed native control with keepReading=true, readingOnly=false, and fresh connected feedback.
- Mini1 / Claude C1: handoff began17:28:58 UTC; observation ran17:29:08–17:34:09 UTC. Every sampled reply request returned200; fresh display acknowledgments continued. The user confirmed Claude was visible while locked. Reopening the controller showed the same saved draft, Ready status, and a connected-glasses acknowledgment.

Both Minis run the final signed companion executable SHA256 `0e8e5e1654df4e3fa8b5359baede6dcb76ea5b91a749195f4fec95f6c37cf251`. No test prompts were sent. Phone mappings, local drafts, and both Mac profiles were preserved. The iPad build is installed but its own keep-reading switch was not enabled or physically lock-tested in this pass. Neo was not updated.

These five-minute results establish tested locked-phone operation on this iPhone/Even setup; they do not guarantee one hour of uninterrupted iOS background execution. The one-hour cap and stop conditions are covered by automated tests. Private metadata-only logs and rollback archives remain local.
