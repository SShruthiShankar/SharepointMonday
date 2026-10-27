import { Router } from 'express';
import axios from 'axios';
import { getPage } from '../browserManager.js';

const router = Router();

function siteOrigin(siteUrl) {
  return new URL(siteUrl).origin;
}

// Users often paste a deep link to a specific library/folder view (e.g.
// ".../sites/cgiteam/Shared Documents/Forms/AllItems.aspx?id=...&viewid=...") instead of the
// site's root URL. The SharePoint REST API only works against the site root
// (origin + "/sites/<name>" or "/teams/<name>"), so normalize whatever was pasted down to that.
function normalizeSiteUrl(rawUrl) {
  const u = new URL(rawUrl);
  const match = u.pathname.match(/^\/(sites|teams)\/[^/]+/i);
  return match ? `${u.origin}${match[0]}` : u.origin;
}

// Builds an axios client that talks to a SharePoint site's REST API (_api/web/...) using the
// cookies from the user's logged-in Playwright browser session (no app registration needed).
async function sharePointClient(rawSiteUrl) {
  const siteUrl = normalizeSiteUrl(rawSiteUrl);
  const { page, context } = await getPage('ms');
  // Always (re)navigate to the site before grabbing cookies. A page that's already "on" the
  // right origin can still have an expired server-side session — only a fresh navigation tells
  // us for sure whether we're still logged in (it redirects to login.microsoftonline.com if not).
  await page.goto(siteUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  const finalUrl = page.url();
  if (/login\.microsoftonline\.com|login\.windows\.net/i.test(finalUrl)) {
    const err = new Error(
      'Your Microsoft login session has expired. Please click Login for Microsoft and sign in again.'
    );
    err.status = 401;
    throw err;
  }
  const cookies = await context.cookies(siteUrl);
  if (!cookies.length) {
    const err = new Error('Not logged in to Microsoft/SharePoint. Please login first.');
    err.status = 401;
    throw err;
  }
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const client = axios.create({
    baseURL: siteUrl.replace(/\/$/, ''),
    headers: {
      Cookie: cookieHeader,
      Accept: 'application/json;odata=verbose, application/json',
    },
  });
  // If the session cookies are stale/expired, SharePoint responds 200 with an HTML login page
  // instead of JSON — which previously looked like "zero results" instead of an auth failure.
  // Detect that here and surface it as a clear, actionable error.
  client.interceptors.response.use((response) => {
    if (typeof response.data === 'string') {
      const err = new Error(
        'SharePoint returned an HTML page instead of data — your Microsoft login session has likely expired. Please click Login for Microsoft again.'
      );
      err.status = 401;
      throw err;
    }
    return response;
  });
  return client;
}

// SharePoint REST can respond in either the legacy "verbose" shape ({ d: { results: [...] } })
// or the modern "minimal metadata" shape ({ value: [...] }) depending on tenant settings —
// read whichever one is present instead of assuming verbose.
function odataResults(data) {
  return data?.d?.results || data?.value || [];
}

// List document libraries on the given site. We fetch ALL lists (no server-side $filter, which
// can silently return zero rows if the tenant's OData conventions differ) and filter in code —
// much more reliable, and we log every list seen for diagnosis.
async function listLibraries(sp) {
  const { data } = await sp.get(
    '/_api/web/lists?$select=Title,BaseTemplate,Hidden,RootFolder/ServerRelativeUrl&$expand=RootFolder'
  );
  const all = odataResults(data);
  return all
    .filter((l) => Number(l.BaseTemplate) === 101 && !l.Hidden)
    .map((l) => ({ title: l.Title, folderUrl: l.RootFolder.ServerRelativeUrl }));
}

router.get('/libraries', async (req, res, next) => {
  try {
    const { siteUrl } = req.query;
    if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });
    const sp = await sharePointClient(siteUrl);
    res.json(await listLibraries(sp));
  } catch (err) {
    next(err);
  }
});

// Recursively search every document library on the site for subfolders whose name matches a SKU.
// No manual folder selection needed — just give the site URL and the list of SKUs.
router.post('/search-skus', async (req, res, next) => {
  try {
    const { siteUrl, skus } = req.body;
    if (!siteUrl || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({ error: 'siteUrl and skus[] are required' });
    }
    const sp = await sharePointClient(siteUrl);
    const remaining = new Map(skus.map((s) => [String(s).trim().toLowerCase(), String(s).trim()]));
    const found = new Map();
    const MAX_DEPTH = 8;
    const origin = siteOrigin(siteUrl);

    // Escapes single quotes per OData literal syntax ('' inside a '...' literal) and leaves
    // slashes/spaces alone — GetFolderByServerRelativeUrl expects the raw server-relative path.
    function odataFolderLiteral(folderUrl) {
      return folderUrl.replace(/'/g, "''");
    }

    // Fetches ALL subfolders of a folder, following OData pagination (the API caps each
    // response at 100 items by default, which is why deep/large libraries were missing folders).
    async function getAllSubfolders(folderUrl) {
      const all = [];
      let url =
        `/_api/web/GetFolderByServerRelativeUrl('${odataFolderLiteral(folderUrl)}')/Folders` +
        `?$select=Name,ServerRelativeUrl&$top=5000`;
      while (url) {
        const { data } = await sp.get(url);
        all.push(...odataResults(data));
        const next = data?.d?.__next || data?.['odata.nextLink'];
        url = next ? next.replace(sp.defaults.baseURL, '') : null;
      }
      return all;
    }

    // SharePoint folder names here carry a leading sort-order marker character (e.g. a superscript
    // glyph before "B1050"), so an exact-match comparison always failed even though the folder
    // existed. Normalize by keeping only alphanumeric characters before comparing.
    function normalize(name) {
      return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    const normalizedRemaining = new Map(
      [...remaining.entries()].map(([, original]) => [normalize(original), original])
    );

    // Diagnostics so we can see, when nothing matches, whether the scan actually reached the
    // folders and what names it saw (printed server-side and included in the API response).
    let foldersVisited = 0;
    const sampleNames = [];
    const errors = [];

    // Processes one folder: fetch its subfolders, check each against the remaining SKU list,
    // and return the ones that still need to be explored further (for the caller to enqueue).
    async function processFolder(currentFolderUrl, depth) {
      if (remaining.size === 0 || depth > MAX_DEPTH) return [];
      let children;
      try {
        children = await getAllSubfolders(currentFolderUrl);
      } catch (err) {
        errors.push({ folder: currentFolderUrl, error: err.response?.status || err.message });
        return [];
      }
      // Skip SharePoint's internal "Forms" folder (holds view/content-type definitions, not data).
      const realChildren = children.filter((c) => c.Name !== 'Forms');
      foldersVisited += realChildren.length;
      for (const child of realChildren) {
        if (sampleNames.length < 50) sampleNames.push(child.Name);
        const key = normalize(child.Name);
        const originalSku = normalizedRemaining.get(key);
        if (originalSku && remaining.has(originalSku.toLowerCase())) {
          found.set(originalSku, {
            sku: originalSku,
            webUrl: `${origin}${encodeURI(child.ServerRelativeUrl)}`,
          });
          remaining.delete(originalSku.toLowerCase());
          normalizedRemaining.delete(key);
        }
      }
      return realChildren;
    }

    // Bounded-concurrency BFS: instead of awaiting one folder at a time (slow — one network
    // round-trip after another), process up to CONCURRENCY folders in parallel per "wave",
    // still stopping immediately once every SKU has been found.
    const CONCURRENCY = 10;
    async function runQueue(initialItems) {
      let queue = initialItems;
      while (queue.length > 0 && remaining.size > 0) {
        const batch = queue.splice(0, CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map((item) => processFolder(item.folderUrl, item.depth))
        );
        if (remaining.size === 0) break;
        const nextItems = [];
        for (let i = 0; i < batch.length; i++) {
          for (const child of batchResults[i]) {
            nextItems.push({ folderUrl: child.ServerRelativeUrl, depth: batch[i].depth + 1 });
          }
        }
        queue = [...queue, ...nextItems];
      }
    }

    const libraries = await listLibraries(sp);
    await runQueue(libraries.map((lib) => ({ folderUrl: lib.folderUrl, depth: 0 })));

    const results = skus.map((sku) => {
      const trimmed = String(sku).trim();
      const match = found.get(trimmed);
      return match
        ? { sku: trimmed, found: true, webUrl: match.webUrl }
        : { sku: trimmed, found: false, webUrl: null };
    });

    console.log(
      `[search-skus] libraries=${libraries.map((l) => l.title).join(',')} foldersVisited=${foldersVisited} errors=${JSON.stringify(errors)} sampleNames=${JSON.stringify(sampleNames.slice(0, 20))}`
    );

    res.json({
      results,
      debug: { libraries: libraries.map((l) => l.title), foldersVisited, errors, sampleNames },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
