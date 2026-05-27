'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');

const DATA_DIR  = path.join(__dirname, 'data');
const CACHE_DIR = path.join(__dirname, 'cache');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'cs,sk;q=0.9,en;q=0.7',
};

const RESTAURANTS = [
  { id: 'suzies',   name: "Suzie's Steak Pub",   url: 'https://www.menicka.cz/3830-suzies-steak-pub.html',    type: 'menicka' },
  { id: 'seminar',  name: 'Hostinec U Semináru',  url: 'https://www.menicka.cz/3197-hostinec-u-seminaru.html', type: 'menicka' },
  { id: 'kormidlo', name: 'U Kormidla',            url: 'https://www.menicka.cz/6690-u-kormidla.html',          type: 'menicka' },
  { id: 'laguna',   name: 'Restaurace Laguna',     url: 'https://www.menicka.cz/2701-restaurace-laguna.html',   type: 'menicka' },
  { id: 'garden',   name: 'Garden Food Concept',   url: 'https://www.menicka.cz/6361-garden-food-concept.html', type: 'menicka' },
  { id: 'namaskar', name: 'Namaskar',               url: 'https://www.namaskar.cz/poledni-menu/',                type: 'generic' },
];

// ── Utils ────────────────────────────────────────────────────────────────────

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function fetchHtml(url) {
  const r = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return r.data;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseMenicka(html) {
  const $ = cheerio.load(html);
  const now = new Date(), day = now.getDate(), mon = now.getMonth() + 1;
  const items = [];

  $('.menicka').each((_, sec) => {
    const heading = $(sec).find('h2.nadpis, h2').first().text();
    const m = heading.match(/(\d{1,2})\.\s*(\d{1,2})/);
    if (!m || +m[1] !== day || +m[2] !== mon) return;

    $(sec).find('li.polevka, li.jidlo').each((_, li) => {
      const $li  = $(li);
      const name  = $li.find('.nazev').text().trim();
      const price = $li.find('.cena').text().trim().replace(/\s+/g, ' ');
      const num   = $li.find('.cislo').text().trim();
      if (name) items.push({ number: num, name, price, isSoup: $li.hasClass('polevka') });
    });
  });

  if (!items.length) {
    $('ul.jidla li').each((_, li) => {
      const $li  = $(li);
      const name  = $li.find('.nazev').text().trim();
      const price = $li.find('.cena').text().trim().replace(/\s+/g, ' ');
      const num   = $li.find('.cislo').text().trim();
      if (name) items.push({ number: num, name, price, isSoup: $li.hasClass('polevka') });
    });
  }
  return items;
}

function parseGeneric(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 2) return;
    const last  = cells.last().text().trim();
    const price = /^\d+/.test(last) ? last : '';
    const name  = (cells.length >= 3 ? cells.eq(1) : cells.eq(0)).text().trim();
    if (name && name.length > 3 && name.length < 180) items.push({ number: '', name, price, isSoup: false });
  });
  if (items.length > 2) return items;

  for (const sel of ['.entry-content', '.post-content', 'article', '.poledni-menu', '.lunch-menu']) {
    const el = $(sel).first();
    if (!el.length) continue;
    const lines = el.text().split('\n').map(l => l.trim()).filter(l => l.length > 4 && l.length < 180);
    if (lines.length > 2) {
      lines.forEach((l, i) => items.push({ number: `${i+1}.`, name: l, price: '', isSoup: false }));
      return items;
    }
  }

  return items;
}

// ── Scraping ─────────────────────────────────────────────────────────────────

async function scrapeOne(r) {
  try {
    console.log(`  ${r.name}…`);
    const html  = await fetchHtml(r.url);
    const items = r.type === 'menicka' ? parseMenicka(html) : parseGeneric(html);
    console.log(`    ✓ ${items.length} položek`);
    return { ...r, items, error: null };
  } catch (e) {
    console.error(`    ✗ ${e.message}`);
    return { ...r, items: [], error: e.message };
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────

async function loadLocalCache(date) {
  try {
    const raw = await fs.readFile(path.join(CACHE_DIR, `${date}.json`), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function saveData(date, data) {
  // 1. data/ — committed to git (the "database")
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, `${date}.json`), JSON.stringify(data, null, 2));

  // 2. Update data/index.json
  const indexPath = path.join(DATA_DIR, 'index.json');
  let index = { dates: [], lastUpdated: null };
  try { index = JSON.parse(await fs.readFile(indexPath, 'utf8')); } catch {}
  if (!index.dates.includes(date)) {
    index.dates = [date, ...index.dates].sort().reverse().slice(0, 120); // keep ~6 months
  }
  index.lastUpdated = new Date().toISOString();
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

  // 3. cache/ — local only, not committed
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(path.join(CACHE_DIR, `${date}.json`), JSON.stringify(data, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function getMenu({ forceRefresh = false } = {}) {
  const date = todayStr();

  if (!forceRefresh) {
    const cached = await loadLocalCache(date);
    if (cached) { console.log(`Using cache for ${date}`); return cached; }
  }

  console.log(`\nScraping menus for ${date}…\n`);
  const restaurants = await Promise.all(RESTAURANTS.map(scrapeOne));
  const data = { date, generatedAt: new Date().toISOString(), restaurants };

  await saveData(date, data);
  console.log(`\nSaved → data/${date}.json  +  data/index.json`);
  return data;
}

module.exports = { getMenu, todayStr };

if (require.main === module) {
  const force = process.argv.includes('--force');
  getMenu({ forceRefresh: force })
    .then(d => {
      console.log('\n=== Summary ===');
      d.restaurants.forEach(r => console.log(`  ${r.name}: ${r.error ?? `${r.items.length} položek`}`));
    })
    .catch(e => { console.error(e); process.exit(1); });
}
