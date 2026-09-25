// A local stand-in for a calendar-feed host, so the E2E suite can exercise the networked
// integration path (Rust fetch, credential store, sync, disconnect) without the internet.
// The app only accepts plain http:// here because KEEL_E2E_PROVIDER_BASE points at it.
// It also plays GitHub for the update wizard (KEEL_E2E_UPDATE_BASE): a latest release whose
// asset downloads redirect to a separate download path, as GitHub's do.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export const UPDATE_REPO = 'yalijore/project-';
export const UPDATE_INSTALLER = Buffer.from(
  'MZ fake Keel installer for the E2E suite\n'.repeat(2000),
);
const INSTALLER_NAME = 'Keel_9.9.9_x64-setup.exe';

export async function startMockProvider() {
  const requests = [];
  let feed = '';
  const sums = `${createHash('sha256').update(UPDATE_INSTALLER).digest('hex')}  ${INSTALLER_NAME}\n`;
  const assets = [
    { id: 11, name: INSTALLER_NAME, size: UPDATE_INSTALLER.length, body: UPDATE_INSTALLER },
    { id: 12, name: 'SHA256SUMS.txt', size: sums.length, body: Buffer.from(sums) },
  ];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    const url = req.url ?? '';
    if (req.method === 'GET' && url.endsWith('.ics')) {
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' });
      res.end(feed);
      return;
    }
    const authorized = req.headers.authorization === 'Bearer github_pat_e2e_0123456789abcdef';
    if (url === `/repos/${UPDATE_REPO}/releases/latest`) {
      if (!authorized) return void res.writeHead(401).end();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          tag_name: 'v9.9.9',
          name: 'Keel 9.9.9',
          body: '**Focus**\n\n- A test release served by the E2E mock.',
          published_at: '2026-09-25T12:00:00Z',
          html_url: `https://github.com/${UPDATE_REPO}/releases/tag/v9.9.9`,
          assets: assets.map(({ id, name, size }) => ({ id, name, size })),
        }),
      );
      return;
    }
    const asset = /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/.exec(url);
    if (asset) {
      if (!authorized) return void res.writeHead(401).end();
      // Like GitHub: a redirect to a download URL that needs no token.
      res.writeHead(302, { location: `http://${req.headers.host}/download/${asset[1]}` });
      res.end();
      return;
    }
    const download = /^\/download\/(\d+)$/.exec(url);
    if (download) {
      const a = assets.find((x) => String(x.id) === download[1]);
      if (!a) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': a.size });
      res.end(a.body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    setFeed(text) {
      feed = text;
    },
    close: () => server.close(),
  };
}

export function icsFeed(events) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'X-WR-CALNAME:E2E feed',
    ...events.flatMap((e) => [
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `SUMMARY:${e.title}`,
      `DTSTART;VALUE=DATE:${e.date}`,
      `DTEND;VALUE=DATE:${e.end}`,
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ].join('\r\n');
}
