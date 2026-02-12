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

function extractRaised(html, $) {
  // 1) Strongest signal: "$123,456 RAISED"
  const raisedPattern = /\$?\s*([\d]{1,3}(?:,[\d]{3})+|\d+)(?:\.\d{2})?\s*RAISED\b/i;
  const m1 = html.match(raisedPattern);
  if (m1) {
    const v = parseMoneyToNumber(m1[1]);
    if (v && v > 0) return { value: v, method: "regex-dollar-raised" };
  }

  // 2) Any element text containing "RAISED", parse money from that same element
  let candidateValues = [];
  $(":contains('RAISED'), :contains('Raised'), :contains('raised')").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (!t) return;
    if (!/raised/i.test(t)) return;
    const match = t.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
    for (const mm of match) {
      const v = parseMoneyToNumber(mm);
      if (v && v > 0) candidateValues.push(v);
    }
  });

  // Avoid picking goal amounts; if we can, choose value <= GOAL and reasonably large
  if (candidateValues.length) {
    const filtered = candidateValues.filter((v) => !GOAL || v <= GOAL);
    const pickFrom = filtered.length ? filtered : candidateValues;
    const best = Math.max(...pickFrom);
    if (best > 0) return { value: best, method: "element-containing-raised" };
  }

  // 3) Nearby labeled text fallback: "raised" + money in full page text
  const bodyText = $("body").text().replace(/\s+/g, " ");
  const m2 = bodyText.match(/\$[\d,]+(?:\.\d{2})?\s*RAISED\b/i);
  if (m2) {
    const v = parseMoneyToNumber(m2[0]);
    if (v && v > 0) return { value: v, method: "body-raised-token" };
  }

  // 4) Last fallback: currency values, avoid known GOAL if possible
  const allMoney = bodyText.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
  const vals = allMoney.map(parseMoneyToNumber).filter((v) => Number.isFinite(v) && v > 0);

  if (vals.length) {
    // Prefer values not equal to GOAL and above a minimum threshold
    const filtered = vals.filter((v) => v !== GOAL && v >= 1000);
    const pickFrom = filtered.length ? filtered : vals;
    const best = Math.max(...pickFrom);
    return { value: best, method: "fallback-currency-max" };
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
