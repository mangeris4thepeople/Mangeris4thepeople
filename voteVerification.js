// =============================================================================
// Check Your Representative — Constituent Vote Verification (server side)
// -----------------------------------------------------------------------------
// This is where fairness is actually enforced. NONE of this can live in the
// browser: a client can fake its IP report, clear its own dedup token, lie
// about timing, and never run a secret-key Turnstile check. Treat every value
// that arrives from the client as hostile until verified here.
//
// Free pieces used (no paid tiers, no credit card):
//   - Cloudflare Turnstile siteverify        (bot resistance)
//   - Zippopotam.us  https://api.zippopotam.us  (ZIP -> state, no key)
//   - ip-api.com     http://ip-api.com/json      (IP -> state, free, no key)
// Swap any of these for your own data sources; the interfaces are isolated
// below so you can replace one without touching the vote logic.
//
// Storage: the functions take a `store` object so you can back it with whatever
// your app already uses (the shared real-time store, Postgres, Redis, etc.).
// A minimal in-memory reference implementation is at the bottom for local dev.
// =============================================================================

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY; // server-only secret

// Tunables — adjust to your traffic. These are deliberately conservative.
const CONFIG = {
  MIN_SECONDS_TO_VOTE: 2.5,     // a human reads the bill summary first
  MAX_VOTES_PER_IP_PER_HOUR: 8, // per source IP
  MAX_VOTES_PER_SUBNET_PER_HOUR: 25, // per /24 (IPv4) — catches one actor, many IPs
  GEO_LOOKUP_TIMEOUT_MS: 2500,
};

// -----------------------------------------------------------------------------
// 1. BOT RESISTANCE — Cloudflare Turnstile (the highest-leverage free layer)
// -----------------------------------------------------------------------------
async function verifyTurnstile(token, remoteIp) {
  if (!token) return { ok: false, reason: "missing_turnstile_token" };
  if (!TURNSTILE_SECRET) {
    // Fail loud in dev rather than silently letting bots through.
    console.warn("[vote] TURNSTILE_SECRET_KEY not set — rejecting to stay safe");
    return { ok: false, reason: "turnstile_not_configured" };
  }
  try {
    const body = new URLSearchParams({
      secret: TURNSTILE_SECRET,
      response: token,
      remoteip: remoteIp || "",
    });
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json();
    return { ok: !!data.success, reason: data.success ? null : "turnstile_failed", raw: data };
  } catch (err) {
    return { ok: false, reason: "turnstile_unreachable" };
  }
}

// -----------------------------------------------------------------------------
// 2. GEOGRAPHIC PLAUSIBILITY — a FLAG, never a hard gate.
//    VPNs, mobile carriers, and NAT produce false mismatches constantly, so a
//    mismatch quarantines the vote for separate counting; it never rejects a
//    real constituent outright.
// -----------------------------------------------------------------------------
async function zipToState(zip) {
  try {
    const res = await fetchWithTimeout(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.places?.[0]?.["state abbreviation"] || null;
  } catch { return null; }
}

async function ipToState(ip) {
  // ip-api returns region code (state abbr) for US IPs on the free tier.
  try {
    const res = await fetchWithTimeout(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,region`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== "success" || data.country !== "United States") return null;
    return data.region || null; // e.g. "CO"
  } catch { return null; }
}

async function geoPlausibilityCheck(ip, zip) {
  const [zipState, ipState] = await Promise.all([zipToState(zip), ipToState(ip)]);
  if (!zipState) return { verdict: "bad_zip" };          // ZIP not real -> reject upstream
  if (!ipState)  return { verdict: "geo_unknown", zipState }; // couldn't place IP -> don't penalize
  if (ipState === zipState) return { verdict: "match", zipState, ipState };
  return { verdict: "mismatch", zipState, ipState };     // -> quarantine, don't reject
}

// -----------------------------------------------------------------------------
// 3. RATE LIMITING — per IP and per /24 subnet. Stops volume from one source.
// -----------------------------------------------------------------------------
function subnetOf(ip) {
  // IPv4 /24. (For IPv6, fall back to the /64 — left as a TODO for your stack.)
  const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(ip || "");
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : ip;
}

async function rateLimitOk(store, ip) {
  const now = Date.now();
  const hourAgo = now - 3600_000;
  const ipCount = await store.countRecent(`ip:${ip}`, hourAgo);
  if (ipCount >= CONFIG.MAX_VOTES_PER_IP_PER_HOUR) return { ok: false, reason: "rate_ip" };
  const subnetCount = await store.countRecent(`subnet:${subnetOf(ip)}`, hourAgo);
  if (subnetCount >= CONFIG.MAX_VOTES_PER_SUBNET_PER_HOUR) return { ok: false, reason: "rate_subnet" };
  return { ok: true };
}

// -----------------------------------------------------------------------------
// 4. DEDUP — one position per identity per bill. Identity is the signed vote
//    token if present, else a salted hash of IP+UA (soft). A second vote on the
//    same bill updates the existing position rather than inflating the count.
// -----------------------------------------------------------------------------
const crypto = require("crypto");
const IDENTITY_SALT = process.env.VOTE_IDENTITY_SALT || "change-me-in-prod";

function deriveIdentity({ voteToken, ip, userAgent }) {
  if (voteToken) return `tok:${voteToken}`;
  const h = crypto.createHash("sha256").update(`${IDENTITY_SALT}|${ip}|${userAgent}`).digest("hex");
  return `soft:${h.slice(0, 24)}`;
}

function issueVoteToken(billId, identity) {
  // Signed so the client can hold it but not forge a different identity.
  const payload = `${billId}.${identity}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", IDENTITY_SALT).update(payload).digest("hex").slice(0, 32);
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

// -----------------------------------------------------------------------------
// MAIN ENTRY — call this from your POST /api/vote handler.
//   castVote(store, {
//     billId, position, zip, turnstileToken, honeypot, renderedAt,
//     voteToken, ip, userAgent
//   })
// Returns { status, tier, voteToken?, reason? }
//   status: "counted" | "quarantined" | "rejected"
//   tier:   "verified" | "open"   (verified = passed every check incl. geo match)
// -----------------------------------------------------------------------------
async function castVote(store, input) {
  const {
    billId, position, zip, turnstileToken, honeypot,
    renderedAt, voteToken, ip, userAgent,
  } = input;

  // --- cheap rejects first (no external calls) ---
  if (!billId || !position || !zip) return reject("missing_fields");
  if (honeypot) return reject("honeypot_tripped");               // bots fill hidden fields
  const elapsed = (Date.now() - Number(renderedAt || 0)) / 1000;
  if (!Number.isFinite(elapsed) || elapsed < CONFIG.MIN_SECONDS_TO_VOTE) {
    return reject("too_fast");                                   // submitted faster than a human can read
  }

  // --- rate limit ---
  const rl = await rateLimitOk(store, ip);
  if (!rl.ok) return reject(rl.reason);

  // --- bot check ---
  const turnstile = await verifyTurnstile(turnstileToken, ip);
  if (!turnstile.ok) return reject(turnstile.reason);

  // --- geo plausibility (flag, not gate) ---
  const geo = await geoPlausibilityCheck(ip, zip);
  if (geo.verdict === "bad_zip") return reject("bad_zip");

  // --- dedup / identity ---
  const identity = deriveIdentity({ voteToken, ip, userAgent });
  const existing = await store.findVote(billId, identity);

  // tier: verified only when the IP actually places in the ZIP's state.
  const tier = geo.verdict === "match" ? "verified" : "open";
  const quarantined = geo.verdict === "mismatch";

  const record = {
    billId,
    identity,
    position,
    zipState: geo.zipState,
    tier,
    quarantined,
    ip, // store hashed in prod if you prefer; kept here for abuse review
    subnet: subnetOf(ip),
    ts: Date.now(),
  };

  if (existing) {
    await store.updateVote(billId, identity, record); // change of position, not a new vote
  } else {
    await store.addVote(record);
    await store.bumpRateCounters(`ip:${ip}`, `subnet:${subnetOf(ip)}`, record.ts);
  }

  return {
    status: quarantined ? "quarantined" : "counted",
    tier,
    geo: geo.verdict,
    voteToken: voteToken || issueVoteToken(billId, identity),
  };

  function reject(reason) { return { status: "rejected", reason }; }
}

// -----------------------------------------------------------------------------
// TALLY — returns the two-tier numbers the UI shows. "verified" is the
// high-trust count; "open" is everyone who passed bot/rate/timing but whose
// location couldn't be confirmed. Quarantined (geo-mismatch) votes are reported
// separately and excluded from headline numbers.
// -----------------------------------------------------------------------------
async function tallyBill(store, billId) {
  const votes = await store.listVotes(billId);
  const t = {
    verified: {}, open: {}, quarantined: {},
    counts: { verified: 0, open: 0, quarantined: 0 },
  };
  for (const v of votes) {
    const bucket = v.quarantined ? "quarantined" : v.tier; // "verified" | "open" | "quarantined"
    t[bucket][v.position] = (t[bucket][v.position] || 0) + 1;
    t.counts[bucket] += 1;
  }
  const sampleSize = t.counts.verified + t.counts.open;
  return {
    ...t,
    sampleSize,
    // quality is a blunt, honest signal: share of headline votes that are geo-verified
    qualityScore: sampleSize ? t.counts.verified / sampleSize : 0,
  };
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------
async function fetchWithTimeout(url, ms = CONFIG.GEO_LOOKUP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

// -----------------------------------------------------------------------------
// REFERENCE in-memory store (dev only). Replace with your shared real-time
// store / DB. Implement these six methods against your backend.
// -----------------------------------------------------------------------------
function createMemoryStore() {
  const votes = [];                 // {billId, identity, position, tier, quarantined, ...}
  const rateEvents = new Map();     // key -> [timestamps]
  return {
    async findVote(billId, identity) {
      return votes.find(v => v.billId === billId && v.identity === identity) || null;
    },
    async addVote(record) { votes.push(record); },
    async updateVote(billId, identity, record) {
      const i = votes.findIndex(v => v.billId === billId && v.identity === identity);
      if (i >= 0) votes[i] = record;
    },
    async listVotes(billId) { return votes.filter(v => v.billId === billId); },
    async countRecent(key, sinceTs) {
      return (rateEvents.get(key) || []).filter(t => t >= sinceTs).length;
    },
    async bumpRateCounters(ipKey, subnetKey, ts) {
      for (const k of [ipKey, subnetKey]) {
        const arr = rateEvents.get(k) || [];
        arr.push(ts);
        rateEvents.set(k, arr);
      }
    },
  };
}

module.exports = {
  castVote, tallyBill, createMemoryStore,
  // exported for unit testing / reuse:
  verifyTurnstile, geoPlausibilityCheck, deriveIdentity, subnetOf, CONFIG,
};

// -----------------------------------------------------------------------------
// EXAMPLE Express wiring (delete if you mount it elsewhere):
//
// const express = require("express");
// const { castVote, tallyBill, createMemoryStore } = require("./voteVerification");
// const store = createMemoryStore(); // <-- swap for your real store
// const app = express();
// app.use(express.json());
//
// app.post("/api/vote", async (req, res) => {
//   const ip = req.headers["cf-connecting-ip"] || req.ip; // trust your proxy header
//   const result = await castVote(store, {
//     ...req.body,
//     ip,
//     userAgent: req.headers["user-agent"] || "",
//   });
//   res.json(result);
// });
//
// app.get("/api/tally/:billId", async (req, res) => {
//   res.json(await tallyBill(store, req.params.billId));
// });
// -----------------------------------------------------------------------------
