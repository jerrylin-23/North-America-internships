// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Google provider — the careers site has no public JSON API, but the results
// page is server-rendered, so this parses the HTML.
//
//   https://www.google.com/about/careers/applications → GET
//   .../jobs/results?target_level=INTERN_AND_APPRENTICE&page=N
//
// Google's markup uses obfuscated Material class names, so parsing anchors on
// class is brittle. Two stable hooks are used instead:
//   - the job link href: `jobs/results/<id>-<slug>`
//   - its `aria-label="Learn more about <TITLE>"`, which carries the exact title
// Locations follow a `place` material icon within the same card, ahead of the
// link, as one or more `r0wTof` spans plus an optional "; +N more".

const BASE = 'https://www.google.com/about/careers/applications';
const RESULTS = `${BASE}/jobs/results`;
const MAX_PAGES = 25; // safety cap

// Google splits early career across two target levels; the crawler's filter
// accepts both interns and new grads, so fetch both.
const TARGET_LEVELS = ['INTERN_AND_APPRENTICE', 'EARLY'];

const LINK_RE = /href="(jobs\/results\/\d+-[^"]*)"[^>]*aria-label="Learn more about ([^"]+)"/g;
const PLACE_RE = /<i[^>]*>place<\/i>((?:<span[^>]*>[^<]*<\/span>)+)/g;
const SPAN_RE = /<span[^>]*class="[^"]*r0wTof[^"]*"[^>]*>([^<]*)<\/span>/g;

function decode(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Collect the byte offset of every location block so each job link can be
// matched to the nearest one preceding it in the same card.
function indexLocations(html) {
  const blocks = [];
  PLACE_RE.lastIndex = 0;
  for (let m; (m = PLACE_RE.exec(html)); ) {
    const parts = [];
    SPAN_RE.lastIndex = 0;
    for (let s; (s = SPAN_RE.exec(m[1])); ) {
      const value = decode(s[1]).replace(/^;\s*/, '');
      if (value) parts.push(value);
    }
    blocks.push({ index: m.index, location: parts.join('; ') });
  }
  return blocks;
}

function locationBefore(blocks, index) {
  let found = '';
  for (const b of blocks) {
    if (b.index > index) break;
    found = b.location;
  }
  return found;
}

function isGoogle(entry) {
  const url = entry.careers_url || '';
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') === 'google.com' && u.pathname.includes('/careers');
  } catch {
    return false;
  }
}

/** @type {Provider} */
export default {
  id: 'google',

  detect(entry) {
    return isGoogle(entry) ? { url: RESULTS } : null;
  },

  async fetch(entry, ctx) {
    if (!isGoogle(entry)) throw new Error(`google: not a Google careers entry for ${entry.name}`);

    const jobs = [];
    const seen = new Set();

    for (const level of TARGET_LEVELS) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const html = await ctx.fetchText(`${RESULTS}?target_level=${level}&page=${page}`, {
          headers: { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
        });

        const locations = indexLocations(html);
        let matched = 0;

        LINK_RE.lastIndex = 0;
        for (let m; (m = LINK_RE.exec(html)); ) {
          matched++;
          const [, href, rawTitle] = m;
          // Drop the target_level/page query the link inherits from the search
          // so the canonical posting URL stays stable across runs — history
          // dedupes on url.
          const url = new URL(decode(href).split('?')[0], `${BASE}/`).href;
          if (seen.has(url)) continue;
          seen.add(url);
          jobs.push({
            title: decode(rawTitle),
            url,
            company: entry.name,
            location: locationBefore(locations, m.index),
          });
        }

        // No links on this page means we walked past the last page.
        if (matched === 0) break;
      }
    }
    return jobs;
  },
};
