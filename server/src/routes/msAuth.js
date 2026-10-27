import { Router } from 'express';
import { getPage, bringToFront, clearSession } from '../browserManager.js';

const router = Router();

const LOGIN_URL = 'https://login.microsoftonline.com/';

function isLoginUrl(url) {
  return !url || url === 'about:blank' || /login\.microsoftonline\.com/.test(url);
}

// Opens (or focuses) a real, persistent browser window at Microsoft's login page.
// If the user already has a saved session in that browser profile, it's reused automatically;
// otherwise they log in manually once and it persists across app restarts.
router.post('/login', async (req, res, next) => {
  try {
    const { siteUrl } = req.body || {};
    const { page } = await getPage('ms');
    await page.goto(siteUrl || LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Logged in if the browser isn't sitting on the Microsoft login page.
router.get('/status', async (req, res) => {
  try {
    const { page } = await getPage('ms');
    const url = page.url();
    res.json({ loggedIn: !isLoginUrl(url) });
  } catch (err) {
    res.json({ loggedIn: false });
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    await clearSession('ms');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/focus', async (req, res, next) => {
  try {
    await bringToFront('ms');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
