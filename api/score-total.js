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
    const executablePath = await chromium.executablePath();

    browser = await playwright.launch({
      args: chromium.args,
      executablePath,
      headless: true, // <-- IMPORTANT: must be boolean
    });

    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

    await page.goto(CAMPAIGN_URL, {
      waitUntil: "networkidle",
      timeout: 120000,
    });

    // Small buffer for late-rendered widgets
    await page.waitForTimeout(2500);

    const renderedText = await page.evaluate(() => document.body?.innerText || "");

    // Only accept the tracker-style phrase: "$X RAISED"
    const matches = [...renderedText.matchAll(/\$?\s*([\d]{1,3}(?:,[\d]{3})+|\d+)(?:\.\d{2})?\s+RAISED\b/gi)];
    const values = matches
      .map((m) => parseMoneyToNumber(m[1]))
      .filter((v) => Number.isFinite(v) && v > 0);

    // Prefer plausible value <= goal
    const underGoal = values.filter((v) => v <= GOAL);
    const finalVals = underGoal.length ? underGoal : values;

    if (!finalVals.length) {
      return res.status(500).json({
        error: "Could not parse total raised",
        details: "No '$X RAISED' pattern found in rendered page text",
      });
    }

    const totalRaised = Math.max(...finalVals);
    const progressPct = Number(((totalRaised / GOAL) * 100).toFixed(2));

    return res.status(200).json({
      totalRaised,
      totalRaisedDisplay: formatMoney(totalRaised),
      goal: GOAL,
      goalDisplay: formatMoney(GOAL),
      progressPct,
      updatedAt: new Date().toISOString(),
      source: CAMPAIGN_URL,
      method: "playwright-rendered-dom",
      stale: false,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Could not parse total raised",
      details: String(e),
    });
  } finally {
    if (browser) await browser.close();
  }
}
