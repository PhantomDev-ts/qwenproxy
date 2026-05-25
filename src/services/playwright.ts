/*
 * File: playwright.ts
 * Improved persistent Playwright manager for QwenProxy
 */

import {
  chromium,
  firefox,
  webkit,
  BrowserContext,
  Page,
  Route,
  Request
} from 'playwright';

import path from 'path';
import crypto from 'crypto';

export type BrowserType =
  | 'chromium'
  | 'firefox'
  | 'webkit'
  | 'chrome'
  | 'edge';

let context: BrowserContext | null = null;
let initialized = false;

const PROFILE_PATH = path.resolve('qwen_profile');

const HEADERS_TTL = 1000 * 60 * 60;
const BROWSER_RESTART_INTERVAL = 1000 * 60 * 60;

let restartInterval: NodeJS.Timeout | null = null;

interface CachedHeaders {
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: string | null;
  createdAt: number;
}

let cachedHeaders: CachedHeaders | null = null;

const sleep = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

export class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }

    return new Promise(resolve => {
      this.queue.push(() => {
        resolve(() => this.release());
      });
    });
  }

  private release() {
    const next = this.queue.shift();

    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const authMutex = new Mutex();
const qwenMutex = new Mutex();

function getBrowserEngine(browserType: BrowserType) {
  switch (browserType) {
    case 'firefox':
      return {
        engine: firefox,
        channel: undefined
      };

    case 'webkit':
      return {
        engine: webkit,
        channel: undefined
      };

    case 'chrome':
      return {
        engine: chromium,
        channel: 'chrome'
      };

    case 'edge':
      return {
        engine: chromium,
        channel: 'msedge'
      };

    default:
      return {
        engine: chromium,
        channel: undefined
      };
  }
}

export async function initPlaywright(
  headless = true,
  browserType: BrowserType = 'chromium'
) {
  if (initialized) {
    return;
  }

  const { engine, channel } = getBrowserEngine(browserType);

  console.log(`[Playwright] Launching ${browserType}...`);

  context = await engine.launchPersistentContext(PROFILE_PATH, {
    headless,
    channel,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox'
    ]
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });

  initialized = true;

  await ensureAuthenticated();

  startBrowserAutoRestart();

  console.log('[Playwright] Initialized successfully');
}

function startBrowserAutoRestart() {
  if (restartInterval) {
    clearInterval(restartInterval);
  }

  restartInterval = setInterval(async () => {
    console.log('[Playwright] Scheduled browser restart...');

    try {
      await restartBrowser();
    } catch (err) {
      console.error('[Playwright] Restart failed:', err);
    }
  }, BROWSER_RESTART_INTERVAL);
}

export async function restartBrowser() {
  await closePlaywright();
  await initPlaywright(true);
}

export async function closePlaywright() {
  initialized = false;

  if (restartInterval) {
    clearInterval(restartInterval);
    restartInterval = null;
  }

  if (context) {
    await context.close().catch(() => {});
    context = null;
  }
}

export async function createPage(): Promise<Page> {
  if (!context) {
    throw new Error('Playwright context not initialized');
  }

  return context.newPage();
}

async function ensureAuthenticated() {
  const release = await authMutex.acquire();

  try {
    const page = await createPage();

    try {
      await page.goto('https://chat.qwen.ai/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      const isLoggedOut =
        page.url().includes('login') ||
        page.url().includes('auth');

      if (!isLoggedOut) {
        return;
      }

      const email = process.env.QWEN_EMAIL;
      const password = process.env.QWEN_PASSWORD;

      if (!email || !password) {
        throw new Error('Missing QWEN_EMAIL or QWEN_PASSWORD');
      }

      const success = await loginToQwen(page, email, password);

      if (!success) {
        throw new Error('Failed to login');
      }
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    release();
  }
}

async function loginToQwen(
  page: Page,
  email: string,
  password: string
): Promise<boolean> {
  console.log('[Playwright] Attempting API login...');

  await page.goto('https://chat.qwen.ai/auth', {
    waitUntil: 'domcontentloaded'
  });

  const hashedPassword = crypto
    .createHash('sha256')
    .update(password)
    .digest('hex');

  const result = await page.evaluate(
    async ({ email, password }) => {
      try {
        const response = await fetch(
          'https://chat.qwen.ai/api/v2/auths/signin',
          {
            method: 'POST',
            headers: {
              accept: 'application/json, text/plain, */*',
              'content-type': 'application/json',
              source: 'web',
              timezone: new Date().toString().split(' (')[0],
              'x-request-id': crypto.randomUUID()
            },
            body: JSON.stringify({
              email,
              password,
              login_type: 'email'
            })
          }
        );

        const data = await response.json();

        return {
          ok: response.ok,
          data
        };
      } catch (err: any) {
        return {
          ok: false,
          error: err.message
        };
      }
    },
    {
      email,
      password: hashedPassword
    }
  );

  if (!result.ok) {
    console.error('[Playwright] Login failed:', result);
    return false;
  }

  await page.goto('https://chat.qwen.ai/', {
    waitUntil: 'domcontentloaded'
  });

  return (
    !page.url().includes('auth') &&
    !page.url().includes('login')
  );
}

export async function getCookies(): Promise<string> {
  if (!context) {
    throw new Error('Context not initialized');
  }

  const cookies = await context.cookies();

  return cookies
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export async function getQwenHeaders(forceRefresh = false) {
  const release = await qwenMutex.acquire();

  try {
    if (
      !forceRefresh &&
      cachedHeaders &&
      Date.now() - cachedHeaders.createdAt < HEADERS_TTL
    ) {
      return cachedHeaders;
    }

    const page = await createPage();

    let intercepted = false;

    try {
      await page.goto('https://chat.qwen.ai/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      await page.waitForSelector(
        'textarea, [contenteditable="true"]',
        {
          timeout: 30000
        }
      );

      const result = await new Promise<{
        headers: Record<string, string>;
        chatSessionId: string;
        parentMessageId: string | null;
      }>(async (resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timed out waiting for Qwen headers'));
        }, 30000);

        const routeHandler = async (
          route: Route,
          request: Request
        ) => {
          if (intercepted) {
            await route.continue();
            return;
          }

          intercepted = true;

          try {
            clearTimeout(timeout);

            const reqHeaders = request.headers();

            let chatSessionId = '';
            let parentMessageId: string | null = null;

            const postData = request.postData();

            if (postData) {
              try {
                const payload = JSON.parse(postData);

                chatSessionId = payload.chat_id || '';
                parentMessageId = payload.parent_id || null;
              } catch {}
            }

            const extractedHeaders = {
              cookie: reqHeaders.cookie || '',
              'bx-ua': reqHeaders['bx-ua'] || '',
              'bx-umidtoken': reqHeaders['bx-umidtoken'] || '',
              'bx-v': reqHeaders['bx-v'] || '',
              'user-agent': reqHeaders['user-agent'] || '',
              'x-request-id': reqHeaders['x-request-id'] || ''
            };

            await route.abort();

            resolve({
              headers: extractedHeaders,
              chatSessionId,
              parentMessageId
            });
          } catch (err) {
            reject(err);
          }
        };

        await page.route(
          '**/api/v2/chat/completions*',
          routeHandler
        );

        try {
          const inputSelector =
            'textarea, [contenteditable="true"]';

          await page.focus(inputSelector);

          await page.keyboard.type('a', {
            delay: 50
          });

          await sleep(1000);

          await page.keyboard.press('Enter');
        } catch (err) {
          reject(err);
        }
      });

      cachedHeaders = {
        ...result,
        createdAt: Date.now()
      };

      return result;
    } finally {
      try {
        await page.unroute('**/api/v2/chat/completions*');
      } catch {}

      await page.close().catch(() => {});
    }
  } finally {
    release();
  }
}

export async function browserHealth() {
  try {
    if (!context) {
      return {
        ok: false,
        reason: 'Browser not initialized'
      };
    }

    const page = await createPage();

    try {
      await page.goto('https://chat.qwen.ai/', {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });

      return {
        ok: true,
        url: page.url()
      };
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err: any) {
    return {
      ok: false,
      error: err.message
    };
  }
}

export async function getBasicHeaders(): Promise<{
  cookie: string;
  userAgent: string;
  bxV: string;
}> {
  if (!context) {
    throw new Error('Context not initialized');
  }

  const cookies = await context.cookies();
  const cookie = cookies
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  const userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  let bxV = '';

  try {
    const page = await createPage();

    try {
      await page.goto('https://chat.qwen.ai/', {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });

      const bxVCookie = cookies.find(c => c.name === 'bx-v');
      if (bxVCookie) {
        bxV = bxVCookie.value;
      }
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err) {
    console.warn('[Playwright] Failed to get bx-v:', err);
  }

  return {
    cookie,
    userAgent,
    bxV
  };
}
