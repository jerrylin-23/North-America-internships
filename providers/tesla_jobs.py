#!/usr/bin/env python3
"""Tesla careers fetcher, invoked by providers/local-parser.mjs.

www.tesla.com sits behind Akamai Bot Manager, which rejects clients whose TLS
fingerprint does not match a real browser -- it 403s Node's fetch, curl, and
Playwright-driven Chrome alike (it even 403s /robots.txt). curl_cffi presents
Chrome's actual TLS/HTTP2 fingerprint, which the edge accepts.

Tesla's robots.txt does not disallow /careers/ or /cua-api/; it asks for
Crawl-delay: 10, which this honours. Hitting the API faster earns HTTP 429.

The whole board comes back in one response -- no pagination:
    listings[]         {id, t: title, l: locationId, y: typeId}
    lookup.locations   {"28367": "Atlanta, Georgia"}
    lookup.types       {"3": "intern"}

Roles are selected on Tesla's own type classification rather than a title
regex, so postings whose titles omit "intern" are still caught.

Emits a JSON array of {title, url, location} on stdout.
"""

import json
import sys
import time

from curl_cffi import requests

ORIGIN = "https://www.tesla.com"
SEARCH_URL = f"{ORIGIN}/careers/search/"
STATE_URL = f"{ORIGIN}/cua-api/apps/careers/state"

CRAWL_DELAY_S = 12  # robots.txt asks for 10
TIMEOUT_S = 45

# Requesting the API too often earns HTTP 429. Back off rather than retry hard.
MAX_ATTEMPTS = 3
BACKOFF_S = 45


def fetch_state():
    session = requests.Session(impersonate="chrome")
    # The careers page issues the Akamai sensor handshake and sets _abck;
    # requesting the API cold is rejected.
    session.get(SEARCH_URL, timeout=TIMEOUT_S)
    time.sleep(CRAWL_DELAY_S)

    last = None
    for attempt in range(MAX_ATTEMPTS):
        response = session.get(
            STATE_URL,
            headers={"accept": "application/json", "referer": SEARCH_URL},
            timeout=TIMEOUT_S,
        )
        if response.status_code == 200:
            return response.json()

        last = response.status_code
        if response.status_code != 429 or attempt == MAX_ATTEMPTS - 1:
            break
        # Honour Retry-After when Tesla sends one.
        try:
            wait = int(response.headers.get("retry-after", ""))
        except ValueError:
            wait = BACKOFF_S * (attempt + 1)
        time.sleep(min(wait, 180))

    raise RuntimeError(f"tesla state returned HTTP {last}")


def to_jobs(state):
    lookup = state.get("lookup") or {}
    locations = lookup.get("locations") or {}
    types = lookup.get("types") or {}

    jobs = []
    for listing in state.get("listings") or []:
        job_id = listing.get("id")
        if not job_id:
            continue
        if str(types.get(str(listing.get("y")), "")).lower() != "intern":
            continue
        jobs.append(
            {
                "title": listing.get("t") or "",
                "url": f"{ORIGIN}/careers/search/job/{job_id}",
                "location": locations.get(str(listing.get("l")), ""),
            }
        )
    return jobs


def main():
    try:
        jobs = to_jobs(fetch_state())
    except Exception as exc:  # surfaced by local-parser as a scan failure
        print(f"tesla_jobs: {exc}", file=sys.stderr)
        return 1
    json.dump(jobs, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
