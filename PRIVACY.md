# Privacy Policy: SubCentral Job Filter

_Last updated: November 15, 2026_

SubCentral Job Filter is a free Chrome extension that adds filters and commute times to the SubCentral Available Jobs page. It has no accounts, no ads, no analytics, and no server of its own.

## What it stores

Everything is saved in your own Chrome browser (`chrome.storage.local`) and never leaves your computer except as described below:

- The home address you type into **Commute settings**, and the map location found for it
- Your filter choices (school level, classification, borough, days, and checkboxes)
- Commute times and school locations it has already looked up, so it doesn't have to look them up again

Removing the extension deletes all of this.

## What it sends, and to whom

To show commute times, the extension makes these requests directly from your browser:

- **[Transitous](https://transitous.org/)** (a free, volunteer-run trip planner) receives your home address once, to find it on the map. After that, it receives your home location and each school's location to work out bike and transit times.
- **[Photon](https://photon.komoot.io/)** (a free map search run by Komoot) receives the school names shown on your Available Jobs page, to find each school on the map.

Like any website, these services can see your computer's IP address when your browser contacts them. Please see their own privacy policies.

Nothing else is sent anywhere: not your name, your SubCentral login, or the job details. The maker of this extension never receives any of your data.

## What it reads

The extension only runs on the SubCentral Available Jobs pages (`https://subcentral.sfe.powerschool.com/substituteAvailableJob*`). It reads the job list on that page in your browser to filter and sort it. If SubCentral opens its mobile version (on a narrow window), the extension switches to the full site, which passes briefly through the SubCentral Home page (`homeAction.do`). Nothing is read there.

## Contact

Questions? Open an issue at https://github.com/zevezev/Subcentral-Filters-Chrome-Extension/issues
