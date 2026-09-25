// A local stand-in for a calendar-feed host, so the E2E suite can exercise the networked
// integration path (Rust fetch, credential store, sync, disconnect) without the internet.
// The app only accepts plain http:// here because KEEL_E2E_PROVIDER_BASE points at it.
import { createServer } from 'node:http';

export async function startMockProvider() {
  const requests = [];
  let feed = '';
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.method === 'GET' && req.url?.endsWith('.ics')) {
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' });
      res.end(feed);
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
