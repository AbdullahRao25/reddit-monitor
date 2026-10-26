// Simulated Reddit for the demo server. Same interface as createRedditClient()
// (getUserAbout, getUserListing, getInfo, verify), backed by scripted personas
// whose activity, karma, removals and visibility are functions of time. That
// lets the real checker run across weeks of history and then keep going live.
//
// Usernames that aren't scripted get a deterministic synthetic persona, so the
// one-off check and "add account" work for any name.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(text) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];
// Persona settings may be constants or functions of "days before now".
const at = (setting, daysAgo) => (typeof setting === 'function' ? setting(daysAgo) : setting);

// Organic comments are assembled from fragments (10 x 12 x 8 combinations),
// so only the scripted copy-paste persona trips duplicate detection.
const OPENERS = [
  'Honestly,', 'Good question.', 'Same here,', 'For what it is worth,', 'Agreed,', 'Not sure about that,',
  'Late to this, but', 'Funny timing,', 'Small tip:', 'From experience,',
];
const MIDDLES = [
  'swapping the cheap part for a decent one fixed it for me',
  'the manual covers this better than any video I found',
  'starting small and working up from there worked best',
  'support sorted mine out within a day',
  'the rules changed a few months ago so check the sidebar',
  'I would wait for the next sale before buying',
  'the second photo shows it really well',
  'it took me about three weekends to get right',
  'measuring twice saved me from the same mistake',
  'the older model is still the better value',
  'a cheap moisture meter would answer that quickly',
  'you can usually return it if it does not fit',
];
const CLOSERS = [
  'Hope that helps.', 'Good luck!', 'Let us know how it goes.', 'Worth a try.', '', 'Nice work either way.',
  'Happy to share more details.', 'Took me a while to figure out.',
];
const organicComment = (rand) => `${pick(rand, OPENERS)} ${pick(rand, MIDDLES)}. ${pick(rand, CLOSERS)}`.trim();

const GENERIC = {
  titles: [
    'What is the one tool you would buy again without thinking?',
    'Finally finished the project I started last spring',
    'Is this normal, or should I be worried?',
    'Small win today, wanted to share',
    'Looking for recommendations before I commit',
    'Lessons learned after a year of doing this',
  ],
  threads: ['Weekly discussion thread', 'Ask anything', 'What are you working on?', 'Show and tell'],
  subs: ['AskReddit', 'NoStupidQuestions', 'CasualConversation', 'mildlyinteresting', 'todayilearned'],
};

// Days are relative to the moment the demo server starts ("now").
const PERSONAS = [
  {
    username: 'maple_threads',
    label: 'Main account',
    notes: 'Personal account: woodworking and home projects.',
    ageDays: 1180,
    monitorDays: 21,
    karma: { link: 4210, comment: 8875 },
    verified: true,
    perDay: 2.2,
    postShare: 0.25,
    score: [4, 60],
    subs: ['woodworking', 'DIY', 'BuyItForLife', 'HomeImprovement', 'handtools'],
    titles: [
      'Walnut side table, my first attempt at drawbored joints',
      'Restored my grandfather\'s No. 4 plane',
      'Which finish holds up best on a kitchen table?',
      'Built a simple wall cleat system for the garage',
    ],
    removal: () => ({ rate: 0.03, by: 'moderator' }),
  },
  {
    username: 'quietharbor_dev',
    label: 'HarborKit launch',
    notes: 'Founder account, posting launch updates for harborkit.io.',
    ageDays: 230,
    monitorDays: 21,
    karma: { link: 655, comment: 1940 },
    verified: true,
    perDay: (d) => (d < 14 ? 4.5 : 2.4),
    postShare: (d) => (d < 14 ? 0.5 : 0.3),
    score: [0, 25],
    subs: ['SaaS', 'startups', 'webdev', 'SideProject', 'Entrepreneur', 'selfhosted', 'devops'],
    domain: 'harborkit.io',
    domainShare: (d) => (d < 14 ? 0.85 : 0.25),
    // Launch week: one URL to every subreddit.
    crosspostUrl: (d) => (d < 5 ? 'https://harborkit.io/launch?utm_source=reddit' : null),
    mentionShare: (d) => (d < 14 ? 0.35 : 0.05),
    titles: [
      'We launched HarborKit: self-hosted status pages in one binary',
      'How we cut our incident page load time to 80 ms',
      'HarborKit 1.2 is out, now with Slack and Discord hooks',
      'Show HN-style feedback wanted: open-source status pages',
    ],
    comments: [
      'We built a tool for exactly this, happy to answer questions.',
      'Good write-up. We hit the same wall with our uptime checks.',
      'Status pages are underrated, they save so many support tickets.',
      'Incident comms matter more than the uptime number itself.',
    ],
    removal: (d, item) => {
      if (!item.link) return { rate: 0.03, by: 'moderator' };
      if (d < 4) return { rate: 0.4, by: ['moderator', 'automod_filtered', 'moderator', 'reddit'] };
      if (d < 14) return { rate: 0.4, by: ['moderator', 'automod_filtered'] };
      return { rate: 0.08, by: 'moderator' };
    },
  },
  {
    username: 'nova_drift_22',
    label: 'Growth test',
    notes: 'New account in stealth mode. Warm-up plan running.',
    ageDays: 13,
    monitorDays: 11,
    stealth: true,
    karma: { link: 18, comment: 26 },
    verified: false,
    perDay: 4,
    postShare: 0.3,
    score: [0, 9],
    subs: GENERIC.subs,
    // 2-5 am in America/Los_Angeles, the timezone of its fingerprint.
    nightUtcHours: [9, 12],
    nightShare: 0.7,
    removal: (d, item) =>
      item.isPost && d < 3 ? { rate: 0.4, by: 'reddit' } : { rate: 0.06, by: 'moderator' },
  },
  {
    username: 'ledger_lark',
    label: 'Old alt',
    notes: 'Was used for community support replies.',
    ageDays: 760,
    monitorDays: 21,
    karma: { link: 1320, comment: 3010 },
    commentDrop: { fromDays: 10, perDay: 22 },
    verified: true,
    perDay: (d) => (d < 12 ? 6 : 3),
    postShare: 0.12,
    score: [-4, 14],
    subs: ['techsupport', 'buildapc', 'pcmasterrace', 'Windows11', 'sysadmin'],
    duplicateTexts: [
      'Check out the pinned guide on my profile, it covers this exact problem step by step.',
      'This is a known issue, I wrote up the full fix in the pinned post on my profile.',
    ],
    duplicateShare: (d) => (d < 12 ? 0.55 : 0.1),
    removal: (d, item) =>
      d < 12 ? { rate: item.isPost ? 0.5 : 0.3, by: 'reddit' } : { rate: 0.05, by: 'moderator' },
    hidden: { fromDays: 1.6, state: 'not_found' },
  },
  {
    username: 'pinecone_relay',
    label: 'Giveaways',
    ageDays: 400,
    monitorDays: 21,
    karma: { link: 210, comment: 540 },
    verified: true,
    perDay: 9,
    postShare: 0.7,
    score: [0, 6],
    subs: ['giveaways', 'freebies', 'deals', 'gamedeals', 'FREE'],
    domain: 'prizeloop.net',
    domainShare: 0.6,
    removal: () => ({ rate: 0.25, by: ['moderator', 'reddit'] }),
    hidden: { fromDays: 8, state: 'suspended' },
  },
  {
    username: 'graniteowl_',
    label: null,
    notes: 'Possibly misspelled, confirm the exact username.',
    monitorDays: 5,
    neverVisible: true,
  },
  {
    username: 'tidewater_notes',
    label: 'Archive',
    notes: 'Read-only archive account. Paused on purpose.',
    ageDays: 1610,
    monitorDays: 21,
    pausedDays: 9,
    karma: { link: 22140, comment: 51230 },
    verified: true,
    perDay: 0.6,
    postShare: 0.4,
    score: [20, 400],
    subs: ['history', 'AskHistorians', 'MapPorn', 'papermoney'],
    removal: () => ({ rate: 0.02, by: 'moderator' }),
  },
];

function synthesize(username) {
  const lower = username.toLowerCase();
  if (/shadow|banned/.test(lower)) return { username, neverVisible: true };
  const rand = seeded(hashString(lower));
  if (/suspend/.test(lower)) return { username, ageDays: 300, hidden: { fromDays: 400, state: 'suspended' } };
  const archetype = ['healthy', 'healthy', 'promo', 'young'][Math.floor(rand() * 4)];
  if (archetype === 'promo') {
    const domain = pick(rand, ['getlaunchly.com', 'pixelpost.app', 'tryquill.io']);
    return {
      username,
      ageDays: 60 + Math.floor(rand() * 240),
      karma: { link: 80 + Math.floor(rand() * 600), comment: 100 + Math.floor(rand() * 900) },
      verified: true,
      perDay: 3,
      postShare: 0.5,
      score: [0, 15],
      subs: ['SaaS', 'startups', 'SideProject', 'marketing', 'smallbusiness'],
      domain,
      domainShare: 0.7,
      mentionShare: 0.2,
      removal: (d, item) => (item.link ? { rate: 0.3, by: ['moderator', 'automod_filtered', 'reddit'] } : null),
    };
  }
  if (archetype === 'young') {
    return {
      username,
      ageDays: 3 + Math.floor(rand() * 17),
      karma: { link: Math.floor(rand() * 6), comment: Math.floor(rand() * 8) },
      verified: false,
      perDay: 3,
      postShare: 0.3,
      score: [-1, 4],
      subs: GENERIC.subs,
      removal: (d, item) => (item.isPost ? { rate: 0.3, by: 'reddit' } : { rate: 0.1, by: 'moderator' }),
    };
  }
  return {
    username,
    ageDays: 300 + Math.floor(rand() * 2200),
    karma: { link: 300 + Math.floor(rand() * 9000), comment: 800 + Math.floor(rand() * 20000) },
    verified: true,
    perDay: 1 + rand() * 2,
    postShare: 0.25,
    score: [2, 40],
    subs: GENERIC.subs,
    removal: () => ({ rate: 0.03, by: 'moderator' }),
  };
}

function generateItems(persona, now) {
  if (persona.neverVisible) return [];
  const rand = seeded(hashString(`items:${persona.username.toLowerCase()}`));
  const prefix = hashString(persona.username.toLowerCase()).toString(36).slice(0, 4);
  const born = now - persona.ageDays * DAY;
  const end = now + 30 * DAY;
  const items = [];
  let t = Math.max(born + HOUR, now - 45 * DAY);
  let n = 0;

  while (t < end) {
    t += (-Math.log(1 - rand()) * DAY) / at(persona.perDay, (now - t) / DAY);
    let when = t;
    if (persona.nightUtcHours && rand() < persona.nightShare) {
      const [from, to] = persona.nightUtcHours;
      when = Math.floor(t / DAY) * DAY + (from + rand() * (to - from)) * HOUR;
    }
    if (when <= born || when >= end) continue;
    const daysAgo = (now - when) / DAY;
    const id = `${prefix}${(n++).toString(36)}`;
    const subreddit = pick(rand, persona.subs);
    const isPost = rand() < at(persona.postShare, daysAgo);
    const [low, high] = persona.score ?? [0, 10];
    let finalScore = Math.round(low + rand() * (high - low));

    let raw;
    if (isPost) {
      const link = Boolean(persona.domain) && rand() < at(persona.domainShare, daysAgo);
      const url = link
        ? (at(persona.crosspostUrl, daysAgo) ?? `https://${persona.domain}/blog/${id}`)
        : null;
      const title = pick(rand, persona.titles ?? GENERIC.titles);
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
      raw = {
        name: `t3_${id}`,
        author: persona.username,
        subreddit,
        created_utc: when / 1000,
        is_self: !url,
        domain: url ? new URL(url).hostname : `self.${subreddit}`,
        url: url ?? `https://www.reddit.com/r/${subreddit}/comments/${id}/${slug}/`,
        title,
        selftext: url ? '' : organicComment(rand),
        removed_by_category: null,
        score: finalScore,
        permalink: `/r/${subreddit}/comments/${id}/${slug}/`,
      };
    } else {
      let body = persona.comments && rand() < 0.5 ? `${pick(rand, persona.comments)} ${organicComment(rand)}` : organicComment(rand);
      if (persona.duplicateTexts && rand() < at(persona.duplicateShare, daysAgo)) {
        body = pick(rand, persona.duplicateTexts);
        finalScore = Math.min(finalScore, 0);
      } else if (persona.domain && rand() < at(persona.mentionShare ?? 0, daysAgo)) {
        body = `${body} More on ${persona.domain} if you're curious.`;
      }
      raw = {
        name: `t1_${id}`,
        author: persona.username,
        subreddit,
        created_utc: when / 1000,
        body,
        score: finalScore,
        link_title: pick(rand, GENERIC.threads),
        permalink: `/r/${subreddit}/comments/${prefix}x${id}/thread/${id}/`,
      };
    }

    const rule = persona.removal?.(Math.max(0, daysAgo), { isPost, link: Boolean(isPost && !raw.is_self) });
    const removed = rule ? rand() < rule.rate : false;
    const removedBy = removed ? (Array.isArray(rule.by) ? pick(rand, rule.by) : rule.by) : null;
    items.push({
      kind: isPost ? 'post' : 'comment',
      at: when,
      raw,
      finalScore: removed ? Math.min(finalScore, 1) : finalScore,
      removeAt: removed ? when + (1 + rand() * 18) * HOUR : Infinity,
      removedBy,
      // Reddit hides site-wide removals from the public profile listing.
      unlisted: removedBy === 'reddit' || removedBy === 'anti_evil_ops',
    });
  }
  return items.sort((a, b) => b.at - a.at);
}

function viewAt(item, t) {
  const age = t - item.at;
  const raw = { ...item.raw, score: Math.round(item.finalScore * Math.min(1, Math.max(0.2, age / (36 * HOUR)))) };
  if (t >= item.removeAt) {
    if (item.kind === 'post') {
      raw.removed_by_category = item.removedBy;
      if (raw.is_self) raw.selftext = '[removed]';
    } else {
      raw.body = '[removed]';
    }
  }
  return raw;
}

/**
 * now:   the anchor all persona timelines are relative to (server start).
 * clock: () => current simulated time in ms.
 */
export function createDemoReddit({ now, clock }) {
  const personas = new Map();
  const byId = new Map();
  let latency = null;

  function persona(username) {
    const key = username.toLowerCase();
    if (!personas.has(key)) {
      const spec = PERSONAS.find((p) => p.username.toLowerCase() === key) ?? synthesize(username);
      const items = generateItems(spec, now);
      for (const item of items) byId.set(item.raw.name, item);
      personas.set(key, { ...spec, items });
    }
    return personas.get(key);
  }

  async function delay() {
    if (latency) await sleep(latency[0] + Math.random() * (latency[1] - latency[0]));
  }

  function karmaAt(p, t) {
    const born = now - p.ageDays * DAY;
    const share = (t - born) / (now - born);
    const grow = (final) => Math.max(1, Math.round(1 + (final - 1) * share));
    const dropDays = p.commentDrop ? Math.max(0, Math.min(p.commentDrop.fromDays, p.commentDrop.fromDays - (now - t) / DAY)) : 0;
    return {
      linkKarma: grow(p.karma.link),
      commentKarma: grow(p.karma.comment) - Math.round(dropDays * (p.commentDrop?.perDay ?? 0)),
    };
  }

  async function getUserAbout(username) {
    await delay();
    const t = clock();
    const p = persona(username);
    if (p.neverVisible) return { state: 'not_found' };
    const born = now - p.ageDays * DAY;
    if (t < born) return { state: 'not_found' };
    if (p.hidden && t >= now - p.hidden.fromDays * DAY) return { state: p.hidden.state };
    return {
      state: 'active',
      profile: {
        name: p.username,
        ...karmaAt(p, t),
        createdAt: born,
        hasVerifiedEmail: p.verified ?? null,
      },
    };
  }

  async function getUserListing(username, which) {
    await delay();
    const t = clock();
    const kind = which === 'submitted' ? 'post' : 'comment';
    return persona(username)
      .items.filter((item) => item.kind === kind && item.at <= t && !(item.unlisted && t >= item.removeAt))
      .slice(0, 100)
      .map((item) => viewAt(item, t));
  }

  async function getInfo(fullnames) {
    await delay();
    const t = clock();
    return fullnames
      .map((id) => byId.get(id))
      .filter((item) => item && item.at <= t)
      .map((item) => viewAt(item, t));
  }

  return {
    getUserAbout,
    getUserListing,
    getInfo,
    verify: async () => {},
    // [min, max] ms of simulated network time per request, or null.
    setLatency: (range) => {
      latency = range;
    },
  };
}

export const DEMO_PERSONAS = PERSONAS;
