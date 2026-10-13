
This is an **action flow** — it performs side-effecting operations (send DM, post comment, follow user, etc.).
Key requirements for action flows:
- `flowType` in submit_flow MUST be `"action"`
- `dedupKeyField` MUST be set in submit_flow — the input field that uniquely identifies the target (e.g. `"post_url"`, `"user_handle"`). **Without this the flow will throw a hard runtime error when called.**
- `dedupBreakType` MUST be set: `"hard"` if the action should never repeat for the same target, `"soft"` if it can repeat after a cooldown
- `dedupBlockMessage` SHOULD be set — tell the agent what to do when blocked (e.g. "Use reply_to_comment to respond further")
- Set `requiresApproval: true` for irreversible or content-heavy actions
- Add DOM check steps after click/submit to detect silent failures

## SMART CONTENT PIPELINE — MANDATORY for content-writing flows

For ANY flow that writes text content to an external platform (post comment, reply, send DM, publish post), you MUST use the two-step smart pipeline. This is non-negotiable.

WRONG: accept `comment_body`, `reply_text`, `message_text`, or any raw string as input
RIGHT: accept `action_brief` (an ActionBrief object) and use `__hydrate__` + `__generate__` as the first two steps

**Step 0 — `__hydrate__`** (sentinel, not a real tool UUID):
```json
{
  "id": "hydrate_step",
  "toolName": "__hydrate__",
  "label": "Hydrate action brief",
  "inputMapping": { "brief": { "type": "flow_input", "key": "action_brief" } }
}
```

**Step 1 — `__generate__`** (sentinel, not a real tool UUID):
```json
{
  "id": "generate_step",
  "toolName": "__generate__",
  "label": "Generate content (Sonnet)",
  "stepModel": "claude-sonnet-4-6",
  "inputMapping": { "hydrated_context": { "type": "step_ref", "stepId": "hydrate_step", "path": "" } }
}
```

The `__generate__` step outputs a named field based on action type:
- `post_comment` / `reply_to_comment` → `comment_text`
- `send_dm` → `message_text`
- `send_tweet` → `tweet_text`
- `send_email` → `email_body`
- `create_post` / `publish_post` → `post_text`

Reference this in the downstream type step: `{ "type": "step_ref", "stepId": "generate_step", "path": "comment_text" }`

Input schema for smart content flows must include the target URL/ID (for dedup) PLUS `action_brief`:
```
{ post_url: string, action_brief: object }   // dedup on post_url, not action_brief
```

Do NOT use the smart pipeline for: likes, follows, reactions, or flows posting a literal pre-written string explicitly provided by the user.

## ActionBrief schema (exact — must pass Zod validation)

`__hydrate__` validates the `brief` input against this schema. If it doesn't match, the step errors.

```json
{
  "action": {
    "type": "post_comment",
    "draft": "optional pre-written draft — Sonnet improves/replaces this"
  },
  "decision_context": {
    "reason": "Why the agent decided to take this action — used by Sonnet as the generation brief",
    "supporting_scrapes": [],
    "memory_queries": [],
    "database_context": []
  }
}
```

- `action.type` — required string identifying the action (e.g. `post_comment`, `send_dm`, `send_tweet`)
- `action.draft` — optional, extra fields (e.g. `post_url`, `subreddit`) are allowed via catchall
- `decision_context.reason` — required; this is the main prompt Sonnet receives
- `supporting_scrapes`, `memory_queries`, `database_context` — required arrays, can be empty `[]`

**When constructing a test input for `request_test_inputs`, use exactly this shape:**
```json
{
  "action": { "type": "post_comment" },
  "decision_context": {
    "reason": "Post a helpful on-topic reply — friendly and technical tone",
    "supporting_scrapes": [],
    "memory_queries": [],
    "database_context": []
  }
}
```

