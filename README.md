# CollabSpace

A real-time collaborative document workspace. Several people open the same
document, see each other's cursors, selections and typing live, and edit the
same sentence at the same moment without losing each other's work.

Built for Puzzle #184.

---

## The problem this is actually solving

Sending text between two browser tabs is easy. The hard part is what happens
when Alice and Bob both edit the same sentence at almost the same instant.

The tempting implementation is a `content` column and a `save` endpoint. Alice
saves, Bob saves 40 ms later, and Bob's write wins — Alice's sentence is gone,
with no error, no conflict, and no way to get it back. That is not Google Docs.
That is multiplayer data loss with a nice UI on top.

So the centre of this project is not the editor. It is the merge.

### What replaces "save the whole document"

Every keystroke becomes an **operation** carrying enough context to be merged
safely, independently of when it arrives:

```ts
{ t: 'ins', id: '42:tab-a', ch: 'x', left: '41:tab-b' }   // insert after a specific character
{ t: 'del', id: '17:tab-c' }                              // tombstone a specific character
```

Each character has a permanent identity — `${lamport}:${siteId}` — so an
operation refers to *this exact character*, not to "offset 37", which is wrong
the moment somebody types above it.

Those operations are stored in an append-only log (`document_operations`). That
log, not `documents.content`, is the source of truth. `content` is a
materialised snapshot for fast loading; replaying the log always reproduces the
document exactly.

### The merge itself: an RGA CRDT

`src/lib/crdt/rga.ts` implements a Replicated Growable Array, written from
scratch rather than wrapping Yjs or Automerge.

To insert a character after some origin, scan right from that origin and skip
every character whose id is greater than the new one, then splice it in. Ids are
ordered by Lamport timestamp with the site id as tie-break.

That single rule buys three properties:

| property | meaning | why it matters here |
|---|---|---|
| **Commutative** | `{A, B}` and `{B, A}` produce identical text | two clients that received edits in different orders still agree |
| **Idempotent** | applying `A` twice equals applying it once | duplicate delivery from two transports is harmless |
| **Order-independent** | arrival order is irrelevant | a reconnecting client can simply replay its backlog |

Deletes are tombstones, never splices, so a character that somebody else is
still referring to never disappears out from under them.

There is deliberately **no code path anywhere that overwrites the document with
a client's copy of the text.** Nothing is saved over; operations are merged.

### Verifying the claim

The correctness gate is a randomised property test:

```
npm run test
```

It builds three replicas, generates independent edits on each, then delivers
every other replica's operations to each one **in a different shuffled order,
with a third of them duplicated** — and asserts all three end up byte-identical.
500 iterations, deterministic seeds so a failure is replayable.

```
✓ tests/unit/rga.test.ts (14 tests)
```

Alongside it are the specific scenarios: both users typing into the same
sentence, overlapping deletes, one user editing text another is deleting, and
operations arriving before their causal dependency.

---

## Architecture

```
Browser A ──┐                            ┌── Presence  (ephemeral awareness)
            ├── channel doc:{id} ────────┼── Broadcast (fast, lossy)
Browser B ──┘                            └── Postgres  (durable, slower)
                                                 │
                                          document_operations
                                        (append-only, the truth)
```

### Three transports, on purpose

- **Presence** carries who is online, their cursor, selection and typing state.
  It is heartbeat-backed and evicts a client automatically, so a closed laptop
  disappears from the list without cooperating.
- **Broadcast** carries operations and cursor movement. Low latency, but it can
  drop messages.
- **Postgres Changes** carries the same operations from the database. Slower,
  but guaranteed.

Running the last two together, deduped by operation id, is what makes a dropped
packet a *latency* problem instead of a *lost edit* problem.

### Surviving a bad connection

`src/lib/realtime/outbox.ts` queues operations in memory and `localStorage`
whenever the socket is not joined. On reconnect the client pulls every operation
it missed (`seq > lastSeen`), applies them, then flushes its own queue.

Replaying late, out of order, or twice is all safe: the CRDT is idempotent, and
the database has a `unique (document_id, op_id)` index so a retried flush is a
no-op rather than an error. Because the queue is mirrored to `localStorage`,
even a full page reload while offline keeps the user's typing.

### The second line of defence

Snapshots are written through an RPC that takes the version the client believes
is current:

```sql
save_document_snapshot(doc, expected_version, new_content, new_state, new_seq)
```

If someone else saved first, the `UPDATE` matches no row and the function
raises. The client then pulls what it missed, merges it through the CRDT — which
is always safe — and retries against the new version. A stale client cannot
overwrite a newer one even in principle.

### Permissions are enforced by the database

Roles are Owner, Editor and Viewer. The greyed-out toolbar is an affordance; the
actual boundary is row level security:

- `SELECT` on a document requires a `document_permissions` row.
- `INSERT` into `document_operations` requires role `owner` or `editor`.
- `document_operations` has **no** update or delete policy at all, so history
  cannot be rewritten by anybody.

A viewer who opens devtools and calls the Supabase client directly is rejected
by Postgres. `scripts/verify-rls.sql` proves exactly that, with the UI bypassed.

### Positions that survive editing

Cursors, selections and comment anchors are all stored as character ids rather
than integer offsets. A comment stays welded to its sentence no matter how much
text is inserted above it, and a remote insert above your caret does not drag
your caret along with it. When an anchor's characters are all deleted, the
thread is shown as "on deleted text" with the original quote rather than
vanishing.

### Restore is a forward edit

Restoring an old version does not overwrite anything. The current state is
snapshotted first, then the difference between now and the target is applied as
ordinary operations. So the restore propagates to every connected client live,
the pre-restore state stays in history, and the restore is itself undoable.

---

## Getting it running

### 1. Create a Supabase project

<https://supabase.com/dashboard> → new project.

### 2. Apply the migrations

In the SQL editor, run in order:

1. `supabase/migrations/0001_core_schema.sql`
2. `supabase/migrations/0002_rls_and_functions.sql`

### 3. Enable anonymous sign-ins

Authentication → Providers → **Anonymous** → enable.

Anonymous sign-in still produces a real `auth.uid()`, which is what every RLS
policy tests against.

### 4. Configure the app

```bash
cp .env.example .env.local
```

Fill in from Project Settings → API:

```
NEXT_PUBLIC_SUPABASE_URL=https://<your-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your anon key>
```

The anon key is designed to be public and is safe in a browser — RLS is what
protects the data. `.env.local` is gitignored. The `service_role` key is not
needed and should never go in this file.

### 5. Run

```bash
npm install
npm run dev
```

Open <http://localhost:3000>, create a document, then **open the same URL in a
second browser window**. Anyone with the link joins as an Editor.

---

## Demonstrating the conflict handling

The interesting behaviour is easiest to see with two windows side by side.

**Same-sentence collision.** Put both carets in the middle of the same sentence
and type at the same time. Both sets of characters survive, both windows show
identical text, and a notice appears saying the edits were merged. Nothing is
lost and nobody is asked to pick a winner.

**Offline editing.** In one window, open devtools → Network → Offline. Keep
typing — the sync indicator turns amber and reports queued edits, and editing
carries on. Meanwhile type in the other window. Go back online: both sets of
edits merge, in both windows, with nothing dropped or duplicated.

**Hard disconnect.** Close one window outright. The other removes it from the
online list on its own once the heartbeat lapses, and logs a leave event.

**Restore.** Save a version, edit further, then restore. Both windows roll back
together, and the pre-restore state is still in the timeline.

**Permissions.** In the share dialog, demote the other window to Viewer. Its
editor goes read-only immediately, mid-session.

---

## Commands

| command | what it does |
|---|---|
| `npm run dev` | development server |
| `npm run build` | production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no emit |
| `npm run test` | CRDT unit and property tests |
| `npm run test:e2e` | Playwright, two browser contexts against live Supabase |

`npm run test` is the one that matters most: it is the proof that concurrent
edits converge.

---

## Layout

```
src/
  lib/crdt/          RGA engine, text diffing, formatting marks
  lib/collab/        identity, and the document collaboration hook
  lib/realtime/      offline outbox
  lib/supabase/      browser and server clients
  lib/dom.ts         character offset <-> DOM position mapping
  components/        editor, presence, comments, versions, activity, sharing
  app/               dashboard and document workspace
supabase/migrations/ schema, RLS policies, triggers, RPCs
tests/unit/          CRDT convergence and property tests
tests/e2e/           two-client browser tests
scripts/             RLS proof and demo seed
```

---

## Notes and trade-offs

- **The CRDT is hand-written.** Yjs would be faster and more battle-tested, but
  the point of the exercise is the merge algorithm, so it is implemented and
  tested directly rather than delegated.
- **Formatting is a separate layer.** Marks are ranges anchored to character ids
  resolved last-writer-wins, kept out of the character sequence so the sequence
  stays plain text and provably convergent. Full rich-text CRDTs (Peritext and
  similar) go further; this covers the formatting the UI offers.
- **Anyone with the link joins as an Editor**, which is what makes the document
  shareable at all — without a permission row, RLS correctly shows a visitor
  nothing. Owners can demote anyone to Viewer afterwards. For a private
  workspace this is where a real invitation flow would go.
- **Tombstones are never collected.** A long-lived document accumulates deleted
  characters. Production systems periodically compact; that is out of scope
  here.
- **Presence eviction is not instant.** A hard disconnect clears after the
  Realtime heartbeat lapses, which takes a few seconds rather than being
  immediate.
