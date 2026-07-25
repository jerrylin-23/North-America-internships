// Shared headless-browser transport for providers that cannot be reached with
// plain HTTP. Files prefixed with _ are never loaded as providers.
//
// Meta and Tesla both reject Node's fetch — Meta fingerprints the TLS client
// (400 on every route), Tesla runs Akamai Bot Manager (403 until its JS sensor
// challenge is solved). Both render normally in a real browser, so those two
// providers drive Chromium instead.
//
// One browser is launched lazily and shared across providers; crawl.js calls
// closeBrowser() once scanning finishes so the process can exit.

import { chromium } from 'playwright';

const NAV_TIMEOUT_MS = 45_000;

// A stock headless Chromium advertises HeadlessChrome and navigator.webdriver,
// both of which bot managers key on. These bring it in line with a normal
// desktop Chrome.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let browserPromise = null;

function launch() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });
  }
  return browserPromise;
}

/**
 * Run `fn(page)` against a fresh page in an isolated context.
 * `prepare` runs before navigation, for providers that need to attach
 * listeners (e.g. capturing XHR responses) that would otherwise miss the
 * requests the initial load fires.
 * The context is always torn down, even if `fn` throws.
 */
export async function withPage(url, fn, { prepare } = {}) {
  const browser = await launch();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });
  // navigator.webdriver is true in automated Chromium and is one of the
  // cheapest automation tells to check for.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  try {
    if (prepare) await prepare(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    return await fn(page);
  } finally {
    await context.close().catch(() => {});
  }
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  if (browser) await browser.close().catch(() => {});
}
