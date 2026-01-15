// api/cloud.js
// Aytemiz arşiv: benzin+motorin+LPG (il merkezleri)

const MAX_AGE_HOURS = 12;

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
  try { return JSON.parse(result); } catch { return null; }
}

async function kvSetJson(key, value) {
  const { ok } = await redisCmd(["SET", key, JSON.stringify(value)]);
  return ok;
}

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
  const txt = String(s).replace(/\s+/g, "").trim();
  const m = txt.match(/(\d{1,3}(?:[.,]\d{1,2})?)/);
  if (!m) return null;
  const v = Number(m[1].replace(",", "."));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function hoursSince(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 36e5 : Infinity;
}

function ensure(obj, k, init) {
  if (!obj[k]) obj[k] = init;
  return obj[k];
}

// Aytemiz arşiv POST
async function fetchAytemizArchive(fuelType) {
  const today = new Date();
  const day = String(today.getDate()).padStart(2, "0");
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const year = today.getFullYear();
  const dateStr = `${day}.${month}.${year}`;

  const formData = new URLSearchParams({
    "ctl00$ContentPlaceHolder1$C002$txtDate": dateStr,
    "ctl00$ContentPlaceHolder1$C002$selCities": "0", // tüm iller
    "ctl00$ContentPlaceHolder1$C002$rblFuelType": String(fuelType), // 1=akaryakıt, 2=LPG
  });

  const res = await fetch("https://www.aytemiz.com.tr/akaryakit-fiyatlari/arsiv-fiyat-listesi", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
    },
    body: formData.toString(),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function scrapeAytemiz() {
  const out = {};

  // 1) Akaryakıt (benzin + motorin)
  const htmlFuel = await fetchAytemizArchive(1);
  const linesFuel = htmlFuel.split("\n");

  for (const line of linesFuel) {
    if (!line.includes("<td")) continue;
    const cells = line.match(/<td[^>]*>(.*?)<\/td>/gi);
    if (!cells || cells.length < 4) continue;

    const cityRaw = cells[0]?.replace(/<[^>]+>/g, "").trim();
    const benzinRaw = cells[1]?.replace(/<[^>]+>/g, "").trim();
    const motorinRaw = cells[3]?.replace(/<[^>]+>/g, "").trim();

    const cityKey = normalizeCityKey(cityRaw);
    if (!cityKey) continue;

    const benzin = parseTrNumber(benzinRaw);
    const motorin = parseTrNumber(motorinRaw);

    if (benzin == null || motorin == null) continue;

    out[cityKey] = { benzin, motorin, lpg: null };
  }

  // 2) LPG
  const htmlLpg = await fetchAytemizArchive(2);
  const linesLpg = htmlLpg.split("\n");

  for (const line of linesLpg) {
    if (!line.includes("<td")) continue;
    const cells = line.match(/<td[^>]*>(.*?)<\/td>/gi);
    if (!cells || cells.length < 2) continue;

    const cityRaw = cells[0]?.replace(/<[^>]+>/g, "").trim();
    const lpgRaw = cells[1]?.replace(/<[^>]+>/g, "").trim();

    const cityKey = normalizeCityKey(cityRaw);
    if (!cityKey) continue;

    const lpg = parseTrNumber(lpgRaw);
    if (lpg == null) continue;

    if (!out[cityKey]) out[cityKey] = { benzin: null, motorin: null, lpg: null };
    out[cityKey].lpg = lpg;
  }

  if (Object.keys(out).length < 10) {
    throw new Error(`Aytemiz: sadece ${Object.keys(out).length} il bulundu`);
  }

  return { brandKey: "AYTEMIZ", sourceUrl: "https://www.aytemiz.com.tr/akaryakit-fiyatlari/arsiv-fiyat-listesi", data: out };
}

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
      if (typeof p.benzin === "number") { s.bS += p.benzin; s.bN++; }
      if (typeof p.motorin === "number") { s.mS += p.motorin; s.mN++; }
      if (typeof p.lpg === "number") { s.lS += p.lpg; s.lN++; }
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

  try {
    const ay = await scrapeAytemiz();
    merge(prices, ay.brandKey, ay.data, { sourceUrl: ay.sourceUrl, fetchedAt });
    sources.push({ brand: ay.brandKey, ok: true, url: ay.sourceUrl, cityCount: Object.keys(ay.data).length });
  } catch (e) {
    sources.push({ brand: "AYTEMIZ", ok: false, error: String(e.message || e) });
  }

  const dataToStore = {
    prices,
    averages: buildAverages(prices),
    sources,
    lastUpdate: fetchedAt,
    note: "Aytemiz arşiv (benzin+motorin+LPG il merkezleri)",
  };

  await kvSetJson("fuel:prices", dataToStore);
  return dataToStore;
}

async function handleHealth(_req, res) {
  const kvData = await kvGetJson("fuel:prices");
  res.status(200).json({
    ok: true,
    hasData: !!(kvData?.prices && Object.keys(kvData.prices).length),
    lastUpdate: kvData?.lastUpdate || null,
    sources: kvData?.sources || [],
  });
}

async function handlePrices(req, res) {
  let kvData = await kvGetJson("fuel:prices");
  if (!kvData) kvData = await updatePrices();
  if (hoursSince(kvData?.lastUpdate) > MAX_AGE_HOURS) updatePrices().catch(() => null);

  const url = new URL(req.url || "/", "http://localhost");
  const cityParam = url.searchParams.get("city");
  const brandParam = url.searchParams.get("brand");
  const cityKey = cityParam ? normalizeCityKey(cityParam) : null;
  const brandKey = brandParam ? normalizeCityKey(brandParam) : null;

  if (!cityKey && !brandKey) return res.status(200).json(kvData);
  if (brandKey && !cityKey) return res.status(200).json({ ...kvData, prices: { [brandKey]: kvData.prices?.[brandKey] || {} } });

  if (cityKey && !brandKey) {
    const byBrand = {};
    for (const bk of Object.keys(kvData.prices || {})) {
      if (kvData.prices?.[bk]?.[cityKey]) byBrand[bk] = { [cityKey]: kvData.prices[bk][cityKey] };
    }
    return res.status(200).json({ ...kvData, prices: byBrand, averages: kvData.averages?.[cityKey] ? { [cityKey]: kvData.averages[cityKey] } : {} });
  }

  return res.status(200).json({
    ...kvData,
    prices: { [brandKey]: { [cityKey]: kvData.prices?.[brandKey]?.[cityKey] || {} } },
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
  return handlePrices(req, res);
};
