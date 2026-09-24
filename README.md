# Forja

A daily accountability app for building a workout habit without the friction
of the gym. Log a quick set of bodyweight exercises — push-ups, sit-ups,
squats — each day to keep your streak alive.

**Live app:** https://bejewelled-custard-f5b73c.netlify.app/

## Features

- Try the full app as a guest before creating an account — signup is offered
  after your first completed day, not required upfront
- Daily streak tracking with a "best streak" personal record
- Customizable daily minimums per exercise
- 2 forgiven rest days per rolling week, so one busy day doesn't reset months of progress
- 8-week history heatmap
- Real accounts backed by Supabase (Postgres + auth), so progress syncs
  across devices instead of living only in one browser
- Installable as a home-screen app on iOS/Android (PWA), works offline
- Rotating daily motivational message

## Tech stack

Plain HTML, CSS, and JavaScript — no frameworks, no build step. Guest
progress is stored locally in the browser (`localStorage`); once you sign
up, it's stored in Supabase (Postgres) with Row Level Security, so each
user can only ever read or write their own data.

## Running locally

This is a static site, so any local web server works. For example, with
Python installed:

```
py -3 -m http.server 8000
```

Then open `http://localhost:8000/` in your browser. Note: the service
worker (offline support) only activates when served over `http://localhost`
or `https://` — opening `index.html` directly as a file will skip it.

## License

All rights reserved. This code is publicly viewable but not licensed for
reuse, modification, or redistribution.
