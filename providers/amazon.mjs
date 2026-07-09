// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Amazon provider — hits the public amazon.jobs search.json endpoint (GET,
// paginated by offset). Amazon runs a custom ATS, not one of the standard
// boards, so it needs a dedicated provider.
//
// Detects from a careers_url on the amazon.jobs host, e.g.
//   https://www.amazon.jobs → GET https://www.amazon.jobs/en/search.json
// base_query=intern narrows server-side to intern/co-op postings; the country
// facet keeps the payload to North America (downstream filters do the rest).

const API = 'https://www.amazon.jobs/en/search.json';
const PAGE_SIZE = 100; // amazon.jobs caps result_limit at 100
const MAX_PAGES = 20;  // safety cap — at most 2000 postings

function isAmazon(entry) {
  const url = entry.careers_url || '';
  try {
    return new URL(url).hostname.replace(/^www\./, '') === 'amazon.jobs';
  } catch {
    return false;
  }
}

// amazon.jobs exposes posted_date as a human label ("September 15, 2025"),
// which Date.parse handles; guard against NaN and coerce to epoch ms.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** @type {Provider} */
export default {
  id: 'amazon',

  detect(entry) {
    return isAmazon(entry) ? { url: API } : null;
  },

  async fetch(entry, ctx) {
    if (!isAmazon(entry)) throw new Error(`amazon: not an amazon.jobs entry for ${entry.name}`);

    const jobs = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        base_query: 'intern',
        result_limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
        sort: 'recent',
      });
      // North America only — repeated country facet keys.
      params.append('country[]', 'USA');
      params.append('country[]', 'CAN');

      const json = /** @type {any} */ (await ctx.fetchJson(`${API}?${params}`, {
        headers: { accept: 'application/json' },
      }));
      const postings = Array.isArray(json?.jobs) ? json.jobs : [];
      for (const j of postings) {
        if (!j.job_path) continue;
        jobs.push({
          title: j.title || '',
          url: `https://www.amazon.jobs${j.job_path}`,
          company: entry.name,
          location: j.normalized_location || j.city || '',
          postedAt: toEpochMs(j.posted_date),
        });
      }
      if (postings.length < PAGE_SIZE) break;
    }
    return jobs;
  },
};
