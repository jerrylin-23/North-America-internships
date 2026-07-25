// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Apple provider — jobs.apple.com has no public JSON API (the search page
// issues no XHR; results are server-rendered), so this parses the HTML.
//
//   https://jobs.apple.com → GET
//   https://jobs.apple.com/en-us/search?team=internships-STDNT-INTRN&page=N
//
// Apple's free-text keyword search is fuzzy and returns mostly non-student
// roles, so the student roles are reached through the team facet instead.
// Each result row is stable, well-classed markup:
//   <a class="link-inline …" href="/en-us/details/<id>/<slug>?team=…">TITLE</a>
//   <span class="job-posted-date">Jul 25, 2026</span>
//   <div class="… job-title-location"><span class="a11y">Location</span>…</div>
// The location cell holds either a plain span or a
// `table--advanced-search__location-sub` span depending on the role type, so
// the whole cell is read and its "Location" accessibility label stripped.

const ORIGIN = 'https://jobs.apple.com';
const SEARCH = `${ORIGIN}/en-us/search`;
const PAGE_SIZE = 20; // rows per results page
const MAX_PAGES = 25; // safety cap — at most 500 postings

// Apple's team facet for student roles. Overridable per-entry via `query`
// in companies.json if Apple adds further student team codes.
const DEFAULT_TEAM = 'internships-STDNT-INTRN';

const ROW_RE = /<a[^>]+class="link-inline[^"]*"[^>]+href="(\/en-us\/details\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const LOCATION_RE = /class="[^"]*job-title-location"[^>]*>([\s\S]*?)<\/div>/;
const POSTED_RE = /class="job-posted-date"[^>]*>([\s\S]*?)<\/span>/;

function decode(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isApple(entry) {
  try {
    return new URL(entry.careers_url || '').hostname.replace(/^www\./, '') === 'jobs.apple.com';
  } catch {
    return false;
  }
}

/** @type {Provider} */
export default {
  id: 'apple',

  detect(entry) {
    return isApple(entry) ? { url: SEARCH } : null;
  },

  async fetch(entry, ctx) {
    if (!isApple(entry)) throw new Error(`apple: not a jobs.apple.com entry for ${entry.name}`);

    const team = entry.query || DEFAULT_TEAM;
    const jobs = [];
    const seen = new Set();

    for (let page = 1; page <= MAX_PAGES; page++) {
      const html = await ctx.fetchText(`${SEARCH}?team=${encodeURIComponent(team)}&page=${page}`, {
        headers: { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
      });

      let rows = 0;
      ROW_RE.lastIndex = 0;
      for (let m; (m = ROW_RE.exec(html)); ) {
        rows++;
        const [, href, rawTitle] = m;
        const title = decode(rawTitle);
        // Each row renders the anchor twice ("TITLE" and "See full role
        // description"); keep the first, which carries the real title.
        // Drop the ?team= facet the link inherits from the search so the
        // canonical posting URL stays stable across runs — history dedupes on url.
        const url = new URL(href.replace(/&amp;/g, '&').split('?')[0], ORIGIN).href;
        if (!title || seen.has(url)) continue;
        seen.add(url);

        // Location and posted date live in the same row, after the anchor.
        const tail = html.slice(m.index, m.index + 2000);
        jobs.push({
          title,
          url,
          company: entry.name,
          // The cell leads with a visually-hidden "Location" label.
          location: decode(tail.match(LOCATION_RE)?.[1] || '').replace(/^Location\s*/i, ''),
          postedAt: toEpochMs(decode(tail.match(POSTED_RE)?.[1] || '')),
        });
      }

      // Two anchors per row, so a full page yields 2 * PAGE_SIZE matches.
      if (rows < PAGE_SIZE) break;
    }
    return jobs;
  },
};
