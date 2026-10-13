# OPERATION SCREENSHOT REFS
### Stop throwing away what the agent sees.

**Objective:** Flow steps that capture screenshots currently strip the image data and replace it with the useless string `[screenshot captured]` before anyone can use it. This breaks QA (which can't verify actions actually happened), wastes agent context (the placeholder is noise), and means the user can never see what the agent did. The fix: save screenshots to disk and pass a URL reference instead. The image stays accessible — for QA, for the chat UI, for debugging — without bloating agent context with a 200KB base64 blob.

**Status:** Implementation complete. All 5 tasks done. Ready for end-to-end verification (Task 6).

**How to use this file:**
- Start each session by reading this file first
- Pick the next `[ ]` task
- Mark completed tasks `[x]` and write a brief note before ending the session
- Never leave the codebase in a broken/non-compiling state at end of session

**Status markers:**
- `[ ]` not started
- `[>]` in progress (session was interrupted — read the note before continuing)
- `[x]` done
- `[!]` blocked — see note
- `[—]` moved out of scope

---

## The Problem

`flow-runner.ts` has a single regex in `assembleResult()` that replaces every `data:image/...;base64,...` blob with the literal string `[screenshot captured]`. This runs unconditionally before the result is returned anywhere — to the agent, to QA, to the frontend.

Consequences:
1. **QA always fails on screenshot contracts.** The contract says "A screenshot (base64 PNG)" but the actual output is `[screenshot captured]`. QA runs after stripping, so it never sees real image data.
2. **Agent context is polluted with noise.** `[screenshot captured]` tells the agent nothing useful. It can't reason about what was visible on screen.
3. **Users can't review what the agent did.** The chat UI never gets image data to render — there's nothing to show.

The original intent was sensible: don't pass 200KB base64 blobs into every subsequent Claude API call. But the solution (strip entirely) was too aggressive. The right solution is to persist the image once and pass a URL.

---

## What Exists (Don't Rebuild)

- **Screenshot event type** — `flows-generate.ts` already emits `{ type: 'screenshot', data: string }` (base64) during generator runs. Frontend already renders these inline with `<img>`.
- **Flow runner extraction** — `flow-runner.ts` already extracts raw base64 from data URLs at lines 726, 751, and 1476 for use in vision calls. Same extraction just needs to also save to disk.
- **`data/` directory** — already exists at the project root. `packages/backend/data/` is already in `.gitignore`.
- **Fastify backend** — supports `@fastify/static` for serving files. Not yet registered, but it's a 3-line addition.
- **Frontend screenshot rendering** — `FlowGenerator.tsx` already has a screenshot card component that toggles open/closed. Currently uses `data:image/png;base64,${item.data}`. Just needs `item.url` instead.

---

## Architecture

### Storage
Screenshots are saved to `packages/backend/data/screenshots/` as `{runId}-{stepId}.png` (or similar unique name). The directory is already covered by the existing `.gitignore` entry for `packages/backend/data/`.

### Reference format
Anywhere a screenshot currently appears inline, replace it with a JSON object:
```json
{ "type": "screenshot_ref", "url": "/screenshots/abc123-step_4.png" }
```
The agent sees a lightweight structured reference. The frontend and QA resolve the URL to the actual image.

### Serving
Register `@fastify/static` on the backend to serve `packages/backend/data/screenshots/` at `/screenshots/`. One plugin registration.

### QA
The QA step in `flows-generate.ts` currently passes a text summary to Claude Haiku — no images. For screenshot contracts, it should pass the actual image using Claude's vision capability (same pattern already used elsewhere in `flow-runner.ts` for `runEvaluateStep`).

---

## Tasks

---

### TASK 1 — Save screenshots to disk in `flow-runner.ts`

**Status:** `[x]` — Added `packages/backend/src/lib/screenshots.ts` with `saveScreenshotToDisk()` helper. Imported in `flow-runner.ts`.

Replace the three base64 extraction sites in `flow-runner.ts` (lines 726, 751, 1476) with a helper that:
1. Extracts the base64 data from the data URL (same as today)
2. Writes the PNG to `packages/backend/data/screenshots/{uuid}.png`
3. Returns the URL path `/screenshots/{uuid}.png`

Also add a `ensureScreenshotDir()` call at startup (or lazy on first write) to create the directory if it doesn't exist.

**Files touched:**
- `packages/backend/src/features/flows/flow-runner.ts`

---

### TASK 2 — Replace the stripping regex with a URL reference

**Status:** `[x]` — `assembleResult()` now matches `"data:image/...;base64,..."` JSON string values, saves each to disk, and replaces with `{"type":"screenshot_ref","url":"/screenshots/uuid.png"}` inline.

In `assembleResult()` (flow-runner.ts line 1245), replace:
```
finalResult = finalResult.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[screenshot captured]');
```
with logic that replaces each base64 data URL with the corresponding `{ "type": "screenshot_ref", "url": "/screenshots/..." }` reference that was saved in Task 1.

The screenshot saving (Task 1) must happen before `assembleResult()` runs, so the URL is already known by the time we need to embed it. Either pass the URL map through, or do the save here directly for any remaining inline base64 that wasn't caught earlier.

**Files touched:**
- `packages/backend/src/features/flows/flow-runner.ts`

---

### TASK 3 — Serve screenshots as static files

**Status:** `[x]` — Used a custom Fastify GET route (`/screenshots/:filename`) in `index.ts` instead of `@fastify/static` (pnpm workspace prevented npm install). Route validates the filename (UUID pattern only), reads the PNG with `readFileSync`, and returns it with `Content-Type: image/png`.

**Files touched:**
- `packages/backend/src/index.ts`
- `packages/backend/src/lib/screenshots.ts` (new)

---

### TASK 4 — Update QA to pass screenshot images to Claude

**Status:** `[x]` — QA step now detects `screenshotUrl` in the test result, reads the PNG from disk, and passes it as an `image` content block to Claude Haiku alongside the text prompt.

The QA validation in `flows-generate.ts` (lines 1520–1587) currently passes only a text summary to Claude Haiku. When the flow output contains a `screenshot_ref`, the QA step should:
1. Detect the `screenshot_ref` in the result
2. Read the PNG from disk
3. Pass it to Claude as a `image` content block (same pattern as `runEvaluateStep` in flow-runner.ts which already does this)
4. Update the prompt to say "Here is the screenshot. Does it match the contract?"

This is what actually fixes the QA failure — Claude can now see the image and make a real judgment.

**Files touched:**
- `packages/backend/src/routes/flows-generate.ts`

---

### TASK 5 — Render screenshot references in the FlowGenerator chat

**Status:** `[x]` — `screenshot` event now carries `url` instead of `data`. Frontend renders `<img src="http://localhost:3001/screenshots/...">`. Flow result panel also detects `screenshot_ref` objects and renders the image inline.

The FlowGenerator already renders `{ kind: 'screenshot', data: string }` (base64) as an inline collapsible image card. Two things to update:

1. **Generator screenshots** (during building): the event type emitted from `flows-generate.ts` currently sends `data` (base64). Change to send `url` (the `/screenshots/...` path) once Task 1–3 are done.
2. **Flow result screenshots**: when the final flow result contains a `screenshot_ref` object, render it as a screenshot card in the result display — same component, just sourced from the URL.

The `<img>` just changes from `src={`data:image/png;base64,${item.data}`}` to `src={item.url}`.

**Files touched:**
- `packages/frontend/src/pages/agent/FlowGenerator.tsx`
- `packages/backend/src/routes/flows-generate.ts` (screenshot event emission)

---

### TASK 6 — Verify end to end

**Status:** `[ ]`

Run an action flow that takes a screenshot (e.g. the Reddit reply flow). Check:
- [ ] Screenshot file appears in `packages/backend/data/screenshots/`
- [ ] `GET /screenshots/{filename}.png` returns the image in the browser
- [ ] Flow result JSON contains `{ "type": "screenshot_ref", "url": "/screenshots/..." }` not `[screenshot captured]`
- [ ] QA step passes (Claude actually sees the image and can evaluate the contract)
- [ ] Screenshot renders inline in the FlowGenerator chat
- [ ] Reloading the page / coming back to an old session: screenshot still loads (disk-persisted)

---

## Context: Why screenshots matter for correctness

Action flows that interact with web UIs face a fundamental verification problem: most browser tools (click, type, submit) return success even if the action didn't visually succeed. A click on a "Reply" button returns `true` whether or not the reply form appeared. The only reliable confirmation is a screenshot taken after the action — it's ground truth.

Stripping that screenshot was equivalent to throwing away the receipt after a transaction. The agent (and QA) had no way to know if anything actually happened. With references, the receipt is kept, it's cheap to pass around, and anyone who needs to verify can go look at it.
