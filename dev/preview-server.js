// Serves a saved SubCentral "Available Jobs" page with the extension's scripts added, so the UI can be
// tried in a normal browser tab without loading the extension into Chrome.
//
//   node dev/preview-server.js ["/path/to/Available Jobs _  SmartFind Express _ PowerSchool.html"]
//
// Then open http://localhost:8765. Edits to background.js / content.js show up on reload.
// Add ?plain to the URL to see the saved page without the extension.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8765;
const EXT_DIR = path.resolve(__dirname, '..');

function findSavedPage() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const parent = path.dirname(EXT_DIR);
  const hit = fs.readdirSync(parent).find(f => /^Available Jobs.*\.html$/i.test(f));
  if (!hit) {
    console.error('No saved page found. In Chrome, open SubCentral Available Jobs, press Cmd+S (Ctrl+S on Windows),');
    console.error('save it as "Webpage, Complete", then run: node dev/preview-server.js "/path/to/the/saved.html"');
    process.exit(1);
  }
  return path.join(parent, hit);
}
const SAVED_PAGE = findSavedPage();
const SAVED_DIR = path.dirname(SAVED_PAGE);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };

function sendFile(res, root, rel) {
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// Saved pages are usually windows-1252; latin1 round-trips every byte unchanged, and the page's own <meta> picks the charset.
function previewPage(plain) {
  let html = fs.readFileSync(SAVED_PAGE, 'latin1');
  // the site's own scripts (session timeouts, redirects) would fight the preview
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  // Chrome saves extension panels (shadow DOM) into the page; drop them so only the current code's panel shows
  html = html.replace(/<template\s+shadowrootmode\b[\s\S]*?<\/template>/gi, '');
  html = html.replace(/<head([^>]*)>/i, '<head$1><base href="/saved/">');
  // the saved copy keeps the jobs table hidden the way the extension left it
  if (plain) return html.replace(/(<table\b[^>]*id="substituteAvailableJobActionTable[^"]*"[^>]*?)\s*style="display:\s*none;?"/i, '$1');
  const inject = ['dev/chrome-shim.js', 'background.js', 'content.js'].map(f => `<script src="/ext/${f}"></script>`).join('\n');
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${inject}\n</body>`) : html + inject;
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = decodeURIComponent(url.pathname);
  // served at the real page's path, so content.js treats it as a results page
  if (p === '/' ) { res.writeHead(302, { Location: '/substituteAvailableJobAction.do' }).end(); return; }
  if (p === '/substituteAvailableJobAction.do') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(Buffer.from(previewPage(url.searchParams.has('plain')), 'latin1'));
    } catch (e) { res.writeHead(500).end(e.message); }
    return;
  }
  if (p.startsWith('/ext/')) return sendFile(res, EXT_DIR, p.slice(5));
  if (p.startsWith('/saved/')) return sendFile(res, SAVED_DIR, p.slice(7));
  res.writeHead(404).end();
}).listen(PORT, () => {
  console.log(`Preview of ${path.basename(SAVED_PAGE)}`);
  console.log(`Open http://localhost:${PORT}  (Ctrl+C to stop)`);
});
