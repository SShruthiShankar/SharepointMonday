import { Router } from 'express';
import { getPage } from '../browserManager.js';

const router = Router();

// Monday boards virtualize rows (only renders what's currently scrolled into view), so a SKU
// that exists further down the board simply isn't in the DOM yet and getByText misses it.
// This scrolls the board's item list container down in steps, checking for the SKU text after
// each step, until it's found or we've scrolled through the whole board without new content
// appearing (meaning we've reached the bottom).
async function findScrollableContainer(page) {
  // Monday's main grid area; fall back to scrolling the whole page if not found.
  const candidates = [
    '[data-testid="board-content"]',
    '.pulse-grid',
    'main',
  ];
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0) return el;
  }
  return null;
}

// Reads the column headers from the board as {name, id} pairs, in left-to-right order. Each
// header title element has an id like "column-title-<columnId>" — that <columnId> is also
// referenced by every cell in that column via aria-labelledby, which lets us match a row's
// cell to a column by stable id rather than fragile DOM position/index (Monday's grid doesn't
// use role="row"/"gridcell" at all, so index-based ARIA traversal doesn't work here).
async function readBoardColumns(page) {
  return page.evaluate(() => {
    function cleanText(el) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('[class*="srOnly"]').forEach((n) => n.remove());
      return (clone.textContent || '').trim();
    }
    const cells = Array.from(document.querySelectorAll('.column-header-inner'));
    const result = [];
    for (const cell of cells) {
      const titleEl = cell.querySelector('[data-testid="text"]') || cell.querySelector('[id^="column-title"]');
      const idEl = cell.querySelector('[id^="column-title-"]');
      const t = titleEl ? cleanText(titleEl) : cleanText(cell);
      if (!t || t === '+') continue;
      const id = idEl ? idEl.id.replace(/^column-title-/, '') : null;
      result.push({ name: t, id });
    }
    return result;
  });
}

// Finds the column id whose header text matches columnName (case-insensitive).
async function findColumnId(page, columnName) {
  const columns = await readBoardColumns(page);
  const target = columnName.trim().toLowerCase();
  const match = columns.find((c) => c.name.toLowerCase() === target);
  return match ? match.id : null;
}

// Within a row element, locates the cell belonging to the given column id by matching the
// first token of its aria-labelledby attribute (e.g. "column-title-<id> name-cell-<pulseId>").
function getCellByColumnId(row, columnId) {
  return row.locator(`[aria-labelledby^="column-title-${columnId} "], [aria-labelledby="column-title-${columnId}"]`).first();
}

// Dumps the DOM structure around a leaf element containing the given text, so we can see the
// real row/cell markup (which may not use ARIA role="row"/"gridcell" at all) and fix selectors
// precisely instead of guessing.
async function debugDumpAroundText(page, text) {
  return page.evaluate((text) => {
    function cleanText(el) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('[class*="srOnly"]').forEach((n) => n.remove());
      return (clone.textContent || '').trim();
    }
    const all = Array.from(document.querySelectorAll('*'));
    const leaf = all.find((e) => e.children.length === 0 && cleanText(e) === text);
    if (!leaf) return { error: `no leaf element with exact text "${text}" found` };
    let node = leaf;
    const levels = [];
    for (let i = 0; i < 20 && node.parentElement; i++) {
      node = node.parentElement;
      const attrs = {};
      for (const a of node.attributes) attrs[a.name] = a.value.slice(0, 60);
      levels.push({
        level: i,
        tag: node.tagName,
        className: String(node.className).slice(0, 100),
        childCount: node.children.length,
        attrs,
      });
    }
    return { levels };
  }, text);
}

// Finds the table row whose cell in the given match-column equals the given SKU (exact,
// case-insensitive), scrolling through the (possibly virtualized) board to reveal rows that
// aren't rendered yet until found or the bottom of the board is reached. Each row is a
// `div[role="list"]` whose id starts with "row-pulse-", directly containing one cell per
// column (Monday doesn't use role="row"/"gridcell" here).
async function findRowForSku(page, sku, matchColumnId) {
  const target = String(sku).trim().toLowerCase();

  const locateRow = async () => {
    const rows = page.locator('div[role="list"][id*="row-pulse-"]');
    const rowCount = await rows.count();
    for (let r = 0; r < rowCount; r++) {
      const row = rows.nth(r);
      const cell = getCellByColumnId(row, matchColumnId);
      if ((await cell.count()) === 0) continue;
      const text = (await cell.innerText().catch(() => '')).trim().toLowerCase();
      if (text === target) return row;
    }
    return null;
  };

  let found = await locateRow();
  if (found) return found;

  const scrollTarget = await findScrollableContainer(page);
  if (!scrollTarget) return null;

  const MAX_SCROLLS = 60;
  let lastScrollTop = -1;
  for (let i = 0; i < MAX_SCROLLS; i++) {
    const { scrollTop, reachedEnd } = await scrollTarget.evaluate((el) => {
      const before = el.scrollTop;
      el.scrollTop = before + el.clientHeight;
      return { scrollTop: el.scrollTop, reachedEnd: el.scrollTop === before };
    });
    await page.waitForTimeout(150);
    found = await locateRow();
    if (found) return found;
    if (reachedEnd || scrollTop === lastScrollTop) break;
    lastScrollTop = scrollTop;
  }
  return null;
}

// Opens the link-column cell editor and enters the URL.
async function setLinkCellValue(page, cell, link) {
  await cell.click();
  await page.waitForTimeout(300);
  // Monday's link column editor typically shows a text input for the URL.
  const input = page.locator('input[placeholder*="link" i], input[type="url"]').first();
  if ((await input.count()) > 0) {
    await input.fill(link);
    await input.press('Enter');
  } else {
    // Fallback: type directly in case the cell itself became an editable input.
    await page.keyboard.type(link);
    await page.keyboard.press('Enter');
  }
  await page.keyboard.press('Escape').catch(() => {});
}

// Opens the given board and reads the column header names directly from the live DOM, so the
// frontend can offer a dropdown instead of requiring the user to type the exact column name.
router.get('/columns', async (req, res, next) => {
  try {
    const { boardUrl } = req.query;
    if (!boardUrl) return res.status(400).json({ error: 'boardUrl is required' });
    console.log(`[monday/columns] opening boardUrl=${boardUrl}`);
    const { page } = await getPage('monday');
    await page.goto(boardUrl, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();

    // Monday is a heavy SPA — the board grid (and its column headers) can take a few seconds
    // to render after the initial page load, especially on first navigation. Poll until the
    // item-name text ("Item" header, or any item row) appears before trying to read columns.
    const DEADLINE_MS = 20000;
    const start = Date.now();
    while (Date.now() - start < DEADLINE_MS) {
      const ready = await page.evaluate(() => document.body.innerText.includes('Item'));
      if (ready) break;
      await page.waitForTimeout(500);
    }

    const columns = await readBoardColumns(page);
    const names = columns.map((c) => c.name);
    console.log(`[monday/columns] finalUrl=${page.url()} names=${JSON.stringify(names)}`);

    if (names.length === 0) {
      return res.status(502).json({
        error: 'No columns found on the board. Make sure you are logged in to Monday.com, the board URL is correct, and the board has finished loading in the opened browser window.',
      });
    }
    res.json({ columns: names });
  } catch (err) {
    next(err);
  }
});

// Drives the real monday.com UI (using the logged-in browser session) to find each SKU's
// row on the given board and set its "Post" link column to the given SharePoint URL.
router.post('/update', async (req, res, next) => {
  try {
    const { boardUrl, matchColumnName, postColumnName, updates } = req.body;
    if (!boardUrl || !matchColumnName || !postColumnName || !Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'boardUrl, matchColumnName, postColumnName and updates[] are required' });
    }
    const { page } = await getPage('monday');
    await page.goto(boardUrl, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();

    // Same readiness wait as /columns — the board grid can take several seconds to render,
    // and reading columns too early returns an empty/incomplete list, causing valid column
    // names to be reported as "not found".
    const DEADLINE_MS = 20000;
    const start = Date.now();
    while (Date.now() - start < DEADLINE_MS) {
      const ready = await page.evaluate(() => document.body.innerText.includes('Item'));
      if (ready) break;
      await page.waitForTimeout(500);
    }

    const matchColumnId = await findColumnId(page, matchColumnName);
    if (!matchColumnId) {
      return res.status(400).json({ error: `Match column "${matchColumnName}" not found on board` });
    }
    const postColumnId = await findColumnId(page, postColumnName);
    if (!postColumnId) {
      return res.status(400).json({ error: `Update column "${postColumnName}" not found on board` });
    }

    const results = [];
    for (const { sku, link } of updates) {
      try {
        const row = await findRowForSku(page, sku, matchColumnId);
        if (!row) {
          const debug = await debugDumpAroundText(page, String(sku).trim());
          console.log(`[monday/update] row not found for sku=${sku} debug=${JSON.stringify(debug)}`);
          results.push({ sku, status: 'not_found' });
          continue;
        }
        const cell = getCellByColumnId(row, postColumnId);
        if ((await cell.count()) === 0) {
          results.push({ sku, status: 'error', error: `Column "${postColumnName}" not found in row` });
          continue;
        }
        await setLinkCellValue(page, cell, link);
        results.push({ sku, status: 'updated' });
      } catch (err) {
        results.push({ sku, status: 'error', error: err.message });
      }
    }
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

export default router;
