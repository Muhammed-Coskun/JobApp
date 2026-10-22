# Technical notes

[Back to the README](../README.md)

## How it works

A Manifest V3 extension without a build step: plain HTML, CSS and ES modules. All data lives in `chrome.storage.local`.

- **Side panel**: a click on the toolbar icon grants temporary access to the page (`activeTab`) and injects `lib/extractor.js`, which reads the ad. The panel follows the active tab and keeps a draft per ad.
- **Board and statistics**: `board.html` in its own tab. The Sankey layout and the charts are drawn by hand (`stats.js`), no chart library.
- **Job search**: `lib/search.js` asks the portals, merges the same job from different portals into one row, keeps every hit in the regions of its own country and computes distances. The service worker runs it on a `chrome.alarms` schedule and sets the badge.
- **Web pages** (LinkedIn result lists, job pages, a site's start page for its icon) are fetched by the service worker (`lib/net.js`). Chrome follows `Link: rel=preload` headers of a `fetch()` response inside a page, which would try to load a site's scripts into the board.

## Supported sites

| Site | Where the data comes from |
| --- | --- |
| LinkedIn (search with detail pane, job view, logged in or not) | The job data LinkedIn's own page loads for that job (when you are logged in), the public job view, then the detail pane on screen |
| jobs.ch, jobup.ch | The portal's own job data for the selected job, including the search page's detail pane |
| Indeed (all country domains) | The detail pane of the selected job |
| StepStone, Workday, Greenhouse, Lever | Their structured page markup |
| Any other career page | schema.org `JobPosting` data if the page has exactly one matching posting, otherwise a readability-style main content detection |

Job portals change their pages from time to time. All rules live in [`extension/lib/extractor.js`](../extension/lib/extractor.js), and every site has a test in [`tests/extractor.test.mjs`](../tests/extractor.test.mjs). If a site stops working, a PR with a fixed selector and an updated fixture is very welcome.

## Job search sources

| Portal | Interface | Notes |
| --- | --- | --- |
| Bundesagentur für Arbeit | Public job search API (`rest.arbeitsagentur.de`) | German regions; searches by place and radius itself |
| jobs.ch | The site's public search API | Swiss regions; no radius filter, so its regions narrow the search and the coordinates of each posting give the distance |
| LinkedIn | The logged-out job search (`jobs-guest`), without your cookies | Searched per region with LinkedIn's own id of the place when known, so a town name cannot land in the wrong country |

Failed requests are tried again after a short pause. When a portal still does not answer, its last results stay and the source line says so.

## Permissions

| Permission | Why |
| --- | --- |
| `sidePanel` | Shows the form next to the page |
| `activeTab`, `scripting` | Reads the page you are on, only after you click the icon |
| Host access to linkedin.com, jobs.ch, jobup.ch, indeed.com | Lets the panel read the next job when you click through a list, and request that job's data from the same site |
| Host access to media.licdn.com | Loads the company logo of a LinkedIn job you save |
| Host access to rest.arbeitsagentur.de, www.arbeitsagentur.de | Job search in Germany, and the description of a posting you save |
| `alarms` | Runs the job search in the background (can be switched off) |
| `declarativeNetRequestWithHostAccess` | One rule ([`rules.json`](../extension/rules.json)): requests to the jobs.ch search API get the Referer and Sec-Fetch-Site of the site's own requests. No other request is touched, nothing is blocked |
| `storage`, `unlimitedStorage` | Keeps your data in `chrome.storage.local` |

See [PRIVACY.md](../PRIVACY.md) for what is sent where.

## Development

```sh
npm install            # Playwright, only needed for the tests
npx playwright install chromium
npm test               # unit tests + end-to-end tests in a real Chromium
```

```
extension/
  manifest.json
  background.js         toolbar click, background job search, badge, page fetches for the board
  sidepanel.html/.js    the form, drafts, follows the active tab
  board.html/.js        board, job dialog, backup, keyboard moves
  stats.js              Sankey layout, charts, PNG export
  jobsearch.js          job search tab and its settings
  quicklinks.js         quick link tiles and their dialog
  rules.json            request header rule for the jobs.ch API
  lib/search.js         portals, merging, regions, distances (also runs in the service worker)
  lib/net.js            requests; web pages through the service worker
  lib/quicklinks.js     stored quick links, site icons
  lib/extractor.js      reads the job from the page (injected on click)
  lib/store.js          storage, migration, history, backup, CSV
  lib/tableimport.js    reads .xlsx (no library) and CSV, guesses columns and statuses
  lib/logo.js           turns a logo into a small stored picture
  lib/form.js           form helpers shared by the side panel and the board
  lib/i18n.js           translated texts in pages
  _locales/             English and German
tests/
  extractor.test.mjs    each portal, served from fixtures under its real URL
  extension.test.mjs    loads the extension and drives panel, board and job search
  search.test.mjs       portal answers, title matching, merging, distances, regions
  quicklinks.test.mjs   links, icons, reordering, backup
  fixtures/             trimmed copies of real page structures, made-up content
```

## Known limitations

- Firefox is not supported (no side panel API).
- On LinkedIn the richest data needs you to be logged in. Logged out, the public job view and the page itself are used.
- Ads inside a cross-origin iframe can only be filled in by hand or with "Insert selected text".
- The job search uses the portals' public interfaces, which can change.
- Indeed and StepStone are not part of the job search: they have no public interface an extension can use reliably. Add your searches there as quick links.
