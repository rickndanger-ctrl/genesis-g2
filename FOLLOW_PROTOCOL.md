# Genesis G2 native follow contract v1

Implementation target: Genesis G2 0.3.0 and native Genesis build 16 or later. Existing native dictation and `/v1/commands` Send remain authoritative. Display updates never open a chat or send a prompt.

## Mac companion (existing bearer authentication)

`GET /v1/display-session` returns a snapshot:

```json
{"version":1,"hostID":"host UUID","active":true,"revision":1,"sourceID":"installation UUID","sourceName":"iPad","expiresAt":"ISO-8601","state":{"provider":"codex","chatID":"thread ID","slotIndex":0,"view":"reply","page":0,"draft":"","recording":false,"sendState":"none","refreshNonce":0},"feedback":{"revision":1,"pageCount":3,"renderedPage":0,"connected":true}}
```

When inactive, omit source/state/feedback. The public snapshot never includes the lease ID. Optional top-level `chatTitle` is derived by the Mac from validated inventory; never accept a supplied title. `feedback` is optional and valid only when its revision equals the snapshot revision. Actual display state changes increment revision and clear feedback; identical heartbeats only renew expiry and advance sequence. Returning stale feedback is forbidden.

`POST /v1/display-session` accepts these closed operations:

- Claim: `{operation:"claim",sourceID:UUID,sourceName:"iPhone"|"iPad",takeover:false|true,state:DisplayState}`. Generates a private lease UUID. Same owner can reclaim; a different active owner requires explicit `takeover:true`. Return the snapshot plus `leaseID` only to this native request.
- Update: `{operation:"update",sourceID:UUID,leaseID:UUID,sequence:positiveInteger,state:DisplayState}`. Reject expired/wrong leases and non-increasing sequences. Valid updates renew the 45-second lease. Sequence starts at 1 after each new claim. Return snapshot plus leaseID.
- Release: `{operation:"release",sourceID:UUID,leaseID:UUID}`. Clear the state and draft only for the matching owner. An old controller cannot release a new owner's lease.

Use 409 for ownership/sequence conflicts, 422 for invalid fields or unavailable chat targets, and the existing structured error body. Reject unknown operations/fields. No arbitrary actions or URLs. Session state is in memory only and expires; a Mac restart must not restore a private draft/display session.

DisplayState fields are exactly those shown above. `provider` is codex/claude; `chatID` and `slotIndex` may be null; slotIndex is 0–5; view is home/reply/draft; page is 0–999; draft is at most 16,000 Unicode scalars; recording is Bool; sendState is none/queued/confirmed/uncertain/failed; refreshNonce is a nonnegative bounded integer. Reply/draft with no chat must fail. Derive chat title from the current inventory, not supplied text. Validate the target when the provider/chat changes, without opening it or executing anything. Heartbeats/draft updates must not trigger repeated full accessibility scans. Clear feedback when target/view/refresh nonce changes. Clamp requested page using current valid pageCount when available.

`POST /v1/display-feedback` is display-only:

`{revision,provider,chatID,view,pageCount,renderedPage,connected}`

Only accept feedback for the active exact revision/target/view. pageCount is 1–1000, renderedPage is 0..<pageCount; connected is Bool. Connected feedback must match the normalized requested page. It may normalize the desired page downward when content has fewer pages; disconnected feedback cannot clamp it. It must never renew ownership, execute commands, change chat, or carry text. Return the canonical public snapshot. An old display cannot overwrite newer controller state.

The Mac expires feedback after 15 seconds, independently of the 45-second owner lease, without changing display revision. G2 renews acknowledgment only after another native display ACK; known disconnects revoke the matching ACK with connected:false. A stalled Even relay must not leave the native UI claiming a current display acknowledgment.

## G2 HTTPS adapter

- `GET /api/follow`: proxy the current public display snapshot with the existing independent G2 bearer; validate host identity and supported fields. Unavailable older companions should return inactive + supported:false so standalone G2 still works.
- `POST /api/follow-feedback`: accept only the fixed feedback payload and forward it to the Mac companion. No lease, owner change, Send or general command route.

G2 polls while active, including hidden-page operation only in a real Beta build when supported. An active native session makes G2 follow its provider/chat/view/page/draft without calling `/api/open`. Native selection is applied only after its normal open receipt. Native Send is never duplicated. Follow updates invalidate stale readers immediately. Lease expiry leaves a clear disconnected/follow-ended state and stops showing drafts. Standalone manual G2 selection remains available via an explicit leave-follow control; it must not secretly take over the native lease.

## Native app

Add an explicit Follow this controller switch, owner/takeover affordance, and reply/draft/previous-page/next-page/home/refresh controls. Keep native Hold Talk and explicit Send unchanged; optionally show a dedicated Send button in the follow panel calling the same guarded sendDraft method. Publish after confirmed chat changes. Debounce draft snapshots; serialize all session writes and guard response generation across host/provider changes. Heartbeat every 10 seconds while foreground. Stop/release on disabling, host change, or background; renew only when the user enables/returns to their explicitly selected session. An expired session cannot be silently stolen back from another device. Preserve the build-15 speech implementation, persisted drafts and Send receipt ledger.

The iPad controller + Even foreground on the iPhone is the first physical acceptance setup. Same-iPhone native control requires a real Even Beta install and a background/lock test; do not claim this from the QR preview.

## Conversation view (0.3.0)

`GET /api/reply` retains its existing latest-reply fields and optionally includes `turns`, an oldest-to-newest excerpt of at most six visible messages and 16,000 Unicode scalars in total. A turn has only `role` (`user` or `assistant`), `text`, optional assistant `phase`, and optional `truncated`. `turnsTruncated` marks omitted or clipped history. The reader reserves room for the most recent user and assistant messages. The response revision includes the conversation, so a new user message updates the display before a new assistant reply exists.

The excerpt comes from the exact current-account Codex thread using read-only app-server operations. Tool output, system/developer messages, hidden reasoning, moderated text, attachment metadata, and known transport scaffolding are excluded. Unknown conversation roles or oversized excerpts are rejected by both bridge and client. Older bridges without `turns` remain usable as explicitly labeled latest-reply views.

The glasses display the authoritative conversation separately from the current native draft. A draft is not inserted into chat history before the reader returns a real user message. `queued` remains Queued; it is not a delivery confirmation. An older final answer does not establish that a newer request is complete. The protocol has no separate Sending phase, so the UI must not invent it. No transcript comparison resolves native delivery uncertainty or retries a send.

Reply and Draft select which content the native page controls navigate. Page zero shows the latest content; later pages go toward older text. A draft excerpt can be paged without removing the recent conversation from view. The original complete draft remains on the native controller for review and explicit Send.
