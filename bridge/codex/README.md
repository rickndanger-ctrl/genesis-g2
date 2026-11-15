# Codex conversation reader

This standalone macOS helper reads a bounded assistant reply and recent user/assistant conversation for one exact Codex thread. It connects only to Codex's **existing** local app-server socket. It does not start Codex or a daemon, load/resume a thread, alter its selection, or send a message.

Build and run from the repository root:

```sh
sh bridge/codex/build.sh
sh bridge/codex/test.sh
bridge/bin/codex-reader --thread 00000000-0000-4000-8000-000000000001
```

The example UUID is a placeholder. The caller must use the exact assigned chat UUID. Executables are generated under the ignored `bridge/bin` directory. Xcode command-line tools and macOS are required; there are no downloaded dependencies.

## Interface

One JSON object is written to stdout. Successful exit status is zero:

```json
{
  "ok": true,
  "provider": "codex",
  "threadId": "00000000-0000-4000-8000-000000000001",
  "title": "Example chat",
  "state": "unknown",
  "stateSource": "codex-app-server",
  "reply": {
    "text": "Example assistant reply.",
    "phase": "final_answer",
    "turnId": "example-turn",
    "itemId": "example-item",
    "turnStatus": "completed",
    "truncated": false
  },
  "limited": false
}
```

`reply` is explicitly `null` if the bounded search finds no eligible assistant message. `limited` means pagination stopped at a configured limit; `reply.truncated` separately describes text truncation. Neither flag should be presented as complete transcript access.

The additive `turns` array contains up to six actual messages, oldest to newest, with `role` (`user` or `assistant`), `text`, optional assistant `phase`, and `truncated`. `turnsTruncated` marks omitted history or clipped text. The newest user and assistant get text budget first; each message is capped at 8,000 Unicode scalars and their combined text at 16,000. These are recent-message excerpts, not a complete transcript. Empty `turns` means no eligible conversation text was found. Do not invent a sent-message echo from a draft or infer completion from an older final reply.

Failures exit with status one and contain only a generic message and machine-readable code:

```json
{"ok":false,"error":{"code":"not_in_current_account_inventory","message":"The selected Codex conversation could not be read. No conversation was started or changed."}}
```

Other codes include `invalid_thread`, `thread_identity_mismatch`, `invalid_response`, `pagination_limit`, `timeout`, `response_too_large`, `history_unavailable`, `service_unavailable`, and `reader_failed`. The caller must clear or label stale content on failure, rather than displaying another chat as a fallback. Do not log successful JSON because it contains private conversation text.

## Identity and interpretation

- The UUID must be a currently eligible, nonarchived, direct-input chat in `thread/list` with `currentAccountOnly: true`. Membership is checked before **and after** reading. Subagents and ephemeral chats are excluded. There is no title matching or fallback to another thread.
- `thread/read` uses `includeTurns: false`. Its returned UUID must exactly match the request. Turns and items are read through the paginated endpoints. Every returned item must identify the requested turn.
- Replies are chosen from the newest turn containing an eligible assistant message. Within that turn, a final answer takes precedence over partial/unknown/commentary messages. If a new working turn has no assistant text, the previous turn's reply may be returned, with its original turn ID and status.
- `phase` is preserved as `final_answer`, `partial_answer`, `commentary`, or `unknown`. Commentary is not labeled a final answer. The legacy `reply` remains assistant-only. `turns` permits only typed `agentMessage` and `userMessage` text; hidden reasoning, tool output, explicit system/developer roles, attachment metadata, and provider-marked moderated text are excluded.
- User text is read only from `content` or `input` arrays with `type: text`, never arbitrary `item.text` or file/image fields. Recognized Codex realtime wrappers expose only the input, question-reply wrappers expose only answers, and file-attachment wrappers expose only `My request`. Standalone AGENTS/environment/permissions scaffolding and realtime tail-flush handoffs are omitted. Normal authored Markdown remains unchanged. Unknown text wrappers cannot be reliably distinguished from a user's literal text; this is bounded display extraction, not an assertion of complete semantic redaction.
- `state` describes the app-server's runtime (`active`, `idle`, `error`, or `unknown`), not a universal desktop activity signal. A thread that the app-server reports as `notLoaded` is **unknown**, not done. `turnStatus` belongs to the selected reply's turn and is not a new completion notification.

## Bounds and transport

The helper has a 4.5-second total transport deadline. The legacy reply searches at most 20 inventory pages (100 rows each), three turn pages (five rows each), and five item pages per turn (20 rows each). The conversation pass examines at most three turns and thirteen item pages total. It reuses each turn's first five 20-item pages from the legacy read, then continues with 100-item pages, for at most 900 items. This permits the latest real user message to remain visible through long tool-heavy turns while retaining the six-message output limit. The exported app-server schema has no message-type filter, so omitted tool items still count toward the search budget. If the user message lies beyond that bound, the excerpt is marked truncated; no historical user text is guessed or reused from another snapshot. Inventory is never cached: current-account membership is freshly checked again before any content is returned. The legacy reply remains capped at 8,000 text characters and the title at 240. Conversation scalar bounds are separate. Repeated cursors, oversized pages, malformed IDs, and mismatched thread/turn identity fail closed.

The socket defaults to `~/.codex/app-server-control/app-server-control.sock`. An absolute `CODEX_HOME` override is supported for host-side deployment; it must never come from an untrusted web request. The resolved socket must belong to the current user, be a Unix socket, and not be world-writable. WebSocket upgrade, response IDs, framing, lengths, and time are checked. No shell command is constructed from the thread UUID.

The permitted app-server methods are fixed in an enum: `thread/list`, `thread/read`, `thread/turns/list`, `thread/items/list`, plus the connection initialization handshake. There is no action RPC surface. The host bridge still needs its own authentication and assigned-slot authorization before invoking this reader.

## Validation

The fixture suite covers account membership before/after reads, wrong-thread rejection, pagination, commentary versus final answers, empty/limited replies, malformed responses, Unicode truncation, and response ID type checking. Conversation tests additionally cover chronological ordering, newest-pair budget priority, known wrapper extraction, tool/reasoning/attachment exclusion, and shared read-page caching without caching account checks. A read-only local check also succeeded for a currently mapped Codex chat without starting or changing a conversation. Availability on other Macs depends on their installed app-server version and the mapped chat being in that Mac's active account.
