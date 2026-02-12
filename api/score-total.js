import * as cheerio from "cheerio";

const CAMPAIGN_URL = "https://fundraisemyway.cancer.ca/campaigns/scoreforcancer";
const GOAL = 250000;
let lastKnown = null;

function parseMoneyToNumber(text) {
  if (!text) return null;
  const n = Number(String(text).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function formatMoney(n) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  }).format(n);
}

function bestFromHeaderText(text) {
  const t = text.replace(/\s+/g, " ").trim();

  // Must contain both tracker anchors
  if (!/RAISED/i.test(t)) return null;
  if (!/GOAL/i.test(t)) return null;

  // Find "$xxx RAISED" specifically
  const raisedMatches = [...t.matchAll(/\$?\s*([\d]{1,3}(?:,[\d]{3})+|\d+)(?:\.\d{2})?\s*RAISED\b/gi)];
  const vals = raisedMatches
    .map((m) => parseMoneyToNumber(m[1]))
    .filter((v) => Number.isFinite(v) && v > 0 && v <= GOAL);

  if (!vals.length) return null;
  return Math.max(...vals);
}

function extractRaised(html, $) {
  // 1) Element-level: choose only blocks containing BOTH "RAISED" and "GOAL"
  let candidates = [];

  $("body *").each((_, el) => {
    const text = $(el).text();
    if (!text) return;
    const compact = text.replace(/\s+/g, " ").trim();
    if (!compact) return;

    if (/RAISED/i.test(compact) && /GOAL/i.test(compact)) {
      const v = bestFromHeaderText(compact);
      if (v) {
        candidates.push({
          value: v,
          len: compact.length,
          text: compact,
        });
      }
    }
  });

  if (candidates.length) {
    // Prefer the smallest matching block (closest to the actual widget)
    candidates.sort((a, b) => a.len - b.len);
    return { value: candidates[0].value, method: "header-block-raised-goal" };
  }

  // 2) HTML-wide bounded pattern: "$X RAISED ... GOAL $Y" within short distance
  const normalized = html.replace(/\s+/g, " ");
  const bounded = [...normalized.matchAll(
    /\$?\s*([\d]{1,3}(?:,[\d]{3})+|\d+)(?:\.\d{2})?\s*RAISED[\s\S]{0,220}?GOAL[\s\S]{0,80}?\$?\s*([\d]{1,3}(?:,[\d]{3})+|\d+)/gi
  )];

  if (bounded.length) {
    const vals = bounded
      .map((m) => parseMoneyToNumber(m[1]))
      .filter((v) => Number.isFinite(v) && v > 0 && v <= GOAL);
    if (vals.length) return { value: Math.max(...vals), method: "bounded-raised-goal-pattern" };
  }

  return null;
}

export default async function handler(req, res) {
  try {
    const resp = await fetch(CAMPAIGN_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-CA,en;q=0.9",
      },
      cache: "no-store",
    });

    if (!resp.ok) {
      if (lastKnown) {
        return res.status(200).json({
          ...lastKnown,
          stale: true,
          note: "source fetch failed; returning last known value",
        });
      }
      return res.status(502).json({ error: "Failed to fetch campaign page" });
    }

    const html = await resp.text();
    const $ = cheerio.load(html);

    const extracted = extractRaised(html, $);

    if (!extracted?.value) {
      if (lastKnown) {
        return res.status(200).json({
          ...lastKnown,
          stale: true,
          note: "parse failed; returning last known value",
        });
      }
      return res.status(500).json({ error: "Could not parse total raised" });
    }

    const totalRaised = extracted.value;
    const progressPct = Number(((totalRaised / GOAL) * 100).toFixed(2));

    const payload = {
      totalRaised,
      totalRaisedDisplay: formatMoney(totalRaised),
      goal: GOAL,
      goalDisplay: formatMoney(GOAL),
      progressPct,
      updatedAt: new Date().toISOString(),
      source: CAMPAIGN_URL,
      method: extracted.method,
      stale: false,
    };

    lastKnown = payload;

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
    return res.status(200).json(payload);
  } catch (e) {
    if (lastKnown) {
      return res.status(200).json({
        ...lastKnown,
        stale: true,
        note: "exception; returning last known value",
      });
    }
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
