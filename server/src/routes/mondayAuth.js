import { Router } from 'express';
import { getPage, bringToFront, clearSession } from '../browserManager.js';

const router = Router();

const LOGIN_URL = 'https://auth.monday.com/users/sign_in';

function isLoginUrl(url) {
  return !url || url === 'about:blank' || /auth\.monday\.com\/users\/(sign_in|sign_up)/.test(url);
}

// Opens (or focuses) a real, persistent browser window at monday.com's login page.
// If the user already has a saved session in that browser profile, monday.com redirects
// straight to their account's boards. Otherwise they log in manually.
router.post('/login', async (req, res, next) => {
  try {
    const { page } = await getPage('monday');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Logged in if the browser's current URL is on a monday.com account subdomain (not the
// sign-in page). We derive the account slug from the URL for display purposes.
router.get('/status', async (req, res) => {
  try {
    const { page } = await getPage('monday');
    const url = page.url();
    if (isLoginUrl(url)) return res.json({ loggedIn: false });
    const match = url.match(/^https?:\/\/([a-z0-9-]+)\.monday\.com/i);
    res.json({ loggedIn: true, user: { name: match ? `Connected to "${match[1]}"` : 'monday.com' } });
  } catch (err) {
    res.json({ loggedIn: false });
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    await clearSession('monday');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/focus', async (req, res, next) => {
  try {
    await bringToFront('monday');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
