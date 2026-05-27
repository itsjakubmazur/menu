'use strict';

const express = require('express');
const path = require('path');
const { getMenu } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

// Kick off scraping at startup (non-blocking)
let menuPromise = getMenu();

app.get('/api/menu', async (req, res) => {
  try {
    const force = req.query.force === '1';
    if (force) menuPromise = getMenu({ forceRefresh: true });
    const data = await menuPromise;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\nMenu server running → http://localhost:${PORT}\n`);
});
