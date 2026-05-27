'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'cache');
const MENU_FILE = path.join(__dirname, 'menu.json');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'cs,sk;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
};

const MENICKA_RESTAURANTS = [
  { id: 'suzies',   name: "Suzie's Steak Pub",    url: 'https://www.menicka.cz/3830-suzies-steak-pub.html' },
  { id: 'seminar',  name: 'Hostinec U Semináru',   url: 'https://www.menicka.cz/3197-hostinec-u-seminaru.html' },
  { id: 'kormidlo', name: 'U Kormidla',             url: 'https://www.menicka.cz/6690-u-kormidla.html' },
  { id: 'laguna',   name: 'Restaurace Laguna',      url: 'https://www.menicka.cz/2701-restaurace-laguna.html' },
  { id: 'garden',   name: 'Garden Food Concept',    url: 'https://www.menicka.cz/6361-garden-food-concept.html' },
];

// Namaskar: scrape their own website
const NAMASKAR = {
  id: 'namaskar',
  name: 'Namaskar',
  url: 'https://www.namaskar.cz/poledni-menu/',
  fallbackUrl: 'https://www.namaskar.cz/',
};

// ── Utilities ────────────────────────────────────────────────────────────────

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchHtml(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return res.data;
}

async function loadCache(date) {
  try {
    const raw = await fs.readFile(path.join(CACHE_DIR, `${date}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveCache(date, data) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(path.join(CACHE_DIR, `${date}.json`), JSON.stringify(data, null, 2));
}

// ── menicka.cz parser ────────────────────────────────────────────────────────

function parseMenicka(html) {
  const $ = cheerio.load(html);
  const now = new Date();
  const todayDay = now.getDate();
  const todayMonth = now.getMonth() + 1;

  const items = [];

  // Primary strategy: find the .menicka section whose .nadpis heading
  // contains today's date (e.g. "Pondělí 27. 5." or "27.5.2024")
  let todaySectionFound = false;

  $('.menicka').each((_, section) => {
    const $section = $(section);
    const headingText = $section.find('h2.nadpis, h2').first().text();

    const match = headingText.match(/(\d{1,2})\.\s*(\d{1,2})/);
    if (!match) return;

    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);

    if (day !== todayDay || month !== todayMonth) return;

    todaySectionFound = true;

    $section.find('li.polevka, li.jidlo').each((_, li) => {
      const $li = $(li);
      const name  = $li.find('.nazev').text().trim();
      const price = $li.find('.cena').text().trim().replace(/\s+/g, ' ');
      const num   = $li.find('.cislo').text().trim();
      const isSoup = $li.hasClass('polevka');

      if (name) items.push({ number: num, name, price, isSoup });
    });
  });

  // Fallback: look for any .jidla / .jidlo on the page (happens when the
  // whole page already shows only today's menu or structure differs)
  if (!todaySectionFound) {
    $('ul.jidla li').each((_, li) => {
      const $li = $(li);
      const name  = $li.find('.nazev').text().trim();
      const price = $li.find('.cena').text().trim().replace(/\s+/g, ' ');
      const num   = $li.find('.cislo').text().trim();
      const isSoup = $li.hasClass('polevka');

      if (name) items.push({ number: num, name, price, isSoup });
    });
  }

  return items;
}

// ── Namaskar parser ──────────────────────────────────────────────────────────

function parseNameaskar(html) {
  const $ = cheerio.load(html);
  const items = [];

  // Strategy 1: table rows that look like menu entries (number + name + price)
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length >= 2) {
      const first = cells.eq(0).text().trim();
      const second = cells.eq(1).text().trim();
      const last = cells.last().text().trim();
      const price = last.match(/\d+/) ? last : '';
      const name = cells.length >= 3 ? second : first;
      if (name && name.length > 3 && name.length < 200) {
        items.push({ number: first, name, price, isSoup: false });
      }
    }
  });

  if (items.length > 0) return items;

  // Strategy 2: look for a section/div that contains the weekly menu
  // Common patterns on Czech restaurant sites
  const menuContainerSelectors = [
    '.menu-content', '.lunch-menu', '.poledni-menu', '.weekly-menu',
    '.entry-content', '.post-content', '.page-content', 'article',
    '.wp-block-group', '.elementor-widget-text-editor',
  ];

  for (const sel of menuContainerSelectors) {
    const $container = $(sel).first();
    if (!$container.length) continue;

    const text = $container.text().trim();
    if (text.length < 20) continue;

    // Extract lines that look like menu items
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3 && l.length < 200);
    lines.forEach((line, i) => {
      items.push({ number: `${i + 1}.`, name: line, price: '', isSoup: false });
    });

    if (items.length > 0) return items;
  }

  // Strategy 3: paragraphs / list items with food-like content
  $('p, li').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 5 && text.length < 200) {
      items.push({ number: '', name: text, price: '', isSoup: false });
    }
  });

  return items.slice(0, 30); // cap to avoid noise
}

// ── Scrapers ─────────────────────────────────────────────────────────────────

async function scrapeMenicka(restaurant) {
  try {
    console.log(`  Scraping ${restaurant.name}...`);
    const html = await fetchHtml(restaurant.url);
    const items = parseMenicka(html);
    console.log(`    ✓ ${items.length} položek`);
    return { ...restaurant, items, error: null, scrapedAt: new Date().toISOString() };
  } catch (err) {
    console.error(`    ✗ ${restaurant.name}: ${err.message}`);
    return { ...restaurant, items: [], error: err.message, scrapedAt: new Date().toISOString() };
  }
}

async function scrapeNameaskar() {
  const result = { ...NAMASKAR, items: [], error: null, scrapedAt: new Date().toISOString() };
  console.log(`  Scraping Namaskar...`);

  for (const url of [NAMASKAR.url, NAMASKAR.fallbackUrl]) {
    try {
      const html = await fetchHtml(url);
      const items = parseNameaskar(html);
      if (items.length > 0) {
        result.url = url;
        result.items = items;
        console.log(`    ✓ ${items.length} položek (${url})`);
        return result;
      }
    } catch (err) {
      // try next URL
    }
  }

  result.error = 'Nepodařilo se načíst menu z namaskar.cz';
  console.warn(`    ✗ Namaskar: ${result.error}`);
  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function scrapeAll() {
  const date = todayStr();
  console.log(`\nScraping menus for ${date}...\n`);

  const [menickaResults, namaskar] = await Promise.all([
    Promise.all(MENICKA_RESTAURANTS.map(scrapeMenicka)),
    scrapeNameaskar(),
  ]);

  return {
    date,
    generatedAt: new Date().toISOString(),
    restaurants: [...menickaResults, namaskar],
  };
}

async function getMenu({ forceRefresh = false } = {}) {
  const date = todayStr();

  if (!forceRefresh) {
    const cached = await loadCache(date);
    if (cached) {
      console.log(`Using cached data for ${date}`);
      return cached;
    }
  }

  const data = await scrapeAll();

  await saveCache(date, data);
  await fs.writeFile(MENU_FILE, JSON.stringify(data, null, 2));
  console.log(`\nSaved → menu.json  (cache/${date}.json)`);

  return data;
}

module.exports = { getMenu, todayStr };

// Run as CLI: node scraper.js [--force]
if (require.main === module) {
  const force = process.argv.includes('--force');
  getMenu({ forceRefresh: force })
    .then(data => {
      console.log('\n=== Summary ===');
      data.restaurants.forEach(r => {
        const status = r.error ? `ERROR: ${r.error}` : `${r.items.length} položek`;
        console.log(`  ${r.name}: ${status}`);
      });
    })
    .catch(err => {
      console.error('Fatal:', err);
      process.exit(1);
    });
}
