# Builder ↔ DB Flow Sync

**How to use this file:**
- Start each session by reading this file first
- Pick the next `[ ]` task — do exactly one task per session
- Mark it `[x]` and write a brief note under it before ending the session
- Never leave the codebase in a broken/non-compiling state at end of session

**Status markers:**
- `[ ]` not started
- `[>]` in progress (session was interrupted — read the note before continuing)
- `[x]` done
- `[!]` blocked — see note

---

## Background (read once)

When the AI generates a flow in the builder, the flow object lives in React state (set from the generation response). The Flows Debugger extension talks directly to the DB via `PATCH /agents/:agentId/flows/:flowId`. These two are not connected — once the debugger saves changes, the builder page has no idea and keeps showing the old version.

The hard constraint: the builder page cannot be reloaded, because the chat history lives only in React memory and a reload would restart the entire flow generation process.

**Chosen design:**
1. The Edit Steps split-screen editor always fetches fresh from the DB on mount — never trusts the prop passed by the parent.
2. When Edit Steps closes, it passes the refreshed flow back up to the builder so the right-side step panel is also current.
3. A small "↺ Repull from DB" button sits in the builder's flow panel, letting the user force a re-fetch at any time without leaving the page or reloading.

---

## Group 1 — Edit Steps always loads from DB

### Task 1 — Edit Steps component: fetch from DB on mount
**Files:** The React component that renders the split-screen Edit Steps view (likely `FlowEditor` or similar in `packages/frontend/src/`)
**Done when:** When Edit Steps opens, it calls `GET /agents/:agentId/flows/:flowId` and uses the DB response as its source of truth — ignoring whatever flow object was passed as a prop. A loading state is shown while the fetch is in progress. If the fetch fails, an error is shown and the user can retry.
**Depends on:** nothing
**Status:** `[x]`
**Notes:** Added `REINIT` action to `useFlowEditorState` reducer (resets draft via `initDraft`). In `FlowEditor`, on mount: if editing an existing flow, calls `api.getFlow(agentId, flowId)` and dispatches `REINIT` with the response. Shows a spinner while loading and an error screen with a Retry button on failure. New flows (`flow === null`) skip the fetch entirely.

---

### Task 2 — Edit Steps: pass refreshed flow back to parent on close
**Files:** Same Edit Steps component + its parent in the builder page
**Done when:** When the Edit Steps panel is closed (whether the user saved anything or not), the parent's flow state is updated with the version the editor fetched from the DB in Task 1. The right-side step list in the builder then reflects the DB state without any reload.
**Depends on:** Task 1
**Status:** `[x]`
**Notes:** Added `fetchedFlow: Flow | null` state to `FlowEditor` — populated when the mount-time DB fetch succeeds. Changed `onCancel: () => void` → `onCancel: (refreshedFlow: Flow | null) => void` so callers get the DB version on close. Updated three call sites: (1) `FlowsTab` — imports `useQueryClient` and patches the `['flows', agentId]` cache entry with the refreshed flow on both save and cancel; (2) `AgentOnboarding` — updates `inlineEditorFlow` on cancel so the right-side step panel reflects the DB state immediately. New flows (`flow === null`) pass `null`, which callers already guard against.

---

## Group 2 — Manual repull button

### Task 3 — Add "↺ Repull from DB" button to the builder flow panel
**Files:** The component that renders the right-side step list in the builder (the panel showing step names/IDs)
**Done when:** A small "↺ Repull" button (or icon button) appears in the flow panel header. Clicking it calls `GET /agents/:agentId/flows/:flowId` and updates the step list in place. A spinner shows during the fetch. A brief "Updated" confirmation appears on success. The chat and all other builder state are completely unaffected.
**Depends on:** nothing (can be done independently of Tasks 1–2)
**Status:** `[x]`
**Notes:** Added `↺ Repull` button to the FlowEditor header (only when editing an existing flow, i.e. `flow !== null`). Uses a standalone `handleRepull` function with its own `repullLoading` / `repullUpdated` state — completely independent of the mount-time `fetchFromDb`. Calls `api.getFlow(agent.id, flow.id)`, dispatches `REINIT` on success, shows `⏳ Pulling…` spinner during fetch, then flips to `✓ Updated` (green) for 2.5 s. Error shows via `alert`. All other editor state (draft edits, test panel, feedback, fix mode) is untouched.

---

## Group 3 — Verification

### Task 4 — End-to-end test
**Done when:**
1. Build a flow in the builder → open Edit Steps → confirm it shows the current DB version (not a stale cached version)
2. Open the Flows Debugger, add a step, lock it in → go back to the builder, click Edit Steps → the new step is visible immediately
3. Click "↺ Repull" in the builder panel → the step list updates to show the debugger's saved version
4. The chat history and builder state are unchanged throughout

**Depends on:** Tasks 1, 2, 3
**Status:** `[ ]`
**Notes:**
