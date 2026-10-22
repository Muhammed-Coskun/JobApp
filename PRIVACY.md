# Privacy

Job Application Tracker keeps all data on your computer.

## What is stored

The jobs you save (company, position, location, workload, work model, dates, link, description, contact details you enter, notes, interview rounds, status history and a small copy of the company logo), your columns, unsaved drafts from the side panel and a few settings. For the job search: your search settings (regions, search terms, sources), your quick links (name, address and a small image of each), the postings the portals returned (jobs of the last 7 days), which of them you have already seen or hidden, and when you last looked. All of it is in `chrome.storage.local` of your browser profile. Drafts older than 14 days and search marks older than 45 days are removed automatically.

## What is sent where

Nothing is sent to the developer or to any third party. There is no server, no account, no analytics and no remote code.

When you open the side panel on a supported job site, the extension reads the job on screen. To get the complete posting it may ask **the same site** for that one job:

- LinkedIn: the job data the LinkedIn page itself loads, using your existing LinkedIn session, and the public job view.
- jobs.ch and jobup.ch: the public job data of the selected job.

- The company logo: the image the job page already shows (on LinkedIn it comes from media.licdn.com, LinkedIn's image server; on a company's career site its icon). It is loaded once, shrunk to 64 pixels and stored inside the job. If that is not possible, the logo is cut out of a screenshot of the visible tab, which Chrome allows only after you clicked the extension icon on that tab. The screenshot is not stored.

These requests go only to the site you are viewing (and its image server), only for the job you are looking at, and only while the side panel is open.

### Job search

The **Job search** tab asks three job portals for new postings. Each request contains a search term from your settings, the place and radius of a region and the time window, nothing else:

- jobs.ch: its public search (`www.jobs.ch/api/v1/public/search`), for your Swiss regions. These requests carry the cookies jobs.ch has already set in your browser and, through one declarativeNetRequest rule, the Referer and Sec-Fetch-Site of jobs.ch's own pages; jobs.ch gave the extension an empty list otherwise.
- Bundesagentur für Arbeit: its public job search API (`rest.arbeitsagentur.de`), for your German regions.
- LinkedIn: the public job search that works without logging in (`www.linkedin.com/jobs-guest/...`). It is sent **without your LinkedIn cookies**, so it is not linked to your account. When you add a region of your own, the place name is also sent to LinkedIn's place suggestions once, to get LinkedIn's id for that place.

This happens when you open the tab, when you click **Refresh**, and, if you leave automatic search on, every few hours in the background while Chrome is running. You can switch off each portal and the automatic search in the search settings.

**Quick links** are plain links: a click opens the site in a new tab, like a bookmark. To show a tile's picture, the extension loads the icon of that site once from the site itself (its start page to find the icon, then the icon), and only when you did not choose an image of your own. If the icon comes from a site the extension has access to (jobs.ch, linkedin.com, arbeitsagentur.de), it is stored as a small image; otherwise its address is stored and the picture is loaded from there when the tab is shown, without a referrer.

When you click **Save** on a posting, the extension asks the same portal for that one posting's description (jobs.ch job data, the LinkedIn public job view, or the job page on arbeitsagentur.de) and loads its logo once. The list itself shows the portals' logos directly from their image servers (media.jobs.ch, media.licdn.com), without a referrer. The board and the statistics never load anything from the internet.

## Your control

- Export everything as JSON or CSV from the board menu.
- Files you import (JSON backup, Excel, CSV) are read inside the browser and never uploaded.
- Delete everything with **Delete all data** in the board menu.
- Uninstalling the extension removes all of its data.

## Contact

Open an issue in the repository.
