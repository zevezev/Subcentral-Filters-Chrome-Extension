# Chrome Web Store submission sheet

Copy and paste these into the [developer dashboard](https://chrome.google.com/webstore/devconsole).

Upload: `dist/subcentral-job-filter-<version>.zip` (build it with `sh dev/build-zip.sh`).

---

## Store listing tab

**Description**

```
Makes the SubCentral (SmartFind Express) Available Jobs page easier to use for NYC substitute teachers.

• Filter jobs by school level, classification, borough, and the days you can work
• Sort by any column
• See how long it takes to get to each school by bike and by public transit from your home
• "This week" and "Next week" buttons for quick date searches
• Get a notification when a job search finishes, so you can switch tabs while you wait

Commute times come from Transitous, a free, volunteer-run trip planner. Schools are found with Photon. Map data © OpenStreetMap contributors.

Your address and settings stay in your own browser. There's no account, and nothing is sent to the maker of this extension.

Not made by, or connected to, PowerSchool or the NYC Department of Education.
```

**Category:** Tools (under Productivity)

**Language:** English

**Store icon:** `icon128.png`

**Screenshot:** `store/screenshot-1280x800.png`

**Small promo tile:** `store/promo-440x280.png`

**Homepage URL:** https://github.com/zevezev/Subcentral-Filters-Chrome-Extension

**Support URL:** https://github.com/zevezev/Subcentral-Filters-Chrome-Extension/issues

---

## Privacy practices tab

**Single purpose**

```
Adds filtering, sorting, and bike and transit commute times to the SubCentral Available Jobs page.
```

**Permission justifications**

storage:
```
Saves the user's home address, filter choices, and already-looked-up commute times and school locations in their own browser.
```

notifications:
```
Shows an optional notification when a SubCentral job search finishes, so the user can work in another tab while the slow search runs.
```

declarativeNetRequestWithHostAccess:
```
Sets an identifying User-Agent header on requests to api.transitous.org only. Transitous's usage policy requires apps to identify themselves; requests without it are refused. No other requests are read or changed.
```

Host permissions (photon.komoot.io, api.transitous.org):
```
photon.komoot.io finds each school on the map from the school name on the job list. api.transitous.org finds the user's home address and calculates bike and transit times to each school.
```

**Are you using remote code?** No, I am not using remote code.

**Data usage:** check these:

- [x] Personally identifiable information (the home address the user types in)
- [x] Location (the home address's map location, used for commute times)
- [x] Website content (school names from the job list, sent to Photon to find them on the map)

Then check all three certifications:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/zevezev/Subcentral-Filters-Chrome-Extension/blob/main/PRIVACY.md

---

## Distribution tab

**Visibility:** Unlisted

**Regions:** All regions (or just United States)
