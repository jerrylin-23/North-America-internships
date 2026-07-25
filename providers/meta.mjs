// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Meta provider — metacareers.com fingerprints the TLS client and returns 400
// to Node's fetch on every route, including plain /jobs, so this drives
// Chromium (see _browser.mjs).
//
// The rendered list is a virtualised Relay surface with obfuscated class names
// and no usable pagination control (it renders 10 of 13 cards and the body has
// no scroll height). Rather than fight that DOM, this captures the page's own
// GraphQL responses, which carry the complete, already-structured result set:
//
//   data.job_search_with_featured_jobs_v2.all_jobs[]
//     { id, title, locations[], teams[], sub_teams[] }
//
// Meta's role facet only offers "Full time employment", "Internship" and
// "Short term employment" — there is no new-grad value — so only Internship is
// requested. Overridable per-entry with `query`.

const ORIGIN = 'https://www.metacareers.com';
const DEFAULT_ROLE = 'Internship';

// Time allowed after load for the search GraphQL round-trip to land.
const SETTLE_MS = 9_000;

function isMeta(entry) {
  try {
    return new URL(entry.careers_url || '').hostname.replace(/^www\./, '') === 'metacareers.com';
  } catch {
    return false;
  }
}

// Meta streams GraphQL responses as newline-delimited JSON objects.
function parsePayloads(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Partial or non-JSON chunk — ignore.
    }
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'meta',

  detect(entry) {
    return isMeta(entry) ? { url: `${ORIGIN}/jobs` } : null;
  },

  async fetch(entry) {
    if (!isMeta(entry)) throw new Error(`meta: not a metacareers.com entry for ${entry.name}`);

    // Imported lazily so the Playwright dependency is only paid for when a
    // browser-backed company is actually enabled.
    const { withPage } = await import('./_browser.mjs');

    const role = entry.query || DEFAULT_ROLE;
    const url = `${ORIGIN}/jobs?roles[0]=${encodeURIComponent(role)}`;
    const captured = [];

    await withPage(url, page => page.waitForTimeout(SETTLE_MS), {
      prepare: page => {
        page.on('response', async response => {
          if (!response.url().includes('/graphql')) return;
          try {
            captured.push(...parsePayloads(await response.text()));
          } catch {
            // Response body already discarded — nothing to recover.
          }
        });
      },
    });

    const jobs = [];
    const seen = new Set();
    for (const payload of captured) {
      const all = payload?.data?.job_search_with_featured_jobs_v2?.all_jobs;
      if (!Array.isArray(all)) continue;
      for (const j of all) {
        if (!j?.id || seen.has(j.id)) continue;
        seen.add(j.id);
        jobs.push({
          title: (j.title || '').replace(/\s+/g, ' ').trim(),
          url: `${ORIGIN}/jobs/${j.id}/`,
          company: entry.name,
          location: Array.isArray(j.locations) ? j.locations.join('; ') : '',
        });
      }
    }

    if (!jobs.length) throw new Error('meta: no job payload captured (page shape may have changed)');
    return jobs;
  },
};
