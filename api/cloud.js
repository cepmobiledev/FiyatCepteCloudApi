// api/cloud.js
// Pompa fiyatları (KV cache + cron uyumlu)
// ŞU AN AKTİF: Aytemiz (statik HTML parse)
// DEVRE DIŞI: Petrol Ofisi (JS render, JSON endpoint bulmak gerek), Shell

const MAX_AGE_HOURS = 12;

///////////////////////////
// KV (Upstash/Vercel KV REST)
///////////////////////////
async function redisCmd(args) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;

  if (!url || !token) return { ok: false, result: null, error: "KV env missing" };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) return { ok: false, result: null, error: `KV HTTP ${response.status}` };

    const json = await response.json().catch(() => null);
    if (!json) return { ok: false, result: null, error: "KV bad json" };
    if (json.error) return { ok: false, result: null, error: String(json.error) };
    return { ok: true, result: json.result, error: null };
  } catch (e) {
    return { ok: false, result: null, error: String(e.message || e) };
  }
}

async function kvGetJson(key) {
  const { ok, result } = await redisCmd(["GET", key]);
  if (!ok || result == null || typeof result !== "string") return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

async function kvSetJson(key, value) {
  const payload = JSON.stringify(value);
  const { ok } = await redisCmd(["SET", key, payload]);
  return ok;
}

///////////////////////////
// Helpers
///////////////////////////
function normalizeCityKey(input) {
  if (!input) return "";
  return String(input)
    .trim()
    .toUpperCase()
    .replace(/İ/g, "I")
    .replace(/Ğ/g, "G")
    .replace(/Ü/g, "U")
    .replace(/Ş/g, "S")
    .replace(/Ö/g, "O")
    .replace(/Ç/g, "C")
    .replace(/[^A-Z0-9\s()/-]/g, "")
    .replace(/\s+/g, "_");
}

function parseTrNumber(s) {
  if (s == null) return null;
  const txt = String(s).replace(/\s+/g, " ").trim();
  // "55,12" veya "55.12 TL/LT" gibi
  const m = txt.match(/(\d{1,3}(?:[.,]\d{1,2})?)/);
  if (!m) return null;
  const num = m[1].replace(",", ".");
  const v = Number(num);
  return Number.isFinite(v) ? v : null;
}

function hoursSince(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 36e5;
}

function ensure(obj, k, init) {
  if (!obj[k]) obj[k] = init;
  return obj[k];
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; fiyat-cepte/1.0; +https://vercel.com/)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

///////////////////////////
// Scrapers
///////////////////////////

// ✅ AKTİF: AYTEMIZ (statik HTML)
async function scrapeAytemiz() {
  const url = "https://www.aytemiz.com.tr/akaryakit-fiyatlari/benzin-fiyatlari";
  const html = await fetchHtml(url);

  const out = {}; // CITY_KEY -> { benzin, motorin, lpg }
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;

  while ((m = rowRegex.exec(html)) !== null) {
    const row = m[1];
    const cellText = row
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Tabloda şehir + sayılar var
    const nums = cellText.match(/(\d{1,3}(?:[.,]\d{1,2})?)/g);
    if (!nums || nums.length < 2) continue;

    const firstNum = nums[0];
    const idx = cellText.indexOf(firstNum);
    if (idx <= 0) continue;

    const cityRaw = cellText.slice(0, idx).trim();
    const cityKey = normalizeCityKey(cityRaw);
    if (!cityKey) continue;

    // Aytemiz tablosunda: İl | Benzin | Motorin | Motorin(Optimum) | Kalorifer | Fuel Oil
    // Benzin = nums[0], Motorin = nums[1]
    const benzin = parseTrNumber(nums[0]);
    const motorin = parseTrNumber(nums[1]);

    out[cityKey] = {
      benzin: benzin ?? null,
      motorin: motorin ?? null,
      lpg: null, // Aytemiz bu tabloda LPG vermiyor
    };
  }

  // İstanbul için Avrupa/Anadolu ayrımı varsa birleştir
  const istAvrupa = out["ISTANBUL_AVRUPA"];
  const istAnadolu = out["ISTANBUL_ANADOLU"];
  if (istAvrupa && istAnadolu) {
    const avg = (a, b) => (typeof a === "number" && typeof b === "number" ? Number(((a + b) / 2).toFixed(2)) : null);
    out["ISTANBUL"] = {
      benzin: avg(istAvrupa.benzin, istAnadolu.benzin),
      motorin: avg(istAvrupa.motorin, istAnadolu.motorin),
      lpg: null,
    };
  }

  return { brandKey: "AYTEMIZ", sourceUrl: url, data: out };
}

// ❌ DEVRE DIŞI: PETROL OFİSİ (JS render; JSON endpoint lazım)
/*
async function scrapePetrolOfisi() {
  // Bu fonksiyon şu an çalışmaz; Petrol Ofisi sayfası JS render ediyor.
  // İlerde JSON API bulunca aktif edelim.
  const url = "https://www.petrolofisi.com.tr/akaryakit-fiyatlari";
  throw new Error("PO: JS render (devre dışı)");
}
*/

// ❌ DEVRE DIŞI: SHELL (benzer durum; önce sayfayı kontrol etmek gerek)
/*
async function scrapeShell() {
  const url = "https://www.shell.com.tr/motoristler/shell-istasyonlari/akaryakit-fiyatlari.html";
  throw new Error("Shell: henüz implemente edilmedi");
}
*/

///////////////////////////
// Build / Cache
///////////////////////////
function merge(prices, brandKey, cityMap, meta) {
  const byBrand = ensure(prices, brandKey, {});
  for (const [cityKey, v] of Object.entries(cityMap || {})) {
    byBrand[cityKey] = {
      benzin: v.benzin ?? null,
      motorin: v.motorin ?? null,
      lpg: v.lpg ?? null,
      source: meta?.sourceUrl || null,
      fetchedAt: meta?.fetchedAt || null,
    };
  }
}

function buildAverages(prices) {
  const sums = {};
  for (const brandKey of Object.keys(prices || {})) {
    for (const [cityKey, p] of Object.entries(prices[brandKey] || {})) {
      const s = ensure(sums, cityKey, { bS: 0, bN: 0, mS: 0, mN: 0, lS: 0, lN: 0 });
      if (typeof p.benzin === "number") {
        s.bS += p.benzin;
        s.bN++;
      }
      if (typeof p.motorin === "number") {
        s.mS += p.motorin;
        s.mN++;
      }
      if (typeof p.lpg === "number") {
        s.lS += p.lpg;
        s.lN++;
      }
    }
  }
  const avg = {};
  for (const [cityKey, s] of Object.entries(sums)) {
    avg[cityKey] = {
      benzin: s.bN ? Number((s.bS / s.bN).toFixed(2)) : null,
      motorin: s.mN ? Number((s.mS / s.mN).toFixed(2)) : null,
      lpg: s.lN ? Number((s.lS / s.lN).toFixed(2)) : null,
    };
  }
  return avg;
}

async function updatePrices() {
  const fetchedAt = new Date().toISOString();
  const prices = {};
  const sources = [];

  // ✅ Aytemiz (aktif)
  try {
    const ay = await scrapeAytemiz();
    merge(prices, ay.brandKey, ay.data, { sourceUrl: ay.sourceUrl, fetchedAt });
    sources.push({ brand: ay.brandKey, ok: true, url: ay.sourceUrl });
  } catch (e) {
    sources.push({ brand: "AYTEMIZ", ok: false, error: String(e.message || e) });
  }

  // ❌ Petrol Ofisi (devre dışı)
  // try { const po = await scrapePetrolOfisi(); ... } catch { ... }

  // ❌ Shell (devre dışı)
  // try { const sh = await scrapeShell(); ... } catch { ... }

  const dataToStore = {
    prices,
    averages: buildAverages(prices),
    sources,
    lastUpdate: fetchedAt,
    note: "Fiyatlar Aytemiz il tablosundan alınır (Petrol Ofisi/Shell devre dışı).",
  };

  await kvSetJson("fuel:prices", dataToStore);
  return dataToStore;
}

///////////////////////////
// API handlers
///////////////////////////
async function handleHealth(_req, res) {
  const kvData = await kvGetJson("fuel:prices");
  const hasData = !!(kvData?.prices && Object.keys(kvData.prices).length);

  res.status(200).json({
    ok: true,
    hasData,
    lastUpdate: kvData?.lastUpdate || null,
    sources: kvData?.sources || [],
    note: kvData?.note || null,
  });
}

async function handlePrices(req, res) {
  let kvData = await kvGetJson("fuel:prices");
  if (!kvData) kvData = await updatePrices();

  if (hoursSince(kvData?.lastUpdate) > MAX_AGE_HOURS) {
    updatePrices().catch(() => null);
  }

  const url = new URL(req.url || "/", "http://localhost");
  const cityParam = url.searchParams.get("city");
  const brandParam = url.searchParams.get("brand");
  const cityKey = cityParam ? normalizeCityKey(cityParam) : null;
  const brandKey = brandParam ? normalizeCityKey(brandParam) : null;

  if (!cityKey && !brandKey) return res.status(200).json(kvData);

  if (brandKey && !cityKey) {
    return res.status(200).json({
      ...kvData,
      prices: { [brandKey]: kvData.prices?.[brandKey] || {} },
    });
  }

  if (cityKey && !brandKey) {
    const byBrand = {};
    for (const bk of Object.keys(kvData.prices || {})) {
      if (kvData.prices?.[bk]?.[cityKey]) byBrand[bk] = { [cityKey]: kvData.prices[bk][cityKey] };
    }
    return res.status(200).json({
      ...kvData,
      prices: byBrand,
      averages: kvData.averages?.[cityKey] ? { [cityKey]: kvData.averages[cityKey] } : {},
    });
  }

  return res.status(200).json({
    ...kvData,
    prices: {
      [brandKey]: {
        [cityKey]: kvData.prices?.[brandKey]?.[cityKey] || {},
      },
    },
    averages: kvData.averages?.[cityKey] ? { [cityKey]: kvData.averages[cityKey] } : {},
  });
}

async function handleUpdate(_req, res) {
  const result = await updatePrices();
  res.status(200).json({ ok: true, ...result });
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");

  const url = new URL(req.url || "/", "http://localhost");
  const p = url.pathname;

  if (p.endsWith("/health")) return handleHealth(req, res);
  if (p.endsWith("/update")) return handleUpdate(req, res);
  if (p.endsWith("/prices")) return handlePrices(req, res);

  return handlePrices(req, res);
};
