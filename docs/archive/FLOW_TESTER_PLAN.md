# Flow Tester & Input Normalization — Improvement Plan

## The Root Problem

When a user builds a scraping flow and tests it in the UI, they get a black box: one input in, one output out. If something breaks in the middle — a URL that wasn't normalized, a wrong selector, a fetch that returned HTML instead of JSON — there is no way to tell which step failed, what the intermediate state was, or whether the flow even did what the builder agent claimed.

The `get_post_thread` flow exposed this perfectly. The builder agent confidently said "works with www.reddit.com URLs" — and technically that's true *if* the URL is normalized to the JSON API format before fetching. But when tested in the UI, a bare `www.reddit.com` URL returned a wall of HTML. The tester just showed the final output with no indication of what went wrong.

There are three distinct problems to solve:

1. **The builder agent has a conflict of interest** — it built the flow, so it shouldn't be the one deciding whether it works
2. **The flow itself** — URL normalization must happen inside the flow, before the fetch, reliably
3. **The tester UI** — step-level traces sound useful but mostly catch the wrong kind of failure

---

## Problem 1: The Builder Agent Can't QA Its Own Work

### What's happening

The builder agent tests the flow by constructing its own tool call. It likely hard-coded the `.json` URL in the test — meaning it never tested the normalization path the user will actually hit. It declared the flow complete based on a test it designed to pass.

This is a conflict of interest. The builder agent knows too much: it knows the implementation, it knows what URL format it used internally, and it has every incentive to declare success.

### The fix: A dedicated QA validation pass

After the builder agent finishes, a separate lightweight **validation pass** runs. This validator only sees what the future chatbot will see:

- The flow name
- The flow description
- The input field names and their descriptions

It knows nothing about the implementation. It approaches the flow as a naïve user would. Given only the description "accepts www.reddit.com or old.reddit.com URLs", it generates a realistic raw test input and runs it. If the output doesn't match what the description promised, the flow goes back for revision.

This doesn't need to be a full agent with many tool calls. It's a focused Haiku pass: *"Here is the flow's description. Here is the output from a realistic test input. Does this output fulfill the description's promise? Yes or no, and why."*

The builder agent should not have the final say. The validator does.

### Expected output as a contract

To make the validator's job concrete, the flow schema should include an **expected output description** alongside the name and description. Not a rigid JSON schema — just a plain-English statement of what a successful output looks like:

> "A JSON object containing the post title, author, body, score, and a `comments` array. Each comment has author, body, timestamp, and an optional nested `replies` array."

The validator checks the actual output against this statement. If the output is `{"html":""}` or 80KB of React app HTML, it fails immediately and explains why.

This also has a second benefit: it forces the builder agent to articulate what success looks like *before* it runs the test, which catches vague flows early.

---

## Problem 2: URL Normalization in Flows

### What's happening

The builder agent produces a flow that claims to accept `www.reddit.com` URLs. What it actually needs to do is transform the input URL into `https://www.reddit.com{path}.json?raw_json=1` before calling `web_fetch`. If this transformation step is missing or broken, `web_fetch` hits the React app and returns HTML.

### Fix: A dedicated `transform` step type

Rather than relying on the builder agent to write normalization logic correctly, the flow runner should support a lightweight **transform step** — a small piece of logic that runs on the input before it hits `web_fetch` or any other tool.

```
Step type: "transform"
Input:  { post_url: "https://www.reddit.com/r/lovable/comments/abc123/title/" }
Logic:  strip trailing slash, append .json?raw_json=1
Output: { api_url: "https://www.reddit.com/r/lovable/comments/abc123/title/.json?raw_json=1" }
```

This makes the normalization an explicit, visible part of the flow — not something hidden inside a prompt instruction that may or may not execute.

### Short-term fix (before transform steps are built)

Update the flow builder agent's system prompt to require that any flow accepting a user-provided URL must test with a raw, unmodified URL from the user (not a pre-constructed one). The agent should not mark a flow complete until it has confirmed the full path — user input → normalization → fetch → extraction — works end to end.

---

## Problem 3: The Flow Tester Shows Technical Success, Not Semantic Success

### The real issue with step-level traces

The instinct to add step-level visibility is right, but the framing is off. Steps almost never fail technically:

- `web_fetch` returns 200 with 80KB of HTML — **technically succeeded**
- `click` returns `true` — **technically executed**, nothing happened on screen
- `extract_text` returns an empty string — **technically ran**, just returned nothing useful

A step-level trace showing ✅ ✅ ✅ would have given false confidence in the exact scenario that broke. The Reddit flow ran every step without error. The failure was semantic: the output didn't contain what it was supposed to contain.

### What actually helps

Instead of "did the step execute", the tester needs to surface "does the output make sense":

**1. Smart output detection**
If the final output contains `<html>`, `<!DOCTYPE`, or a `Content-Type: text/html` signal, show a prominent warning:
> ⚠️ This output looks like raw HTML, not structured data. The flow may have fetched a rendered page instead of an API endpoint.

**2. Output shape validation against the expected output description**
If the flow has an expected output description (see Problem 1), the tester checks the actual output against it and flags mismatches. This is not a schema validator — it's a Haiku call: *"Does this output match what was promised?"*

**3. Step trace for input/output visibility (not error detection)**
A collapsible step trace is still valuable — not for catching errors, but for understanding what actually happened. Seeing that Step 1 received `www.reddit.com/...` and Step 2 fetched `www.reddit.com/....json?raw_json=1` tells you the normalization worked. Seeing that both steps received the same raw URL tells you it didn't.

The trace is a debugging tool, not a quality gate. The quality gate is the expected output validation.

---

## Implementation Priority

| # | Task | Impact | Effort | Notes |
|---|------|--------|--------|-------|
| 1 | Add `expectedOutput` field to flow schema | High | Low | Foundation for everything else |
| 2 | QA validation pass after builder agent finishes | High | Low | Haiku call, not a full agent |
| 3 | HTML detection warning in tester output | High | Low | Catches the exact failure that prompted this plan |
| 4 | Expected output validation in tester | High | Medium | Requires #1 |
| 5 | Update builder agent prompt: test raw user inputs | Medium | Low | Short-term fix for normalization |
| 6 | `transform` step type in flow runner | High | Medium | Long-term fix for normalization |
| 7 | Collapsible step trace in tester | Medium | High | Useful for debugging, not a quality gate |

---

## The Right Mental Model

The builder agent's job is to produce a flow that fulfills its description — not a flow that passes a test it designed itself.

The validator's job is to catch the gap between what the description promises and what the flow actually delivers, from the perspective of a user who knows nothing about the implementation.

The tester's job is not to catch errors (steps rarely error). It's to make it immediately obvious when the output doesn't match the promise — and the clearest signal for that is the expected output description, not a green checkmark on every step.

Right now none of those three things are fully true. This plan fixes all of them.
