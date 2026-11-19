import { DurableObject } from "cloudflare:workers";

/* ============================== CONFIG ============================== */
const SITES = [
  "pagedesk.com",
  "pagedesk.info",
  "melrosepark.org",
  "union81.com",
  "beaverrubspicecompany.com",
];

// Each probe is a Durable Object pinned (best effort) to a Cloudflare region.
// Valid US-relevant hints: "wnam" (Western North America), "enam" (Eastern North America).
// Hints are regional, not city-level: the dashboard shows the data center each probe
// actually landed in (the `colo` code), which may differ from what you'd expect.
// Add more entries to try for more distinct locations; instances sharing a hint can
// land in the same data center.
const PROBES = [
  { id: "wnam-1", hint: "wnam" },
  { id: "wnam-2", hint: "wnam" },
  { id: "enam-1", hint: "enam" },
  { id: "enam-2", hint: "enam" },
];

const INTERVAL_MS = 5_000;    // one ping per site from every probe, every 5 seconds
const KEEP = 720;             // samples kept per probe (720 x 5s = 1 hour)
const TIMEOUT_MS = 3_000;     // no reply within this = ping lost

// Wide-area pings: real ICMP pings from many US cities via Globalping (https://globalping.io),
// a free public API. Globalping chooses the probe in each city (volunteer-hosted, any network).
// Each round costs SITES x cities "tests" against Globalping's hourly quota
// (250/hour anonymous, 500 with a free token). 5 sites x 8 cities = 40 tests per round,
// so every 15 minutes = 160 tests/hour. Set a token with:  npx wrangler secret put GLOBALPING_TOKEN
const WIDE_CITIES = ["New York", "Chicago", "Dallas", "Los Angeles", "Seattle", "Atlanta", "Denver", "Miami"];
const WIDE_INTERVAL_MS = 15 * 60_000;
const WIDE_KEEP = 24;          // rounds kept (24 x 15 min = 6 hours)
const WIDE_PACKETS = 3;
const GP = "https://api.globalping.io/v1";

/* ============================== PROBER ============================== */
export class Prober extends DurableObject {
  // Called by the Worker on every dashboard poll and every cron tick.
  // Makes sure the alarm loop is running, then returns state.
  async ensure(meta, since = 0) {
    if (meta) await this.ctx.storage.put("meta", meta);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
    const [m, colo, hist] = await Promise.all([
      this.ctx.storage.get("meta"),
      this.ctx.storage.get("colo"),
      this.ctx.storage.get("hist"),
    ]);
    return {
      id: m?.id,
      hint: m?.hint,
      colo: colo ?? null,
      hist: (hist ?? []).filter((s) => s.t > since),
    };
  }

  async alarm() {
    try {
      await this.runChecks();
    } catch (e) {
      console.log("probe round failed", String(e));
    } finally {
      // Always re-arm, even if a round failed.
      await this.ctx.storage.setAlarm(Date.now() + INTERVAL_MS);
    }
  }

  async runChecks() {
    const t = Date.now();
    // Learn which Cloudflare data center we're running in (refresh occasionally).
    const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    if (n === 1 || n % 240 === 0 || !(await this.ctx.storage.get("colo"))) {
      const colo = await this.detectColo();
      if (colo) await this.ctx.storage.put("colo", colo);
    }

    const results = await Promise.all(SITES.map((h) => this.ping(h)));
    const r = {};
    SITES.forEach((h, i) => (r[h] = results[i]));

    const hist = (await this.ctx.storage.get("hist")) ?? [];
    hist.push({ t, r });
    while (hist.length > KEEP) hist.shift();
    await this.ctx.storage.put("hist", hist);
  }

  async detectColo() {
    try {
      const res = await fetch("https://www.cloudflare.com/cdn-cgi/trace");
      const txt = await res.text();
      return /^colo=(\w+)/m.exec(txt)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  // One "ping": an HTTP HEAD request. Workers cannot send ICMP, so this measures the HTTP
  // round trip (network + the site's time to answer). Redirects are not followed, so a
  // 301 from the apex counts as a reply. Returns [rttMs, httpStatus]; status 0 = lost.
  async ping(host) {
    let r = await this.once(host, "HEAD");
    if (r[1] === 405 || r[1] === 501) r = await this.once(host, "GET"); // HEAD not supported
    return r;
  }

  async once(host, method) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`https://${host}/`, {
        method,
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": "SiteMonitor/1.0 (self-hosted ping check)", "cache-control": "no-cache" },
      });
      const ms = Date.now() - t0; // time until response headers
      res.body?.cancel();
      return [ms, res.status];
    } catch {
      return [Date.now() - t0, 0];
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ============================ WIDE AREA ============================ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class WideArea extends DurableObject {
  async ensure(since = 0) {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
    const [rounds, error, nextAt] = await Promise.all([
      this.ctx.storage.get("rounds"), this.ctx.storage.get("err"), this.ctx.storage.get("next"),
    ]);
    return {
      interval: WIDE_INTERVAL_MS, cities: WIDE_CITIES, error: error ?? null, nextAt: nextAt ?? null,
      rounds: (rounds ?? []).filter((r) => r.t > since),
    };
  }

  async alarm() {
    try {
      await this.round();
    } catch (e) {
      await this.ctx.storage.put("err", String(e?.message ?? e).slice(0, 200));
    } finally {
      const next = Date.now() + WIDE_INTERVAL_MS;
      await this.ctx.storage.put("next", next);
      await this.ctx.storage.setAlarm(next);
    }
  }

  async round() {
    const headers = { "content-type": "application/json", "user-agent": "SiteMonitor/1.0" };
    if (this.env.GLOBALPING_TOKEN) headers.authorization = `Bearer ${this.env.GLOBALPING_TOKEN}`;
    const locations = WIDE_CITIES.map((city) => ({ country: "US", city, limit: 1 }));
    const t = Date.now();
    const sites = {};
    let firstError = null;
    await Promise.all(SITES.map(async (host) => {
      try {
        sites[host] = await this.measure(host, locations, headers);
      } catch (e) {
        firstError ??= `${host}: ${e.message}`;
        sites[host] = [];
      }
    }));
    const rounds = (await this.ctx.storage.get("rounds")) ?? [];
    rounds.push({ t, sites });
    while (rounds.length > WIDE_KEEP) rounds.shift();
    await this.ctx.storage.put("rounds", rounds);
    await this.ctx.storage.put("err", firstError);
  }

  async measure(host, locations, headers) {
    const res = await fetch(`${GP}/measurements`, {
      method: "POST", headers,
      body: JSON.stringify({ type: "ping", target: host, locations, measurementOptions: { packets: WIDE_PACKETS } }),
    });
    if (!res.ok) {
      let msg = `Globalping HTTP ${res.status}`;
      try { const j = await res.json(); if (j?.error?.message) msg += `: ${j.error.message}`; } catch {}
      throw new Error(msg);
    }
    const { id } = await res.json();
    let m = null;
    for (let i = 0; i < 8; i++) {            // poll politely (limit: 2 requests/second)
      await sleep(i === 0 ? 1500 : 2000);
      const r = await fetch(`${GP}/measurements/${id}`, { headers });
      if (!r.ok) continue;
      m = await r.json();
      if (m.status !== "in-progress") break;
    }
    if (!m) throw new Error("no result from Globalping");
    return (m.results ?? []).map((x) => {
      const p = x.probe ?? {}, r = x.result ?? {};
      const done = r.status === "finished" && r.stats;
      return {
        city: p.city, state: p.state ?? null, lat: p.latitude ?? null, lon: p.longitude ?? null, net: p.network ?? null,
        ok: !!done,                           // false = probe offline/failed (not the same as packet loss)
        avg: done ? r.stats.avg : null, min: done ? r.stats.min : null, max: done ? r.stats.max : null,
        loss: done ? r.stats.loss : null,
      };
    });
  }
}

/* ============================== WORKER ============================== */
const stubFor = (env, p) => env.PROBER.get(env.PROBER.idFromName(p.id), { locationHint: p.hint });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/state") {
      const since = Number(url.searchParams.get("since")) || 0;
      const probes = (
        await Promise.all(PROBES.map((p) => stubFor(env, p).ensure(p, since).catch(() => null)))
      ).filter(Boolean);
      return new Response(
        JSON.stringify({ now: Date.now(), interval: INTERVAL_MS, keep: KEEP, sites: SITES, probes }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } }
      );
    }
    if (url.pathname === "/api/wide") {
      const since = Number(url.searchParams.get("since")) || 0;
      const data = await env.WIDE.get(env.WIDE.idFromName("wide")).ensure(since);
      return new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all([
      ...PROBES.map((p) => stubFor(env, p).ensure(p, Date.now())),
      env.WIDE.get(env.WIDE.idFromName("wide")).ensure(Date.now()),
    ]));
  },
};
