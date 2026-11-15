# Claude Code conversation reader

`reader.mjs` reads an excerpt of an existing Claude **Code** conversation on the
same Mac. It has no network calls, subprocesses, UI actions, Send, query or resume
operation. Ordinary Claude web chats are not supported by this adapter.

```js
import { createClaudeReader } from './claude/reader.mjs';
const readClaudeReply = createClaudeReader();
const result = await readClaudeReply({ id, title });
```

The caller supplies a freshly authorized `{id, title}` from the companion's
inventory and must recheck that authorization before publishing the response.
The optional `home` configuration is a trusted host setting, never request input.
The factory should be created once per running bridge, not once per HTTP request.

## Exact identity

The public Claude ID is the companion's unchanged `claude-` plus the first 32 hex
characters of SHA-256 over the exact UTF-8 title. That ID alone cannot identify a
transcript: forks can have identical titles.

The reader therefore requires all of the following:

- The Desktop account from `Claude/config.json` agrees with the local CLI account.
- The Desktop session index is under that exact account and organization.
- Exactly one unarchived Desktop record has the requested title.
- Its `sessionId` exactly matches its `local_<UUID>` filename stem.
- Its separate `cliSessionId` is a valid UUID; its cwd encoding identifies the
  exact project directory and transcript filename. There is no scan for the
  newest transcript or a transcript with a matching title.
- The transcript's recent bridge ownership metadata matches the same account
  and organization.
- Account and indexed session identity remain the same after reading.

Files must remain inside the configured home, belong to its user, and have no
symlink components. Opened file identity is checked; an in-progress metadata
rewrite or replaced transcript fails closed.

Each successfully read public ID is pinned in memory to its account,
organization, Desktop session, CLI session and cwd. Later polls cannot silently
rebind the same title to another account or fork. Pins never evict older entries;
the bounded 512-entry table refuses new pins when full. Same-session transcript
rotation between polls is allowed. **After an intentional Claude account change
or replacement session with the same title, restart the Genesis G2 bridge to
establish a new binding.** A restart does not itself change any chat assignment.

## Conversation excerpt

The reader examines at most the final 8 MiB of the exact transcript. It discards
an initial partial line and any final incomplete append. It follows the recorded
UUID/parent-UUID ancestry from the latest main-thread leaf rather than mixing
independent branches or assuming alternating roles. A missing parent bounds the
excerpt; duplicate UUIDs and cycles are rejected.

Only matching-session, non-sidechain `user` and `assistant` records with the
matching explicit message role can contribute text. Tool results, tool calls,
thinking blocks, attachments, system records, hidden/meta messages, and recognized
generated command/notification/compaction wrappers are omitted. An ordinary
user's Markdown is retained. This is strict typed extraction plus known-wrapper
filtering, not a claim that arbitrary text can be semantically classified.

Output contains at most six visible messages, oldest to newest, with 16,000
Unicode scalars in total and 8,000 per message. The latest user and assistant
receive budget first. `turnsTruncated` and `limited` identify bounded history.
`state` is always `unknown`: an older final response does not prove the latest
user request is complete. Assistant phases reflect explicit `stop_reason` where
available, without inventing a live activity signal.

Successful responses contain `ok`, `provider: 'claude'`, the unchanged requested
`threadId`, `title`, `state`, `reply`, `turns`, `turnsTruncated` and `limited`.
Errors use a fixed public message and code; raw filesystem/JSON errors are never
forwarded. Do not log successful responses because they contain private text.

Metadata reads are bounded to 512 Desktop entries, 2 MiB per file and 16 MiB in
aggregate per identity pass. Identity is checked twice. The factory's optional
`maxTailBytes` can lower the tail bound for fixtures but cannot increase it.

## Verification

Run `node --test bridge/claude/reader.test.mjs` from the repository root.

Fixtures cover exact title hashing, real Desktop filename format, fork
collisions, account/session changes between polls, archive states, identity
rechecks, file rotation, symlinks, metadata/tail budgets, partial writes,
ancestry, internal-content exclusion and Unicode limits. A read-only Mini 1
check against the current OMAC 1 binding returned five visible user/assistant
messages in 127 ms without displaying their content or changing Claude.

The inspected Desktop metadata format was from Claude 5.11492.5. Unsupported
future schema changes should fail closed and require an adapter update.
