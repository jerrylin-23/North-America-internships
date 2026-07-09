// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Eightfold provider — hits the public Eightfold Talent Intelligence careers
// API (GET, paginated by start). Used by companies on Eightfold, e.g. Netflix
// at https://explore.jobs.netflix.net.
//
// Detects from a careers_url on an `explore.jobs.<host>` domain:
//   https://explore.jobs.netflix.net → GET
//   https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=<domain>&query=intern
//
// The `domain` query param is required by the API and identifies the tenant;
// it's read from the entry's `domain` field (opaque to the framework).

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

function resolveEndpoint(entry) {
  const url = entry.careers_url || '';
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!/^explore\.jobs\./.test(host)) return null;
  return {
    api: `https://${host}/api/apply/v2/jobs`,
    // The tenant domain the API scopes results to (e.g. "netflix.com").
    domain: entry.domain || host.replace(/^explore\.jobs\./, ''),
  };
}

/** @type {Provider} */
export default {
  id: 'eightfold',

  detect(entry) {
    return resolveEndpoint(entry) ? { url: entry.careers_url } : null;
  },

  async fetch(entry, ctx) {
    const ep = resolveEndpoint(entry);
    if (!ep) throw new Error(`eightfold: cannot derive endpoint for ${entry.name}`);

    const jobs = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        domain: ep.domain,
        query: 'intern',
        num: String(PAGE_SIZE),
        start: String(page * PAGE_SIZE),
      });
      const json = /** @type {any} */ (await ctx.fetchJson(`${ep.api}?${params}`, {
        headers: { accept: 'application/json' },
      }));
      const positions = Array.isArray(json?.positions) ? json.positions : [];
      for (const p of positions) {
        if (!p.canonicalPositionUrl) continue;
        jobs.push({
          title: p.name || '',
          url: p.canonicalPositionUrl,
          company: entry.name,
          // Eightfold uses comma-joined "City,Region,Country" with no spaces.
          location: (p.location || '').replace(/,/g, ', '),
          // t_create is epoch *seconds*.
          postedAt: p.t_create ? p.t_create * 1000 : undefined,
        });
      }
      if (positions.length < PAGE_SIZE) break;
    }
    return jobs;
  },
};
