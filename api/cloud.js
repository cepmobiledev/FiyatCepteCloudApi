// cloud.js - Yasal benzinlik sitelerinden fiyatları scrape eden Vercel Serverless API
// Routes: /api/health, /api/prices, /api/update, /api/source
// Tüm büyük markalar destekleniyor + KV cache + Cron job uyumlu

// ---------------- KV (Upstash/Vercel KV REST) ----------------
async function redisCmd(args) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  
  if (!url || !token) {
    console.error('KV env missing');
    return { ok: false, result: null, error: 'KV env missing' };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });

    if (!response.ok) {
      return { ok: false, result: null, error: `KV HTTP ${response.status}` };
    }

    const json = await response.json();
    if (json.error) return { ok: false, result: null, error: String(json.error) };
    return { ok: true, result: json.result, error: null };
  } catch (e) {
    return { ok: false, result: null, error: String(e.message) };
  }
}

async function kvGetJson(key) {
  const { ok, result } = await redisCmd(['GET', key]);
  if (!ok || result == null) return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

async function kvSetJson(key, value) {
  const payload = JSON.stringify(value);
  const { ok } = await redisCmd(['SET', key, payload]);
  return ok;
}

// ---------------- Helpers ----------------
function normalizeCityKey(input) {
  if (!input) return '';
  return String(input)
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U')
    .replace(/Ş/g, 'S')
    .replace(/İ/g, 'I')
    .replace(/Ö/g, 'O')
    .replace(/Ç/g, 'C')
    .replace(/[^A-Z0-9\s]/g, '')
    .replace(/\s+/g, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parsePrice(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/[^\d,]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isFinite(num) ? num : null;
}

// ---------------- Scraper Fonksiyonları - GÜNCEL ----------------
const SCRAPERS = {
  PETROLOFISI: async () => {
    try {
      const res = await fetch('https://www.petrolofisi.com.tr/akaryakit-fiyatlari', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const html = await res.text();
      
      const prices = {};
      const cityRegex = /data-district-name="([^"]+)"[^>]*class="price-row"[\s\S]*?<\/tr>/gi;
      let match;
      
      while ((match = cityRegex.exec(html)) !== null) {
        const cityName = match[1].trim().replace(/[()]/g, '');
        const cityKey = normalizeCityKey(cityName);
        const rowHtml = match[0];
        
        const spans = [...rowHtml.matchAll(/<span class="with-tax">([\d,]+)<\/span>/g)];
        if (spans.length >= 2) {
          prices[cityKey] = {
            benzin: parsePrice(spans[0]?.[1]),
            motorin: parsePrice(spans[1]?.[1]),
            lpg: spans[6]?.[1] ? parsePrice(spans[6][1]) : null
          };
        }
      }
      return Object.keys(prices).length ? prices : null;
    } catch {
      return null;
    }
  },

  OPET: async () => {
    try {
      const res = await fetch('https://www.opet.com.tr/akaryakit-fiyatlari', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const html = await res.text();
      
      const prices = {};
      const cityRegex = /data-city="([^"]+)"[\s\S]*?<\/tr>/gi;
      let match;
      
      while ((match = cityRegex.exec(html)) !== null) {
        const cityName = match[1].replace(/\s*\([^)]*\)/, '').trim();
        const cityKey = normalizeCityKey(cityName);
        const rowHtml = match[0];
        const tds = [...rowHtml.matchAll(/<td[^>]*>(\d+,\d+)<\/td>/g)];
        
        if (tds.length >= 2) {
          prices[cityKey] = {
            benzin: parsePrice(tds[0]?.[1]),
            motorin: parsePrice(tds[1]?.[1]),
            lpg: tds[2]?.[1] ? parsePrice(tds[2][1]) : null
          };
        }
      }
      return Object.keys(prices).length ? prices : null;
    } catch {
      return null;
    }
  },

  SHELL: async () => {
    try {
      const res = await fetch('https://www.shell.com.tr/tuketici-istasyonlari/akaryakit-fiyatlari.html', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const html = await res.text();
      
      const prices = {};
      const rows = html.match(/<tr[^>]*>(?:<td[^>]*>.*?<\/td>){4,}<\/tr>/gi) || [];
      
      for (const row of rows) {
        const tds = [...row.matchAll(/<td[^>]*>([^<]+)<\/td>/g)];
        if (tds.length >= 4) {
          const cityName = tds[0][1].trim();
          const cityKey = normalizeCityKey(cityName);
          const priceTds = tds.slice(1).map(td => parsePrice(td[1]));
          
          if (priceTds[0] || priceTds[1]) {
            prices[cityKey] = {
              benzin: priceTds[0],
              motorin: priceTds[1],
              lpg: priceTds[2] || null
            };
          }
        }
      }
      return Object.keys(prices).length ? prices : null;
    } catch {
      return null;
    }
  },

  AYTEMIZ: async () => {
    try {
      const res = await fetch('https://www.aytemiz.com.tr/akaryakit-fiyatlari', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const html = await res.text();
      
      const prices = {};
      const cityRegex = /<tr[^>]*>(?:<td[^>]*>.*?<\/td>){3,}<\/tr>/gi;
      let match;
      
      while ((match = cityRegex.exec(html)) !== null) {
        const tds = [...match[0].matchAll(/<td[^>]*>([^<]+)<\/td>/g)];
        if (tds.length >= 4) {
          const cityName = tds[0][1].trim();
          const cityKey = normalizeCityKey(cityName);
          
          prices[cityKey] = {
            benzin: parsePrice(tds[1]?.[1]),
            motorin: parsePrice(tds[2]?.[1]),
            lpg: parsePrice(tds[3]?.[1])
          };
        }
      }
      return Object.keys(prices).length ? prices : null;
    } catch {
      return null;
    }
  },

  TOTAL: async () => {
    try {
      const res = await fetch('https://www.totalenergies.com.tr/akaryakit-fiyatlari', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const html = await res.text();
      
      const prices = {};
      const rows = html.match(/<tr[^>]*>(?:<[^>]*>.*?<\/[^>]*>){3,}<\/tr>/gi) || [];
      
      for (const row of rows) {
        const tds = [...row.matchAll(/<td[^>]*>([^<>\d,\s]*[\d,]+\.?\d*)<\/td>/g)];
        if (tds.length >= 3) {
          const cityName = tds[0][1].trim();
          const cityKey = normalizeCityKey(cityName);
          
          prices[cityKey] = {
            benzin: parsePrice(tds[1]?.[1]),
            motorin: parsePrice(tds[2]?.[1]),
            lpg: null
          };
        }
      }
      return Object.keys(prices).length ? prices : null;
    } catch {
      return null;
    }
  }
};

// ---------------- Ana İşlemler ----------------
async function scrapeAllPrices() {
  const allResults = {};
  const sources = [];
  
  // Tüm scraper'ları paralel çalıştır
  const scraperPromises = Object.entries(SCRAPERS).map(async ([marka, scraper]) => {
    try {
      await sleep(500); // Rate limiting
      const result = await scraper();
      if (result) {
        allResults[marka] = result;
        sources.push(marka.toLowerCase());
      }
    } catch (e) {
      console.error(`${marka} scraper error:`, e.message);
    }
  });
  
  await Promise.all(scraperPromises);
  
  const data = {
    allFirmPrices: allResults,
    lastUpdate: new Date().toISOString(),
    sources,
    cities: Object.keys(allResults.PETROLOFISI || {}).length
  };
  
  await kvSetJson('fuel:prices', data);
  return data;
}

// ---------------- API Handlers ----------------
async function handleHealth(req, res) {
  const kvData = await kvGetJson('fuel:prices');
  const hasData = !!kvData?.allFirmPrices;
  
  res.status(200).json({
    ok: true,
    hasData,
    lastUpdate: kvData?.lastUpdate,
    sources: kvData?.sources || []
  });
}

async function handlePrices(req, res) {
  const kvData = await kvGetJson('fuel:prices');
  
  if (kvData?.allFirmPrices) {
    // Query params ile filtreleme
    const url = new URL(req.url, 'http://localhost');
    const city = normalizeCityKey(url.searchParams.get('city'));
    
    let filtered = kvData.allFirmPrices;
    if (city) {
      filtered = {};
      for (const [marka, cities] of Object.entries(kvData.allFirmPrices)) {
        if (cities[city]) {
          filtered[marka] = { [city]: cities[city] };
        }
      }
    }
    
    res.status(200).json({
      prices: filtered,
      lastUpdate: kvData.lastUpdate,
      sources: kvData.sources
    });
  } else {
    res.status(200).json({ prices: {}, lastUpdate: null, sources: [] });
  }
}

async function handleUpdate(req, res) {
  const result = await scrapeAllPrices();
  res.status(200).json({ ok: true, ...result });
}

// ---------------- Main Export ----------------
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const path = url.pathname;
  
  if (path === '/api/health') return handleHealth(req, res);
  if (path === '/api/prices') return handlePrices(req, res);
  if (path === '/api/update') return handleUpdate(req, res);
  
  // Default: prices
  return handlePrices(req, res);
};
