/** HTTP plumbing shared by adapters: retries, rate limits, JSON helpers, error mapping. */
import type { Http, HttpRequest, HttpResponse } from './types';
import { IntegrationError } from './types';

export interface RetryOptions {
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wraps an Http with retry: 429 honours Retry-After (capped at 60 s), 5xx backs off 1 s, 2 s, 4 s.
 * Transport errors from Rust are classified: "REAUTH:" → auth, "NETWORK:" → network.
 */
export function withRetry(http: Http, opts: RetryOptions = {}): Http {
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  return async (req) => {
    let attempt = 0;
    for (;;) {
      let res: HttpResponse;
      try {
        res = await http(req);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('REAUTH:'))
          throw new IntegrationError(msg.replace(/^.*REAUTH:\s*/, ''), 'auth');
        if (msg.includes('NETWORK:')) {
          if (attempt < retries) {
            await sleep(1000 * 2 ** attempt++);
            continue;
          }
          throw new IntegrationError(
            'Could not reach the provider. Check your connection.',
            'network',
          );
        }
        throw new IntegrationError(msg, 'provider');
      }
      if (res.status === 429 && attempt < retries) {
        const retryAfter = Number(res.headers['retry-after']);
        await sleep(
          Math.min(60, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt) *
            1000,
        );
        attempt++;
        continue;
      }
      if (res.status >= 500 && attempt < retries) {
        await sleep(1000 * 2 ** attempt++);
        continue;
      }
      return res;
    }
  };
}

export function expectOk(res: HttpResponse, what: string): HttpResponse {
  if (res.status >= 200 && res.status < 300) return res;
  if (res.status === 401 || res.status === 403) {
    throw new IntegrationError(
      `${what}: access was denied (${res.status}). Reconnect the account.`,
      'auth',
      res.status,
    );
  }
  if (res.status === 404 || res.status === 410)
    throw new IntegrationError(`${what}: not found (${res.status})`, 'gone', res.status);
  if (res.status === 429)
    throw new IntegrationError(
      `${what}: rate limited by the provider; will retry later`,
      'rate-limit',
      429,
    );
  throw new IntegrationError(
    `${what}: the provider answered ${res.status}. ${res.body.slice(0, 200)}`,
    'provider',
    res.status,
  );
}

export async function getJson<T>(
  http: Http,
  url: string,
  what: string,
  headers: [string, string][] = [],
): Promise<T> {
  const res = expectOk(
    await http({ method: 'GET', url, headers: [['Accept', 'application/json'], ...headers] }),
    what,
  );
  return JSON.parse(res.body) as T;
}

export async function sendJson<T>(
  http: Http,
  method: HttpRequest['method'],
  url: string,
  body: unknown,
  what: string,
  headers: [string, string][] = [],
): Promise<T | null> {
  const res = expectOk(
    await http({
      method,
      url,
      headers: [['Content-Type', 'application/json'], ['Accept', 'application/json'], ...headers],
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    what,
  );
  return res.body ? (JSON.parse(res.body) as T) : null;
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}
