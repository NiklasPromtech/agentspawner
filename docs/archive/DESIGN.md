# AgentSpawner — Design Document
*The goal: an agent that runs for hours unsupervised, takes real actions in the world, never duplicates, never embarrasses you, and feels genuinely good to use every day.*

---

## The Core Philosophy

Two tiers. Always.

- **Expensive agent (Sonnet / Opus)** — thinks, plans, builds, audits. Gets called rarely. Does it right.
- **Cheap agent (Haiku)** — executes. Has a fixed set of tools. Cannot improvise. Cannot build new flows. Can only request help upward.

The cheap agent should feel like a highly trained intern with a very specific job description and a rulebook it cannot deviate from. The expensive agent is the manager who wrote the rulebook and audits the work.

---

## Section 1 — The Action/Data Architecture

### 1.1 Flow types (done ✓)
Every flow is classified as `scrape` or `action`. This is enforced at generation time.

- **scrape** — reads, safe to repeat, no side effects
- **action** — writes, has consequences, must have a guard

### 1.2 The guard pattern (done ✓)
Every action flow starts with a check step that terminates the flow if the action has already been done. The guard's `failMessage` is what the cheap agent reads to understand why it was skipped.

### 1.2a Guard priority: memory first, vision second (done ✓)
The guard should check `query_memory` before doing a vision check. Memory is fast, cheap, and cross-session. Vision is a fallback for things not yet in memory.

Ideal guard order for a DM flow:
1. `query_memory(user_id)` — if we have a memory entry for this user with a recent DM, skip
2. `vision_check` — open the DM thread, check if last message was ours
3. If both pass → proceed with send

### 1.2b type_text always uses clear: false (done ✓)
`clear: true` has never been observed to work correctly. All flows now default to `clear: false`.

### 1.2c Inter-step delay (done ✓)
All flows wait 1000ms between steps by default (`stepDelayMs` on the flow, configurable per flow, 0 to disable). This reduces bot-detection risk on sites that rate-limit fast interactions.

### 1.2d query_memory as a flow step (done ✓)
Flows can now use the sentinel toolName `query_memory` to search semantic memory mid-flow. Inputs: `{ query: string, limit?: number }`. Returns `{ entries: [...], count: N }`. Use as first guard step on any action flow that involves a specific user or entity.

### 1.3 The missing piece — flow-level deduplication keys

Every flow should declare a **primary key** — the thing that makes an execution unique. For example:

```
send_dm           → key: userId
comment_on_post   → key: postId
follow_user       → key: userId
reply_to_mention  → key: mentionId
like_post         → key: postId
```

This key is used for two things:
1. **Hard break** — certain actions can only happen once per key, ever. Commenting on a post twice is never correct — if the key exists in the action log, the flow refuses.
2. **Soft break** — certain actions can repeat but with a minimum interval. DMs can be sent again after 7 days. The flow checks the log for the key and refuses if the interval hasn't passed.

The flow itself declares its key field and its break type. The flow runner enforces it automatically before even running step 1.

### 1.4 The action log table

A dedicated `action_log` table, not the generic memory. Schema:

```sql
action_log (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  flow_name    TEXT NOT NULL,       -- e.g. "send_dm"
  flow_type    TEXT NOT NULL,       -- 'action' | 'scrape'
  key_field    TEXT NOT NULL,       -- e.g. "user_id"
  key_value    TEXT NOT NULL,       -- e.g. "@niklas"
  input        TEXT NOT NULL,       -- full JSON input to the flow
  result       TEXT,                -- flow result / guard message
  success      INTEGER NOT NULL,    -- 1 = completed, 0 = guard triggered / failed
  run_id       TEXT,                -- which autonomous run triggered this
  created_at   TEXT NOT NULL
)
```

Every action flow, whether it proceeds or is blocked by the guard, writes a row here. This means:
- The cheap agent can query "what have I done to @niklas?" and get a full history
- The guard can do a DB lookup instead of a vision check for cross-session deduplication
- The analytics tab shows real action history

### 1.5 Guard priority: DB first, vision second

Current guards use vision checks (screenshot + AI analysis). This is great for "is the unfollow button visible?" but slow and expensive for "did I DM this person in the last 7 days?".

The right order:
1. Query `action_log` for this `(flow_name, key_value)` pair — fast, cheap, cross-session
2. If no DB record exists, fall back to vision check for safety
3. After a successful action, write to `action_log`

This means the DB becomes the real source of truth, and vision is a backup for the first time.

### 1.6 Hard break vs soft break

**Hard break** — the action can never happen twice on this key. Permanent.
```json
{
  "deduplication": {
    "keyField": "post_id",
    "breakType": "hard",
    "message": "Already commented on this post — permanent. Use reply_to_comment instead."
  }
}
```

**Soft break with routing** — not just "skip", but "do this instead". When a soft break fires (e.g. we already sent a DM to this user), the `failMessage` should tell the agent what to do next rather than just abandoning the work:
```json
{
  "deduplication": {
    "keyField": "user_id",
    "breakType": "soft",
    "intervalHours": 168,
    "message": "Sent a DM to this user less than 7 days ago. Check get_dm_thread(user_id) to see if they replied — if so, use reply_to_dm instead."
  }
}
```

This turns a "skip" into an "escalate to the right action" — the cheap agent reads the message and knows to try `get_dm_thread` → then decide whether to use `reply_to_dm`. The soft break becomes a router, not a dead end.

The flow runner reads the deduplication config before executing any steps. No action step is reached if deduplication blocks it.

---

## Section 2 — The Setup Experience

### 2.1 Current state
Setup generates a system prompt from a web search + user input. It works but produces a generic brief that doesn't understand the specific job well enough.

### 2.2 The vision: expensive agent-led setup

When you create a new agent, an expensive model (Sonnet) runs a structured setup session:

**Phase 1 — Research (automated, ~60 seconds)**
- Takes your one-line description ("get leads for audiencescan.io on X")
- Web searches: the company, competitors, what the product does, pricing, who the target audience is
- Searches for similar roles: "X/Twitter outreach specialist", "growth hacker job description"
- Synthesises a draft role understanding internally — doesn't show the user a wall of text

**Phase 2 — Clarification (3–5 short questions max)**
- Asks one question at a time, not a form
- Questions are targeted at gaps the research couldn't fill
- e.g. "What tone should this agent use — professional, casual, or somewhere in between?"
- e.g. "Are there any accounts or types of users you want to explicitly avoid?"
- Each answer refines the brief

**Phase 3 — Brief review**
- Shows the proposed system prompt
- User can: Apply it, Amend it (chat-based), or Edit raw
- Brief is locked before flows are created — you can't build tools for an agent you haven't defined

**Phase 4 — Flow planning (expensive agent)**
- Based on the brief, the expensive agent proposes a set of flows the agent will need
- For each flow: name, type (scrape/action), purpose, what data it needs
- User approves the list — can add, remove, or modify
- This becomes the build list

**Phase 5 — Flow building (one at a time)**
- Each flow is built using the existing flow generator
- For action flows: the generator is explicitly instructed to build the guard + action + DB write pattern
- Test inputs are collected via inline input fields (see Section 3)
- Each built flow is reviewed before moving to the next

**Phase 6 — Unlock**
- Only after all planned flows are built and approved does the "Wake Up" button become active
- The cheap agent cannot run until the expensive agent has signed off on the setup

### 2.3 What the cheap agent gets
A locked, audited set of tools. No ability to create flows. No ability to modify its own brief. The only escalation path is `request_capability("I need to reply to DM threads but don't have a flow for that")` which goes to the expensive manager.

---

## Section 3 — Flow Building UX

### 3.1 Inline test input fields (Lovable-style)

When the flow generator needs test data, instead of asking the user to type values in chat, it emits a structured input request:

```json
{
  "type": "input_request",
  "fields": [
    { "key": "user_id", "label": "Twitter handle to DM", "placeholder": "@username" },
    { "key": "message", "label": "Message to send", "placeholder": "Hey, saw your thread on..." }
  ]
}
```

The frontend renders this as actual input fields in the chat — like an API key entry form. The user fills them in and submits. Those values become the test input for the flow.

This matters because:
- It makes clear what data the flow needs
- It forces the user to have real test data (catches mismatched assumptions early)
- It's much cleaner than "type the values like: user_id=@niklas, message=Hello"

### 3.2 Post-build validation

After `test_flow` runs on an action flow, the generator should verify:
1. Guard step triggered correctly (run once with a "already done" state, confirm it exits)
2. Guard step did NOT trigger (run once in a clean state, confirm the action proceeded)
3. DB write happened (check the action_log after the flow runs)

The generator should run the flow twice with different setup states to confirm the guard is working.

### 3.3 Flow editor shows deduplication config

In the flow editor UI, action flows have a "Deduplication" section where you can see and edit:
- Key field (which input is the unique identifier)
- Break type (hard/soft)
- Interval (if soft)
- The block message

---

## Section 4 — The Cheap Agent's World

### 4.1 What it can do
- Call any approved flow
- Read the action_log ("what have I done to this user?")
- Read memory
- Write to memory
- Send a message to the manager (expensive agent) requesting a new capability

### 4.2 What it cannot do
- Create flows
- Modify its own system prompt
- Call APIs directly (only through approved flows)
- Make decisions about what new flows to build (it can request, not decide)

### 4.3 The manager escalation path

When the cheap agent encounters something it can't do:
```
"I tried to reply to a DM thread but don't have a flow for reading existing DM threads. I need get_dm_thread(user_id) — a scrape flow that returns the last 5 messages in a conversation."
```

This goes to the expensive manager agent, which:
1. **Checks existing flows first** — reviews all approved flows to see if any already covers this. The cheap agent may not know that `send_dm` already navigates to the DM thread, for example.
2. **Considers reuse before building** — if `send_dm` navigates to the DM conversation and closes it, then `get_dm_thread` can be built by duplicating the navigation steps from `send_dm` and replacing the type+click steps with `filter_query_all` to extract message text. No re-probing needed; the selectors are already known to work.
3. **Builds if genuinely new** — runs the flow generator with proper test data only if no existing flow can be adapted
4. **Audits the generated flow** — checks: does it have a guard? is the type correct? does it follow the naming convention?
5. **Approves and adds** to the cheap agent's toolkit

The key principle: before building anything new, check if working selectors already exist in an approved flow. Reusing known-good selectors is faster and more reliable than re-probing.

The cheap agent doesn't know how to build things. The manager does.

### 4.4 Session awareness

The cheap agent, before every action loop, reads:
1. Its current goals list
2. The last N entries from action_log (what it did recently)
3. Any pending manager messages

This briefing means it never starts a session blind. "I DMed 9 people yesterday, 3 are pending response, I'm supposed to comment on 5 posts today" — all readable from the DB before the first action.

---

## Section 5 — Audit and Quality

### 5.1 Every action is audited

The action_log is the audit trail. Every action flow execution writes:
- What was attempted
- Whether the guard blocked it or it proceeded
- What the result was
- Which run triggered it

This is queryable from the Analytics tab and by the agents themselves.

### 5.2 The expensive agent audits periodically

On a schedule (or when triggered), the expensive manager reviews:
- Action log for the last 24 hours
- Any guard blocks (are there patterns suggesting the cheap agent is trying to do things it shouldn't?)
- Any escalation requests from the cheap agent
- Flow run success rates (are any flows failing consistently?)

The audit produces a brief report that goes into memory: "Flow `comment_on_post` failed 3 times today due to selector changes — needs rebuilding."

### 5.3 Human approval layer

Certain action types require a human approval step before execution. The cheap agent queues the action as "pending approval", the UI shows it in the Actions tab, the human approves or rejects it. High-risk actions (unfollow, delete post) are always pending-approval. Lower-risk actions (like, comment) start as auto-approved once you've seen them work a few times.

---

## Section 6 — The Database Strategy

### 6.1 What we have
- `flows` table — flow definitions
- `flow_runs` — execution log
- Custom DB tables per agent (for leads, contacts, etc.)
- Memory (key-value semantic store)

### 6.2 What's missing
- `action_log` — structured log of every action with deduplication keys
- A standard schema for "contacts" that flows can read/write

### 6.3 The contacts table concept

For an outreach agent, there's a canonical contacts table:

```sql
contacts (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  platform     TEXT NOT NULL,       -- 'twitter', 'linkedin', etc.
  handle       TEXT NOT NULL,
  display_name TEXT,
  notes        TEXT,                -- research notes about this person
  status       TEXT,                -- 'prospect', 'contacted', 'replied', 'converted'
  last_action  TEXT,                -- flow name of last action
  last_action_at TEXT,
  last_action_input TEXT,           -- JSON — full input to last action
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
)
```

Every action flow that involves a user writes back to this table. The scrape flows populate it. The cheap agent reads it before deciding who to contact next.

This is the table the user sees in the screenshot — currently being populated inconsistently. Making every action flow write to it consistently would make it the reliable source of truth.

### 6.4 The key insight: flows should know their schema

When a flow is built, the generator should declare:
- What table it reads from (if any)
- What table it writes to (if any)
- What fields it updates

This metadata means the system can auto-generate the database schema from the flow definitions, and enforce that action flows write back.

---

## Section 7 — Priorities (what to build next)

These are roughly ordered by impact on the "actually trustworthy" goal:

1. **Action log table + flow deduplication keys** — the most direct fix for the duplicate DM/comment problem. Everything else builds on this.

2. **Flow-level hard/soft break config** — once the action_log exists, add the deduplication config to flows and enforce it in the flow runner before any steps execute.

3. **Guard DB lookup as first step** — update the guard pattern: check action_log first, vision check as fallback. Cheaper, faster, cross-session.

4. **Contacts table + standard schema** — formalise the contacts DB so every outreach flow reads/writes to the same structure.

5. **Cheap agent session briefing** — before the cheap agent's first action each session, inject a summary from action_log and contacts table so it starts informed.

6. **Inline test input fields in flow generator** — Lovable-style input fields when the generator needs test data.

7. **Manager escalation endpoint** — formal path for cheap agent to request new capabilities from expensive agent.

8. **Setup Phase 1–3** — research-led brief generation. The expensive agent does the research, proposes the brief, user amends.

9. **Setup Phase 4–6** — flow planning, building, and unlock. The expensive agent plans what flows are needed, coordinates building them, signs off before Wake Up is enabled.

10. **Periodic audit run** — scheduled expensive-agent audit of action_log, flagging issues, writing to memory.

11. **Human approval queue for high-risk actions** — pending_actions table already exists, wire it into the action flow pattern.

12. **Post-build guard validation** — flow generator runs the flow twice (clean + already-done state) to confirm the guard works before submitting.

---

## Appendix — Naming Conventions

Proposed standard names for the X outreach agent's flows:

**Action flows (write, have guards, write to action_log)**
- `send_dm(user_id, message)` — hard break: never if already sent unreplied; soft break: 7 days after reply
- `comment_on_post(post_id, user_id, comment)` — hard break: never comment twice on same post
- `reply_to_mention(mention_id, user_id, reply)` — hard break: never reply twice to same mention
- `reply_to_dm(user_id, message)` — soft break: don't send if last message in thread is ours
- `follow_user(user_id)` — hard break: already following
- `like_post(post_id)` — hard break: already liked

**Scrape flows (read, safe to repeat, still log to action_log for analytics)**
- `search_posts(query, count)` → list of post_ids
- `search_users(query, count)` → list of user_ids
- `get_dm_thread(user_id)` → recent messages
- `get_post_comments(post_id)` → list of comments
- `get_mentions()` → unread mentions
- `get_profile(user_id)` → bio, follower count, recent posts

---

*This document is a living design reference. Update it as decisions are made and the system evolves.*
