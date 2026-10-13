
This is a **scrape flow** — it reads data from pages without side effects.
Key requirements for scrape flows:
- `flowType` in submit_flow MUST be `"scrape"`
- Do NOT add dedup keys or requiresApproval — those are for action flows only
- Guard empty results: after extraction steps, add condition guards to verify data was found
- Prefer data-testid selectors over class names for reliability

## Screenshot rule for scrape flows

Do NOT add a screenshot step to scrape flows. Screenshots belong in action flows only (where they confirm an irreversible action succeeded).

For scrape flows: if the data came back, the flow worked. The data IS the evidence of success. A screenshot adds overhead on every run and provides no value — the flow runner logs failures automatically.

The tab lifecycle for scrape flows is:
1. `open_tab` (active: false)
2. `wait_for_any` (wait for page ready)
3. data extraction steps (`get_text`, `get_dom_filtered`, `web_fetch`, etc.)
4. `close_tab`

No screenshot step. If the explorer phase confirmed the data extraction works, trust it.

## Feed scraping — MANDATORY scroll_load pattern

When scraping a **feed, timeline, search results list, or any infinite-scroll container** (LinkedIn feed, Twitter/X timeline, LinkedIn search results, Reddit listing, etc.), you MUST add `scroll_load` — the page only loads content as you scroll, so without it you will always hit the limit before reaching it.

**Two things to add:**

1. A `scrolls` input field alongside `limit` — the manager agent sets this at runtime to control how deep to scroll:
```json
{ "key": "scrolls", "description": "Number of scroll cycles to load feed content before extracting (default 3)" }
```

2. A `scroll_load` step immediately after `wait_for_any`, before any extraction:
```json
{
  "id": "scroll_feed",
  "toolName": "scroll_load",
  "label": "Scroll to load feed content",
  "inputMapping": {
    "tabId":    { "type": "step_ref", "stepId": "open_step", "path": "tabId" },
    "selector": { "type": "literal", "value": "<scrollable container selector from explorer>" },
    "times":    { "type": "flow_input", "key": "scrolls" },
    "wait_ms":  { "type": "literal", "value": 1500 }
  }
}
```

**Testing rule:** when calling `test_flow` during build, always pass `scrolls: 1`. One scroll cycle is enough to confirm the step runs — using more just floods the agent with data and slows the build down. The manager agent will use larger values at runtime.

## Expandable content — click_all after scroll_load

Many feeds truncate post text behind an expand button (LinkedIn "…see more", Twitter "Show more", etc.). If the explorer phase reveals expandable elements, add a `click_all` step immediately after `scroll_load` and before extraction:

```json
{
  "id": "expand_posts",
  "toolName": "click_all",
  "label": "Expand truncated post text",
  "inputMapping": {
    "tabId":    { "type": "step_ref", "stepId": "open_step", "path": "tabId" },
    "selector": { "type": "literal", "value": "<expand button selector confirmed by explorer>" },
    "limit":    { "type": "flow_input", "key": "limit" }
  }
}
```

Pass `limit` from the flow input — if you're scraping 5 posts, you need at most 5 clicks. Errors are silently ignored (a missing expand button just means that post's text was already fully visible). No condition needed on this step.

The full feed scrape sequence is: `scroll_load` → `click_all` (if expandable) → `get_dom_filtered` → `close_tab`.

**When NOT to add scroll_load:**
- Single-item pages (a profile, a single post, an article)
- Flows using `web_fetch` to hit an API endpoint directly
- Pages with button-based pagination ("Load more" / "Next page")

