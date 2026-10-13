export interface PlatformConstraint {
  area: string;
  reason: string;
  severity: 'blocking' | 'rate_limit' | 'warning';
  workaround: string | null;
}

export interface PlatformEntry {
  platform: string;
  domainPatterns: string[];
  constraints: PlatformConstraint[];
  safeFlows: string[];
}

export const PLATFORM_CONSTRAINTS: PlatformEntry[] = [
  {
    platform: 'Reddit',
    domainPatterns: ['reddit.com'],
    constraints: [
      {
        area: 'direct_messages',
        reason: 'Reddit Chat (rs-app, rs-rooms-nav, rs-virtual-scroll) uses nested Web Components with multiple Shadow DOM layers. Standard document.querySelector cannot cross shadow boundaries. All DM/Chat content is unreachable via CSS selectors.',
        severity: 'blocking',
        workaround: null,
      },
      {
        area: 'anti_bot_rate_limits',
        reason: 'Reddit detects rapid automated posting. Posting too frequently triggers shadowbans silently.',
        severity: 'rate_limit',
        workaround: 'Space actions with wait_ms, randomise intervals, cap to 3-5 actions per hour per subreddit.',
      },
    ],
    safeFlows: ['check_notifications', 'check_inbox', 'read_posts', 'read_comments', 'post_comment', 'submit_post', 'search_subreddit', 'scrape_post_thread'],
  },
  {
    platform: 'Twitter / X',
    domainPatterns: ['twitter.com', 'x.com'],
    constraints: [
      {
        area: 'anti_bot_detection',
        reason: 'Twitter/X has aggressive bot detection. Automated interactions at scale trigger temporary suspensions.',
        severity: 'rate_limit',
        workaround: 'Use human-like delays, avoid clicking faster than 1 interaction per 2-3 seconds. Keep daily action counts low (<50/day for new accounts).',
      },
      {
        area: 'dm_spam_detection',
        reason: 'Sending DMs to many users rapidly flags the account for spam.',
        severity: 'rate_limit',
        workaround: 'Limit DMs to users who have recently interacted with your posts. Always require human review before sending.',
      },
    ],
    safeFlows: ['check_notifications', 'search_tweets', 'scrape_profile', 'read_timeline', 'check_dms'],
  },
  {
    platform: 'LinkedIn',
    domainPatterns: ['linkedin.com'],
    constraints: [
      {
        area: 'automation_detection',
        reason: 'LinkedIn actively blocks automation tools and can permanently ban accounts. They detect non-human interaction patterns.',
        severity: 'warning',
        workaround: 'Keep all actions slow and human-paced. Limit to 20-30 profile views per day. Always add meaningful delays.',
      },
      {
        area: 'connection_request_limits',
        reason: 'LinkedIn limits connection requests to ~100/week for standard accounts. Exceeding this restricts the account.',
        severity: 'rate_limit',
        workaround: 'Cap connection requests at 15-20 per day. Only connect with people you have a genuine reason to contact.',
      },
    ],
    safeFlows: ['search_people', 'scrape_profile', 'check_notifications', 'read_messages'],
  },
  {
    platform: 'Instagram',
    domainPatterns: ['instagram.com'],
    constraints: [
      {
        area: 'automation_blocks',
        reason: 'Instagram aggressively detects automation and issues action blocks (temporary 24-hour bans on liking, following, commenting).',
        severity: 'rate_limit',
        workaround: 'Stay well below limits: <60 follows/day, <150 likes/day, <60 comments/day. Add 30-60 second delays between actions.',
      },
    ],
    safeFlows: ['check_notifications', 'search_hashtag', 'scrape_profile'],
  },
];

export function getConstraintsForPlatform(systemPrompt: string, description: string): PlatformEntry[] {
  const text = (systemPrompt + ' ' + description).toLowerCase();
  return PLATFORM_CONSTRAINTS.filter((entry) =>
    entry.domainPatterns.some((pattern) => text.includes(pattern.replace('.com', '').toLowerCase()) || text.includes(pattern))
  );
}

export function buildConstraintBlock(entries: PlatformEntry[]): string {
  if (entries.length === 0) return '';

  const lines: string[] = ['PLATFORM CONSTRAINTS (CRITICAL — read before proposing flows):'];
  for (const entry of entries) {
    for (const c of entry.constraints) {
      if (c.severity === 'blocking') {
        lines.push(`- ${entry.platform} — ${c.area}: COMPLETELY BLOCKED. ${c.reason} Do NOT propose any flows related to this area.`);
      } else {
        lines.push(`- ${entry.platform} — ${c.area}: RATE LIMITED. ${c.reason} ${c.workaround ? 'Mitigation: ' + c.workaround : ''}`);
      }
    }
  }
  return lines.join('\n');
}
