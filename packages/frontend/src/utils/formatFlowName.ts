/**
 * Converts a snake_case flow name to Title Case With Spaces for user-facing display.
 *
 * Examples:
 *   scrape_subreddit_top_posts  →  Scrape Subreddit Top Posts
 *   send_dm                     →  Send Dm
 *   __query_memory__            →  __query_memory__  (sentinel steps kept as-is)
 */
export function formatFlowName(name: string): string {
  // Leave internal sentinel steps (surrounded by __) unchanged
  if (name.startsWith('__') && name.endsWith('__')) return name;
  return name
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
