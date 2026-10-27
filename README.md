# SKU → SharePoint → Monday.com Linker

A small webapp that:
1. Takes one or more SKU numbers from the user.
2. Lets the user browse and pick a root folder in a SharePoint site.
3. Recursively searches that folder for subfolders named after each SKU and returns their SharePoint links.
4. After user confirmation, drives the real Monday.com board UI to find each SKU's item and paste the link into a chosen "Post" (link-type) column.

**No Azure AD app registration and no Monday.com OAuth app are required.** Login is done by opening a real, persistent browser window (via Playwright):
- If you're already logged into Microsoft/SharePoint or Monday.com in that browser profile, the app detects it and connects immediately.
- Otherwise you log in manually once (same as any normal browser tab); your session is saved to disk (`server/.browser-data/`) and reused automatically next time you start the app — no need to log in again.

## Project layout
- `server/` — Node/Express backend. Uses Playwright persistent browser contexts for login/session reuse, the SharePoint `_api/web` REST API (authenticated via the browser's cookies) for folder browsing/search, and Playwright UI automation to update Monday.com.
- `client/` — React (Vite) frontend.

## 1. Install & run
```
# Backend
cd server
npm install
npx playwright install chromium   # one-time: downloads the Chromium browser Playwright drives
npm run dev        # http://localhost:4000

# Frontend (separate terminal)
cd client
npm install
npm run dev         # http://localhost:5173
```
Open http://localhost:5173 in your browser.

## 2. Using the app
1. Click **Login** next to "Microsoft / SharePoint" — a real Chromium window opens. If you're already signed in there, it's detected automatically; otherwise sign in with your normal Microsoft/SharePoint account.
2. Click **Login** next to "Monday.com" — same idea, opens monday.com's sign-in page in the browser window.
3. Enter one or more SKUs (comma or newline separated).
4. Enter your SharePoint **site URL** (e.g. `https://yourtenant.sharepoint.com/sites/yoursite`) and click "Load", then browse Document Library → folder tree and click "Use this folder as root".
5. Click "Search SharePoint for SKU folders". Results show which SKUs were found and their link; you can edit/uncheck rows before continuing.
6. Enter the Monday.com **board URL** and the name of the link column to update (e.g. "Post").
7. Click "Update" — the app opens the board, finds each item by searching for the SKU text, clicks the named column's cell, and pastes in the link, then reports success/not-found/error per SKU.

## Notes & limitations
- The browser window used for login/automation stays open between actions — don't close it manually, or the app will reopen a new one (which may require logging in again if the profile folder was removed).
- SharePoint folder search matches folder names case-insensitively, searching up to 8 levels deep under the chosen root.
- Monday.com UI automation locates SKUs by searching for the exact SKU text visible in the board's grid, then finds the target column either by its `aria-label` or by matching the column header text — if Monday.com changes its page layout, this may need adjusting (see `server/src/routes/monday.js`).
- This approach intentionally avoids Azure AD / Monday OAuth app registrations; the tradeoff is that Monday.com updates happen via (slower, more fragile) UI automation rather than a direct API call, since Monday's API requires a token and does not accept browser session cookies.
