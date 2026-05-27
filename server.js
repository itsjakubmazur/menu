'use strict';

// Local dev server — serves index.html + menu.json statically.
// Run: node scraper.js && node server.js

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MIME = { '.html':'text/html', '.json':'application/json', '.js':'text/javascript', '.css':'text/css' };

http.createServer((req, res) => {
  const file = req.url === '/' ? 'index.html' : req.url.split('?')[0].replace(/^\//, '');
  const filePath = path.join(__dirname, file);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
