// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Microsoft provider — Microsoft migrated its careers site to Eightfold's
// "PCSX" platform (apply.careers.microsoft.com). That is the same vendor as
// eightfold.mjs, but a different API surface: `/api/pcsx/search` returns the
// positions under `data.positions` rather than at the top level, so it needs
// its own reader.
//
//   https://apply.careers.microsoft.com → GET
//   https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com&query=intern
//
// The endpoint caps `num` at 10 regardless of what is requested, so paging
// walks `start` in steps of 10.

const PAGE_SIZE = 10; // server-enforced cap
const MAX_PAGES = 40; // safety cap — at most 400 postings per query

// Server-side narrowing. The crawler's own filter accepts new-grad titles too,
// so fetch both rather than only "intern"; results are deduped by URL.
const QUERIES = ['intern', 'graduate'];

function resolveEndpoint(entry) {
  const url = entry.careers_url || '';
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (host !== 'apply.careers.microsoft.com') return null;
  return {
    api: `https://${host}/api/pcsx/search`,
    origin: `https://${host}`,
    domain: entry.domain || 'microsoft.com',
  };
}

/** @type {Provider} */
export default {
  id: 'microsoft',

  detect(entry) {
    const ep = resolveEndpoint(entry);
    return ep ? { url: ep.api } : null;
  },

  async fetch(entry, ctx) {
    const ep = resolveEndpoint(entry);
    if (!ep) throw new Error(`microsoft: cannot derive endpoint for ${entry.name}`);

    const jobs = [];
    const seen = new Set();

    for (const query of QUERIES) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({
          domain: ep.domain,
          query,
          location: '',
          start: String(page * PAGE_SIZE),
          num: String(PAGE_SIZE),
        });
        const json = /** @type {any} */ (await ctx.fetchJson(`${ep.api}?${params}`, {
          headers: { accept: 'application/json' },
        }));

        const positions = Array.isArray(json?.data?.positions) ? json.data.positions : [];
        for (const p of positions) {
          if (!p.positionUrl) continue;
          const url = new URL(p.positionUrl, ep.origin).href;
          if (seen.has(url)) continue;
          seen.add(url);
          jobs.push({
            title: p.name || '',
            url,
            company: entry.name,
            // locations is an array of "Country, State, City" strings.
            location: Array.isArray(p.locations) ? p.locations.join('; ') : '',
            // postedTs is epoch *seconds*.
            postedAt: p.postedTs ? p.postedTs * 1000 : undefined,
          });
        }
        if (positions.length < PAGE_SIZE) break;
      }
    }
    return jobs;
  },
};
