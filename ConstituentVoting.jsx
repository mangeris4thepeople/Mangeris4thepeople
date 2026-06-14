// =============================================================================
// Check Your Representative — Constituent Voting module (client)
// -----------------------------------------------------------------------------
// Drop-in for the "We the People" shell. Internal names kept per project
// convention: myDelegate, delegateVotes, DELEGATES_DB.
//
// What this component does on the client:
//   - mounts the Cloudflare Turnstile widget and collects its token
//   - plants a honeypot field + records render time (anti-bot / anti-script)
//   - POSTs everything to /api/vote, where the REAL fairness checks run
//   - renders the two-tier tally (verified vs open) with an honest
//     methodology disclosure so manipulable numbers never masquerade as a
//     scientific measure of district opinion
//
// The browser is NEVER trusted to decide if a vote is valid — it only collects
// signals. All verdicts come back from the server (see voteVerification.js).
//
// PREVIEW vs PRODUCTION:
//   Search for "PREVIEW_MOCK". Those blocks let this render standalone here.
//   In your app, set USE_MOCK = false and supply your real DELEGATES_DB,
//   Turnstile site key, and /api endpoints.
// =============================================================================

import React, { useState, useEffect, useRef, useCallback } from "react";

const USE_MOCK = true; // <-- set false in your app
const TURNSTILE_SITE_KEY = "YOUR_TURNSTILE_SITE_KEY"; // public site key (safe in client)

// --- theme tokens (match the existing shell; swap for your classes if you have them)
const C = {
  crimson: "#8B0000",
  crimsonBright: "#B22234",
  navy: "#0A1A3F",
  navySoft: "#14213D",
  gold: "#C9A227",
  parchment: "#FBF7EC",
  parchmentEdge: "#F0E6CE",
  ink: "#1A1A1A",
  muted: "#5C5347",
  line: "#D8C9A0",
};
const serif = "Georgia, 'Times New Roman', serif";

// PREVIEW_MOCK ---------------------------------------------------------------
// In production this is your real ZIP->representative lookup over DELEGATES_DB.
const DELEGATES_DB = {
  "80538": { myDelegate: { name: "Rep. Joe Neguse", party: "D", district: "CO-02", state: "CO" } },
  "80202": { myDelegate: { name: "Rep. Diana DeGette", party: "D", district: "CO-01", state: "CO" } },
  "73301": { myDelegate: { name: "Rep. Greg Casar", party: "D", district: "TX-35", state: "TX" } },
};
function lookupDelegate(zip) {
  return DELEGATES_DB[zip]?.myDelegate || null;
}
// end PREVIEW_MOCK -----------------------------------------------------------

const POSITIONS = [
  { key: "support", label: "Support", color: C.navy },
  { key: "oppose", label: "Oppose", color: C.crimson },
  { key: "undecided", label: "Undecided", color: C.muted },
];

// ---------------------------------------------------------------------------
// Turnstile hook — loads the script once and renders the widget explicitly.
// ---------------------------------------------------------------------------
function useTurnstile(siteKey, onToken) {
  const containerRef = useRef(null);
  const widgetId = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (USE_MOCK) { setReady(true); return; } // PREVIEW_MOCK: skip real widget
    const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    function render() {
      if (!window.turnstile || !containerRef.current || widgetId.current) return;
      widgetId.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: (token) => onToken(token),
        "error-callback": () => onToken(null),
        "expired-callback": () => onToken(null),
        theme: "light",
      });
      setReady(true);
    }
    if (window.turnstile) { render(); return; }
    let s = document.querySelector(`script[src="${SRC}"]`);
    if (!s) {
      s = document.createElement("script");
      s.src = SRC; s.async = true; s.defer = true;
      document.head.appendChild(s);
    }
    s.addEventListener("load", render);
    const t = setInterval(() => { if (window.turnstile) { render(); clearInterval(t); } }, 250);
    return () => clearInterval(t);
  }, [siteKey, onToken]);

  const reset = useCallback(() => {
    if (!USE_MOCK && window.turnstile && widgetId.current) {
      window.turnstile.reset(widgetId.current);
    }
  }, []);

  return { containerRef, ready, reset };
}

// ---------------------------------------------------------------------------
// API layer
// ---------------------------------------------------------------------------
// PREVIEW_MOCK: a tiny fake server so the component is interactive here.
const mockState = { votes: [] };
async function mockCastVote(payload) {
  await new Promise(r => setTimeout(r, 500));
  if (payload.honeypot) return { status: "rejected", reason: "honeypot_tripped" };
  if ((Date.now() - payload.renderedAt) / 1000 < 2.5) return { status: "rejected", reason: "too_fast" };
  // pretend ~70% geo-verify, rest "open"
  const tier = Math.random() < 0.7 ? "verified" : "open";
  mockState.votes.push({ billId: payload.billId, position: payload.position, tier });
  return { status: "counted", tier, voteToken: "mock-token-" + Math.random().toString(36).slice(2, 10) };
}
async function mockTally(billId) {
  await new Promise(r => setTimeout(r, 200));
  const t = { verified: {}, open: {}, quarantined: {}, counts: { verified: 0, open: 0, quarantined: 0 } };
  for (const v of mockState.votes.filter(v => v.billId === billId)) {
    t[v.tier][v.position] = (t[v.tier][v.position] || 0) + 1;
    t.counts[v.tier] += 1;
  }
  const sampleSize = t.counts.verified + t.counts.open;
  return { ...t, sampleSize, qualityScore: sampleSize ? t.counts.verified / sampleSize : 0 };
}

async function castVoteApi(payload) {
  if (USE_MOCK) return mockCastVote(payload);
  const res = await fetch("/api/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}
async function fetchTally(billId) {
  if (USE_MOCK) return mockTally(billId);
  const res = await fetch(`/api/tally/${encodeURIComponent(billId)}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function ConstituentVoting({ bill }) {
  // PREVIEW_MOCK default bill so it renders standalone
  const activeBill = bill || { id: "hr-1234-119", title: "H.R. 1234 — Clean Water Infrastructure Act" };

  const [zip, setZip] = useState("");
  const [myDelegate, setMyDelegate] = useState(null);
  const [selected, setSelected] = useState(null);
  const [turnstileToken, setTurnstileToken] = useState(USE_MOCK ? "mock" : null);
  const [honeypot, setHoneypot] = useState("");       // must stay empty
  const [renderedAt] = useState(() => Date.now());     // timing baseline
  const [phase, setPhase] = useState("idle");          // idle|submitting|done|error
  const [result, setResult] = useState(null);
  const [delegateVotes, setDelegateVotes] = useState(null); // the tally
  const [error, setError] = useState(null);

  const onToken = useCallback((tok) => setTurnstileToken(tok), []);
  const { containerRef, ready, reset } = useTurnstile(TURNSTILE_SITE_KEY, onToken);

  // resolve representative as the constituent types their ZIP
  useEffect(() => {
    if (/^\d{5}$/.test(zip)) setMyDelegate(lookupDelegate(zip));
    else setMyDelegate(null);
  }, [zip]);

  // load the current tally for this bill
  const refreshTally = useCallback(async () => {
    try { setDelegateVotes(await fetchTally(activeBill.id)); } catch { /* non-fatal */ }
  }, [activeBill.id]);
  useEffect(() => { refreshTally(); }, [refreshTally]);

  const canSubmit = /^\d{5}$/.test(zip) && myDelegate && selected && turnstileToken && phase !== "submitting";

  async function submitVote() {
    if (!canSubmit) return;
    setPhase("submitting"); setError(null);
    try {
      const res = await castVoteApi({
        billId: activeBill.id,
        position: selected,
        zip,
        turnstileToken,
        honeypot,
        renderedAt,
        voteToken: null, // server issues one; persist it in your shared store/cookie
      });
      if (res.status === "rejected") {
        setError(humanizeReason(res.reason));
        setPhase("error");
        reset(); setTurnstileToken(USE_MOCK ? "mock" : null);
        return;
      }
      setResult(res);
      setPhase("done");
      refreshTally();
    } catch (e) {
      setError("Couldn't reach the server. Please try again.");
      setPhase("error");
    }
  }

  return (
    <div style={{ fontFamily: serif, color: C.ink, background: C.parchment,
                  border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden",
                  maxWidth: 680, margin: "0 auto" }}>
      <StarStrip />
      <div style={{ padding: "20px 24px 26px" }}>
        <div style={{ textTransform: "uppercase", letterSpacing: 2, fontSize: 11,
                      color: C.gold, fontWeight: 700 }}>Constituent Position</div>
        <h2 style={{ margin: "4px 0 2px", fontSize: 22, color: C.navy }}>{activeBill.title}</h2>
        <p style={{ margin: 0, fontSize: 13, color: C.muted }}>
          Cast your position, then see how it compares to your district.
        </p>

        {/* ZIP + representative */}
        <div style={{ marginTop: 18 }}>
          <label style={{ fontSize: 12, fontWeight: 700, color: C.navy }}>YOUR ZIP CODE</label>
          <input
            value={zip}
            onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))}
            inputMode="numeric" placeholder="e.g. 80538"
            style={{ display: "block", marginTop: 6, padding: "9px 12px", width: 160,
                     fontFamily: serif, fontSize: 15, border: `1px solid ${C.line}`,
                     borderRadius: 4, background: "#fff" }}
          />
          {/^\d{5}$/.test(zip) && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
              {myDelegate
                ? <span>Your representative: <strong style={{ color: C.crimson }}>
                    {myDelegate.name}</strong> ({myDelegate.party}, {myDelegate.district})</span>
                : <span style={{ color: C.crimson }}>No representative found for that ZIP.</span>}
            </div>
          )}
        </div>

        {/* Position choice */}
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 8 }}>
            YOUR POSITION
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {POSITIONS.map(p => (
              <button key={p.key} onClick={() => setSelected(p.key)}
                style={{ flex: "1 1 120px", padding: "11px 8px", cursor: "pointer",
                         fontFamily: serif, fontSize: 15, borderRadius: 4,
                         border: `2px solid ${selected === p.key ? p.color : C.line}`,
                         background: selected === p.key ? p.color : "#fff",
                         color: selected === p.key ? "#fff" : p.color, fontWeight: 700 }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Honeypot — visually hidden, real users never touch it */}
        <input
          tabIndex={-1} autoComplete="off" value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
          aria-hidden="true"
          style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }}
        />

        {/* Turnstile mount */}
        <div style={{ marginTop: 18 }}>
          <div ref={containerRef} />
          {USE_MOCK && (
            <div style={{ fontSize: 12, color: C.muted, fontStyle: "italic" }}>
              (Turnstile widget renders here in production — mocked for preview.)
            </div>
          )}
        </div>

        {/* Submit */}
        <button onClick={submitVote} disabled={!canSubmit}
          style={{ marginTop: 18, width: "100%", padding: "13px", fontFamily: serif,
                   fontSize: 16, fontWeight: 700, borderRadius: 4, border: "none",
                   cursor: canSubmit ? "pointer" : "not-allowed",
                   background: canSubmit ? C.crimson : "#C9BFAB",
                   color: "#fff", letterSpacing: 0.5 }}>
          {phase === "submitting" ? "Recording…"
            : phase === "done" ? "Position Recorded ✓"
            : "Cast My Position"}
        </button>

        {error && (
          <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 4,
                        background: "#FBE9E7", color: C.crimson, fontSize: 13,
                        border: `1px solid ${C.crimsonBright}` }}>
            {error}
          </div>
        )}

        {phase === "done" && result && (
          <div style={{ marginTop: 12, fontSize: 13, color: C.navy }}>
            Recorded as a <strong>{result.tier === "verified" ? "location-verified" : "unverified"}</strong> vote.
            {result.tier !== "verified" &&
              " (We couldn't confirm your location from your connection — your vote still counts in the open tally.)"}
          </div>
        )}

        {/* Tally + honest methodology */}
        {delegateVotes && <TallyPanel tally={delegateVotes} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function TallyPanel({ tally }) {
  const { sampleSize, qualityScore, verified, open, counts } = tally;
  const combined = {};
  for (const p of POSITIONS) {
    combined[p.key] = (verified[p.key] || 0) + (open[p.key] || 0);
  }
  const total = sampleSize || 1;

  return (
    <div style={{ marginTop: 22, borderTop: `2px solid ${C.gold}`, paddingTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, letterSpacing: 1 }}>
          DISTRICT POSITIONS SO FAR
        </div>
        <div style={{ fontSize: 12, color: C.muted }}>{sampleSize} responses</div>
      </div>

      {POSITIONS.map(p => {
        const n = combined[p.key] || 0;
        const pct = Math.round((n / total) * 100);
        return (
          <div key={p.key} style={{ marginTop: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ fontWeight: 700, color: p.color }}>{p.label}</span>
              <span style={{ color: C.muted }}>{pct}% · {n}</span>
            </div>
            <div style={{ height: 8, background: C.parchmentEdge, borderRadius: 4, marginTop: 3 }}>
              <div style={{ width: `${pct}%`, height: "100%", background: p.color, borderRadius: 4 }} />
            </div>
          </div>
        );
      })}

      {/* quality + the honest disclosure — the most important part */}
      <div style={{ marginTop: 16, padding: "12px 14px", background: "#fff",
                    border: `1px solid ${C.line}`, borderRadius: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <QualityBadge score={qualityScore} />
          <span style={{ fontSize: 12.5, color: C.navy, fontWeight: 700 }}>
            {counts.verified} of {sampleSize} responses are location-verified
          </span>
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 11.5, lineHeight: 1.5, color: C.muted }}>
          This is a self-selected opinion poll, not a scientific survey. People who
          choose to respond are not a random sample of the district, so these numbers
          show the views of participants — not a measured district consensus.
          "Location-verified" means the connection placed in the ZIP's state;
          bot, rate, and timing filters are applied before any vote is counted.
        </p>
      </div>
    </div>
  );
}

function QualityBadge({ score }) {
  const pct = Math.round(score * 100);
  const tone = score >= 0.7 ? C.navy : score >= 0.4 ? C.gold : C.crimson;
  return (
    <span style={{ fontFamily: serif, fontSize: 11, fontWeight: 800, color: "#fff",
                   background: tone, borderRadius: 10, padding: "2px 9px" }}>
      {pct}% verified
    </span>
  );
}

function StarStrip() {
  return (
    <div style={{ background: C.navy, padding: "6px 0", display: "flex",
                  justifyContent: "center", gap: 9 }}>
      {Array.from({ length: 13 }).map((_, i) => (
        <span key={i} style={{ color: C.gold, fontSize: 11 }}>★</span>
      ))}
    </div>
  );
}

function humanizeReason(reason) {
  const map = {
    honeypot_tripped: "This submission looked automated and wasn't recorded.",
    too_fast: "That was submitted too quickly — take a moment to review the bill, then try again.",
    rate_ip: "Too many votes from your connection recently. Please try later.",
    rate_subnet: "Too many votes from your network recently. Please try later.",
    turnstile_failed: "We couldn't verify you're human. Please complete the check and retry.",
    turnstile_not_configured: "Verification isn't set up yet. Please try again later.",
    bad_zip: "That ZIP code wasn't recognized. Please check and re-enter.",
    missing_fields: "Please enter your ZIP and choose a position first.",
  };
  return map[reason] || "Your vote couldn't be recorded. Please try again.";
}
