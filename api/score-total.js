import chromium from "@sparticuz/chromium";
import { chromium as playwright } from "playwright-core";

const CAMPAIGN_URL = "https://fundraisemyway.cancer.ca/campaigns/scoreforcancer";
const GOAL = 250000;

function parseMoneyToNumber(text) {
  if (!text) return null;
  const n = Number(String(text).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function formatMoney(n) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  }).format(n);
}

export default async function handler(req, res) {
  let browser;

  try {
    browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage({
      viewport: { width: 1440, height: 1200 },
    });

    await page.goto(CAMPAIGN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

    // Give client scripts a moment to paint the tracker area
    await page.waitForTimeout(3000);

    // Pull rendered text from the visible page
    const renderedText = await page.evaluate(() => {
      return document.body?.innerText || "";
    });

    // Strictly require "$X RAISED" pattern from rendered text
    const matches = [...renderedText.matchAll(/\$?\s*([\d]{1,3}(?:,[\d]{3})+|\d+)(?:\.\d{2})?\s+RAISED\b/gi)];
    const values = matches
      .map((m) => parseMoneyToNumber(m[1]))
      .filter((v) => Number.isFinite(v) && v > 0);

    // Prefer plausible raised amount <= goal
    const underGoal = values.filter((v) => v <= GOAL);
    const finalVals = underGoal.length ? underGoal : values;

    if (!finalVals.length) {
      throw new Error("Could not find '$X RAISED' in rendered DOM");
    }

    const totalRaised = Math.max(...finalVals);
    const progressPct = Number(((totalRaised / GOAL) * 100).toFixed(2));

    const payload = {
      totalRaised,
      totalRaisedDisplay: formatMoney(totalRaised),
      goal: GOAL,
      goalDisplay: formatMoney(GOAL),
      progressPct,
      updatedAt: new Date().toISOString(),
      source: CAMPAIGN_URL,
      method: "playwright-rendered-dom",
      stale: false,
    };

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({
      error: "Could not parse total raised",
      details: String(e),
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
