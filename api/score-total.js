import * as cheerio from "cheerio";

const CAMPAIGN_URL = "https://fundraisemyway.cancer.ca/campaigns/scoreforcancer";
const GOAL = 250000;
let lastKnown = null;

function parseMoneyToNumber(text) {
  if (text == null) return null;
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

function collectNumbersDeep(obj, out = []) {
  if (obj == null) return out;
  if (typeof obj === "number") {
    if (Number.isFinite(obj)) out.push(obj);
    return out;
  }
  if (typeof obj === "string") {
    // capture "$186,576" or "186576"
    const money = obj.match(/\$?\s*\d[\d,]*(?:\.\d{2})?/g) || [];
    for (const m of money) {
      const v = parseMoneyToNumber(m);
      if (v != null) out.push(v);
    }
    return out;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) collectNumbersDeep(v, out);
    return out;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      // favor likely fundraising fields
      if (
        /raised|donat|total|amount|progress|goal|sum|value/i.test(k) &&
        (typeof v === "number" || typeof v === "string")
      ) {
        const n = typeof v === "number" ? v : parseMoneyToNumber(v);
        if (n != null) out.push(n);
      }
      collectNumbersDeep(v, out);
    }
  }
  return out;
}

function pickBestRaised(candidates, goal) {
  const clean = candidates
    .map((x) => Math.round(Number(x)))
    .filter((x) => Number.isFinite(x) && x >= 1000); // ignore tiny junk like 1

  if (!clean.length) return null;

  // Prefer plausible raised values <= goal (if goal provided)
  const underGoal = goal ? clean.filter((x) => x <= goal) : clean;
  const pool = underGoal.length ? underGoal : clean;
  return Math.max(...pool);
}

function extractRaisedFromHtml(html, $) {
  // A) Try JSON-LD / app state / script blobs first
  const scriptTexts = [];
  $("script").each((_, el) => {
    const t = $(el).html();
    if (t && t.trim().length) scriptTexts.push(t);
  });

  let jsonCandidates = [];

  for (const s of scriptTexts) {
    const trimmed = s.trim();

    // Direct JSON blocks
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        jsonCandidates.push(...collectNumbersDeep(parsed));
      } catch {}
    }

    // Embedded assignment patterns
    const assignmentPatterns = [
      /__NEXT_DATA__\s*=\s*({[\s\S]*?});/g,
      /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/g,
      /window\.__NUXT__\s*=\s*({[\s\S]*?});/g,
      /"props"\s*:\s*({[\s\S]*})/g
    ];

    for (const re of assignmentPatterns) {
      const matches = [...trimmed.matchAll(re)];
      for (const m of matches) {
        const blob = m[1];
        try {
          const parsed = JSON.parse(blob);
          jsonCandidates.push(...collectNumbersDeep(parsed));
        } catch {}
      }
    }
  }

  const bestJson = pickBestRaised(jsonCandidates, GOAL);
  if (bestJson) return { value: bestJson, method: "json-script-extract" };

  // B) HTML text pattern: "$186,576 RAISED"
  const strictMatches = [...html.matchAll(/\$?\s*([\d]{1,3}(?:,[\d]{3})+|\d+)(?:\.\d{2})?\s+RAISED\b/gi)];
  if (strictMatches.length) {
    const vals = strictMatches
      .map((m) => parseMoneyToNumber(m[1]))
      .filter((v) => Number.isFinite(v) && v >= 1000);
    const best = pickBestRaised(vals, GOAL);
    if (best) return { value: best, method: "html-raised-pattern" };
  }

  // C) Final fallback: all currency text, but ignore tiny values
  const bodyText = $("body").text().replace(/\s+/g, " ");
  const allMoney = bodyText.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
  const vals = allMoney
    .map(parseMoneyToNumber)
    .filter((v) => Number.isFinite(v) && v >= 1000 && v !== GOAL);

  const bestFallback = pickBestRaised(vals, GOAL);
  if (bestFallback) return { value: bestFallback, method: "fallback-currency" };

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

    const extracted = extractRaisedFromHtml(html, $);

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
    const progressPct = GOAL ? Number(((totalRaised / GOAL) * 100).toFixed(2)) : null;

    const payload = {
      totalRaised,
      totalRaisedDisplay: formatMoney(totalRaised),
      goal: GOAL,
      goalDisplay: GOAL ? formatMoney(GOAL) : null,
      progressPct,
      updatedAt: new Date().toISOString(),
      source: CAMPAIGN_URL,
      method: extracted.method,
      stale: false
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
