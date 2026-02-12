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
  // 1) Best signal: "$186,576 RAISED" (uppercase tracker label)
  const strictMatches = [...html.matchAll(/\$?\s*([\d]{1,3}(?:,[\d]{3})+|\d+)(?:\.\d{2})?\s+RAISED\b/g)];
  if (strictMatches.length) {
    const vals = strictMatches
      .map((m) => parseMoneyToNumber(m[1]))
      .filter((v) => Number.isFinite(v) && v > 0);

    if (vals.length) {
      const filtered = GOAL ? vals.filter((v) => v <= GOAL) : vals;
      const pickFrom = filtered.length ? filtered : vals;
      return { value: Math.max(...pickFrom), method: "strict-uppercase-raised" };
    }
  }

  // 2) Element-level: any element containing uppercase "RAISED" plus dollar value
  let elementVals = [];
  $("*").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (!t || !t.includes("RAISED")) return; // uppercase only
    const matches = t.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
    for (const mm of matches) {
      const v = parseMoneyToNumber(mm);
      if (v && v > 0) elementVals.push(v);
    }
  });

  if (elementVals.length) {
    const filtered = GOAL ? elementVals.filter((v) => v <= GOAL) : elementVals;
    const pickFrom = filtered.length ? filtered : elementVals;
    return { value: Math.max(...pickFrom), method: "element-uppercase-raised" };
  }

  // 3) Fallback: if uppercase signal fails, try title/progress context
  const body = $("body").text().replace(/\s+/g, " ");
  const nearGoalPattern = new RegExp(
    String.raw`\$?\s*([\d]{1,3}(?:,[\d]{3})+|\d+)(?:\.\d{2})?\s+(?:RAISED|raised)[\s\S]{0,120}GOAL`,
    "i"
  );
  const mg = body.match(nearGoalPattern);
  if (mg) {
    const v = parseMoneyToNumber(mg[1]);
    if (v && v > 0) return { value: v, method: "raised-near-goal-fallback" };
  }

  // 4) Last resort: choose largest currency value that is not equal to GOAL
  const allMoney = body.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
  const vals = allMoney
    .map(parseMoneyToNumber)
    .filter((v) => Number.isFinite(v) && v > 0 && v !== GOAL);

  if (vals.length) {
    return { value: Math.max(...vals), method: "last-resort-currency-max" };
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
