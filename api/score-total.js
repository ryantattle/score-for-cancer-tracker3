import chromium from "@sparticuz/chromium";
import { chromium as playwright } from "playwright-core";

const CAMPAIGN_URL = "https://fundraisemyway.cancer.ca/campaigns/scoreforcancer";
const GOAL = 250000;

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
    const executablePath = await chromium.executablePath();

    browser = await playwright.launch({
      args: chromium.args,
      executablePath,
      headless: true // IMPORTANT: boolean
    });

    const page = await browser.newPage({
      viewport: { width: 1440, height: 1200 }
    });

    await page.goto(CAMPAIGN_URL, {
      waitUntil: "networkidle",
      timeout: 120000
    });

    await page.waitForTimeout(2500);

    const renderedText = await page.evaluate(() => document.body?.innerText || "");

    // Match only the fundraiser value pattern: "$X RAISED"
    const raisedMatches = [...renderedText.matchAll(/\$([\d,]+(?:\.\d{2})?)\s+RAISED\b/gi)];

    let raisedValues = raisedMatches
      .map(m => Number(m[1].replace(/,/g, "")))
      .filter(v => Number.isFinite(v) && v > 0);

    // Exclude goal value explicitly
    raisedValues = raisedValues.filter(v => v !== GOAL);

    if (!raisedValues.length) {
      return res.status(500).json({
        error: "Could not parse total raised",
        details: "No '$X RAISED' value found in rendered page text"
      });
    }

    const totalRaised = Math.max(...raisedValues);
    const progressPct = Number(((totalRaised / GOAL) * 100).toFixed(2));

    return res.status(200).json({
      totalRaised,
      totalRaisedDisplay: formatMoney(totalRaised),
      goal: GOAL,
      goalDisplay: formatMoney(GOAL),
      progressPct,
      updatedAt: new Date().toISOString(),
      source: CAMPAIGN_URL,
      method: "playwright-strict-raised",
      stale: false
    });
  } catch (e) {
    return res.status(500).json({
      error: "Could not parse total raised",
      details: String(e)
    });
  } finally {
    if (browser) await browser.close();
  }
}
