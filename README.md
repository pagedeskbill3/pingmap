# Ping Monitor

Pings pagedesk.com, pagedesk.info, melrosepark.org, union81.com and
beaverrubspicecompany.com every 5 seconds from Cloudflare data centers in the
US and shows round-trip time, jitter and packet loss on a live map and graphs.

A "ping" here is an HTTP HEAD request timed to the first response. Cloudflare
Workers cannot send ICMP, so this includes the site's own time to answer, not
just network latency. A reply slower than 3 seconds counts as lost.

## Two layers of checks

1. **Live pings from Cloudflare locations** (circles on the map): every 5 seconds,
   from Durable Objects pinned to the western and eastern North America regions.
2. **Wide-area pings by city** (diamonds on the map): every 15 minutes, real ICMP
   pings from probes in New York, Chicago, Dallas, Los Angeles, Seattle, Atlanta,
   Denver and Miami, run through Globalping (https://globalping.io, free API).
   Globalping picks the probe in each city, so the network can change between rounds.

## Deploy (about 2 minutes)

    npm install -D wrangler
    npx wrangler login
    npx wrangler deploy

Optional but recommended: create a free Globalping account, make an API token, and add it
so your quota is yours alone (anonymous quota is shared per IP address):

    npx wrangler secret put GLOBALPING_TOKEN

Wrangler prints your URL (https://site-monitor.<your-subdomain>.workers.dev).
Open it. The first locations appear within about 15 seconds.

## Change what is monitored

Edit `SITES` and `PROBES` at the top of `src/index.js`, then redeploy.
- `INTERVAL_MS` sets the ping rate. 5 seconds is about 70,000 Durable Object
  requests/day for the four probes, plus dashboard polling (a dashboard left open
  all day adds about 69,000/day, since each 5-second poll reaches all four probes).
  That can exceed Cloudflare's free tier, so raise `INTERVAL_MS` or use the
  $5 Workers plan if you leave it open.
- Add more `PROBES` entries (any unique id, hint "wnam" or "enam") to try for
  more distinct locations.
- If a site's firewall blocks the checker, allow the user agent
  `SiteMonitor/1.0`.

## Wide-area settings (top of src/index.js)
- `WIDE_CITIES`: cities to ping from. If Globalping has no probe in one, that site's
  round shows an error in the dashboard (for example HTTP 422); swap the city.
- `WIDE_INTERVAL_MS`: default 15 minutes. Each round uses sites x cities tests
  (5 x 8 = 40). Globalping's limits are 250 free tests/hour anonymous and 500 with a
  token, so 15 minutes uses 160/hour. Check Globalping's current limits before
  shortening the interval.
- If you already deployed an earlier version, just run `npx wrangler deploy` again;
  the new Durable Object is added by a migration.

## Notes
- Locations are the Cloudflare data centers each probe actually ran in. Hints are
  regional and best effort, so two probes can end up in the same city.
- The Live / Demo switch in the header is remembered per browser. On first load the
  dashboard tries Live and falls back to Demo if there is no backend at /api/state.
  Choosing Live with no backend shows a "Backend not reachable" message instead.
