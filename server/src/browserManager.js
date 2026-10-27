import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '.browser-data');

// Keeps one persistent, visible browser context per service ('ms' | 'monday') so that
// a user's login session is reused across app restarts (profile saved on disk).
const contexts = new Map(); // name -> { context, page }

export async function getContext(name) {
  let entry = contexts.get(name);
  if (entry && entry.context.browser()?.isConnected?.() !== false) {
    try {
      // sanity check the context is still usable
      entry.context.pages();
      return entry;
    } catch {
      contexts.delete(name);
    }
  }

  const userDataDir = path.join(DATA_DIR, name);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = context.pages()[0] || (await context.newPage());

  context.on('close', () => contexts.delete(name));

  entry = { context, page };
  contexts.set(name, entry);
  return entry;
}

export async function getPage(name) {
  const { context, page } = await getContext(name);
  if (page.isClosed()) {
    const newPage = await context.newPage();
    contexts.set(name, { context, page: newPage });
    return { context, page: newPage };
  }
  return { context, page };
}

export async function bringToFront(name) {
  const { page } = await getPage(name);
  await page.bringToFront();
  return page;
}

export async function clearSession(name) {
  const entry = contexts.get(name);
  if (!entry) return;
  await entry.context.clearCookies();
}

export async function closeAll() {
  for (const { context } of contexts.values()) {
    await context.close().catch(() => {});
  }
  contexts.clear();
}

process.on('SIGINT', async () => {
  await closeAll();
  process.exit(0);
});
