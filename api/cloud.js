import axios from "axios";

const UPSTASH_URL = process.env.UPSTASH_REDIS_KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
const COLLECTAPI_KEY = process.env.COLLECTAPI_KEY;

const CACHE_KEY = "prices:v1";
const CACHE_TTL_SECONDS = 4 * 60 * 60; // 4 saat

function normCity(s) {
  return String(s || "")
    .trim()
    .toUpperCase()
    .replace(/İ/g, "I")
    .replace(/İ/g, "I");
}

async function upstashGet(key) {
  const url = `${UPSTASH_URL}/get/${encodeURIComponent(key)}`;
  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    timeout: 15000,
  });
  // Upstash REST: { result: "..." } veya { result: null }
  return r.data?.result ?? null;
}

async function upstashSet(key, valueObj, exSeconds) {
  const payload = JSON.stringify(valueObj);
  const url = `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(payload)}?ex=${exSeconds}`;
  await axios.get(url, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    timeout: 15000,
  });
}

async function fetchCollect(endpointPath) {
  const url = `https://api.collectapi.com/gasPrice/${endpointPath}`;
  const r = await axios.get(url, {
    headers: {
      authorization: `apikey ${COLLECTAPI_KEY}`,
      "content-type": "application/json",
    },
    timeout: 15000,
  });
  return r.data;
}

// CollectAPI response yapısı dokümanda tüm TR endpoint’ler için tek tek gösterilmiyor;
// Bu yüzden burada “esnek parse” yapıyoruz: result bir array ise onu al, değilse boş.
function extractList(data) {
  if (!data) return [];
  if (Array.isArray(data.result)) return data.result;
  if (Array.isArray(data.results)) return data.results;
  if (data.result && Array.isArray(data.result.data)) return data.result.data;
  return [];
}

function pickPrice(item) {
  // Olası alan adları: price / gasoline / diesel / lpg / amount...
  const candidates = [
    item?.price,
    item?.gasoline,
    item?.diesel,
    item?.lpg,
    item?.amount,
    item?.value,
  ];
  for (const c of candidates) {
    const n = typeof c === "string" ? parseFloat(c.replace(",", ".")) : Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickCity(item) {
  return item?.city || item?.name || item?.sehir || item?.province || item?.il;
}

async function collectTurkeyAll() {
  const [gasolineData, dieselData, lpgData] = await Promise.all([
    fetchCollect("turkeyGasoline"),
    fetchCollect("turkeyDiesel"),
    fetchCollect("turkeyLpg"),
  ]);

  const gasolineList = extractList(gasolineData);
  const dieselList = extractList(dieselData);
  const lpgList = extractList(lpgData);

  // city -> { benzin, motorin, lpg }
  const byCity = new Map();

  const upsert = (list, field) => {
    for (const item of list) {
      const cityRaw = pickCity(item);
      const city = normCity(cityRaw);
      if (!city) continue;

      const price = pickPrice(item);
      if (!Number.isFinite(price)) continue;

      const cur = byCity.get(city) || { benzin: null, motorin: null, lpg: null };
      cur[field] = Number(price.toFixed(2));
      byCity.set(city, cur);
    }
  };

  upsert(gasolineList, "benzin");
  upsert(dieselList, "motorin");
  upsert(lpgList, "lpg");

  // ŞEMA: prices[brand][city]
  const prices = { COLLECTAPI: {} };
  for (const [city, vals] of byCity.entries()) {
    prices.COLLECTAPI[city] = vals;
  }

  return {
    ok: Object.keys(prices.COLLECTAPI).length > 0,
    data: {
      prices,
      updatedAt: new Date().toISOString(),
      source: "collectapi",
    },
  };
}

export default async function handler(req, res) {
  // CDN: 1 saat cache + 5 dk stale-while-revalidate
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=300");

  try {
    if (req.url.includes("/api/prices")) {
      const cached = await upstashGet(CACHE_KEY);
      if (cached) {
        // cached JSON string olabilir
        const parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
        return res.status(200).json(parsed);
      }

      const result = await collectTurkeyAll();
      if (!result.ok) return res.status(500).json({ error: "Fiyatlar çekilemedi" });

      await upstashSet(CACHE_KEY, result.data, CACHE_TTL_SECONDS);
      return res.status(200).json(result.data);
    }

    if (req.url.includes("/api/update")) {
      const result = await collectTurkeyAll();
      if (!result.ok) return res.status(500).json({ success: false, error: "Fiyatlar çekilemedi" });

      await upstashSet(CACHE_KEY, result.data, CACHE_TTL_SECONDS);
      const cityCount = Object.keys(result.data.prices?.COLLECTAPI || {}).length;
      return res.status(200).json({ success: true, cityCount });
    }

    return res.status(404).json({ error: "Endpoint bulunamadı" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
