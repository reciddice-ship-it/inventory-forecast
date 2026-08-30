/**
 * Bumped whenever the API gains a field the UI relies on.
 *
 * The static UI redeploys from GitHub Pages automatically on push, but the
 * Worker only updates when someone runs `npm run deploy`. The two therefore
 * drift, and a page asking an older Worker for a field it does not return just
 * renders nothing — which looks identical to "the tool is broken". The UI
 * compares this number against the minimum it needs and says so plainly.
 *
 * 1  initial release
 * 2  forecast diagnostics (`diagnostics`, per-item `issues` and `coverage`)
 * 3  product attributes imported from sales files (`product_fields_found`)
 */
export const API_VERSION = 3;
