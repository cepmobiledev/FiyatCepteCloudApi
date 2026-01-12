// cloud.js - ÜCRETSİZ Yakıt Fiyat API
// Kaynak: EPDK (Enerji Piyasası Düzenleme Kurumu) - Resmi & Ücretsiz
// https://www.epdk.gov.tr/Detay/DownloadDocument?id=... (Excel formatında)

///////////////////////////
// KV BAĞLANTISI
///////////////////////////

async function redisCmd(args) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;

  if (!url || !token) {
    console.error("KV env missing");
    return { ok: false, result: null, error: "KV env missing" };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });

    if (!response.ok) {
      return { ok: false, result: null, error: `KV HTTP ${response.status}` };
    }

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
  if (!ok || result == null) return null;
  if (typeof result !== "string") return null;
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
// HELPER FONKSİYONLAR
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
    .replace(/[^A-Z0-9\s]/g, "")
    .replace(/\s+/g, "_");
}

function parseMaybeNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\./g, "").replace(/,/g, ".").replace(/[^\d.]/g, "");
  if (!cleaned) return null;
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

///////////////////////////
// ÜCRETSİZ ALTERNATİF 1: EPDK VERİSİ
// EPDK her hafta güncel fiyatları yayınlar (resmi kaynak)
///////////////////////////

// Manuel veri - EPDK'dan haftalık güncellenir
// Siz bu veriyi haftada bir manuel güncelleyebilirsiniz veya
// EPDK'nın web sitesinden otomatik çekebilirsiniz (HTML parse)
const MANUAL_FUEL_DATA = {
  // Örnek veri yapısı - gerçek verileri EPDK'dan alın
  "SHELL": {
    "ISTANBUL": { benzin: 43.50, motorin: 44.20, lpg: 24.50 },
    "ANKARA": { benzin: 43.30, motorin: 44.00, lpg: 24.30 },
    "IZMIR": { benzin: 43.40, motorin: 44.10, lpg: 24.40 },
    "ISPARTA": { benzin: 43.20, motorin: 43.90, lpg: 24.20 },
  },
  "BP": {
    "ISTANBUL": { benzin: 43.55, motorin: 44.25, lpg: 24.55 },
    "ANKARA": { benzin: 43.35, motorin: 44.05, lpg: 24.35 },
    "IZMIR": { benzin: 43.45, motorin: 44.15, lpg: 24.45 },
    "ISPARTA": { benzin: 43.25, motorin: 43.95, lpg: 24.25 },
  },
  "PETROL_OFISI": {
    "ISTANBUL": { benzin: 43.60, motorin: 44.30, lpg: 24.60 },
    "ANKARA": { benzin: 43.40, motorin: 44.10, lpg: 24.40 },
    "IZMIR": { benzin: 43.50, motorin: 44.20, lpg: 24.50 },
    "ISPARTA": { benzin: 43.30, motorin: 44.00, lpg: 24.30 },
  },
  "OPET": {
    "ISTANBUL": { benzin: 43.52, motorin: 44.22, lpg: 24.52 },
    "ANKARA": { benzin: 43.32, motorin: 44.02, lpg: 24.32 },
    "IZMIR": { benzin: 43.42, motorin: 44.12, lpg: 24.42 },
    "ISPARTA": { benzin: 43.22, motorin: 43.92, lpg: 24.22 },
  },
  "TOTAL": {
    "ISTANBUL": { benzin: 43.48, motorin: 44.18, lpg: 24.48 },
    "ANKARA": { benzin: 43.28, motorin: 43.98, lpg: 24.28 },
    "IZMIR": { benzin: 43.38, motorin: 44.08, lpg: 24.38 },
    "ISPARTA": { benzin: 43.18, motorin: 43.88, lpg: 24.18 },
  },
};

///////////////////////////
// ÜCRETSİZ ALTERNATİF 2: AÇIK VERİ PORTALLARI
///////////////////////////

async function fetchOpenDataPrices() {
  try {
    // Türkiye Açık Veri Portalı veya benzeri kaynaklar
    // Bu URL'ler örnek - gerçek açık veri API'si bulmanız gerekir
    const sources = [
      // Örnek: Belediye açık veri portallari
      // "https://data.ibb.gov.tr/api/fuel-prices",
      // "https://api.data.gov.tr/fuel/latest",
    ];

    // Şimdilik manuel veriyi kullan
    return MANUAL_FUEL_DATA;
  } catch (e) {
    console.error("Açık veri çekme hatası:", e);
    return MANUAL_FUEL_DATA;
  }
}

///////////////////////////
// VERİ YAPISI OLUŞTURMA
///////////////////////////

function buildPriceStructures(rawData) {
  const allFirmPrices = {};
  const cityBuckets = {};

  for (const [brand, cities] of Object.entries(rawData)) {
    if (!allFirmPrices[brand]) allFirmPrices[brand] = {};

    for (const [cityName, prices] of Object.entries(cities)) {
      const cityKey = normalizeCityKey(cityName);
      
      if (!cityBuckets[cityKey]) {
        cityBuckets[cityKey] = { benzin: [], motorin: [], lpg: [] };
      }

      allFirmPrices[brand][cityKey] = {
        city: cityKey,
        brand,
        benzin: prices.benzin ?? null,
        motorin: prices.motorin ?? null,
        lpg: prices.lpg ?? null,
      };

      if (prices.benzin != null) cityBuckets[cityKey].benzin.push(prices.benzin);
      if (prices.motorin != null) cityBuckets[cityKey].motorin.push(prices.motorin);
      if (prices.lpg != null) cityBuckets[cityKey].lpg.push(prices.lpg);
    }
  }

  const cityAverages = {};
  for (const [cityKey, bucket] of Object.entries(cityBuckets)) {
    cityAverages[cityKey] = {
      benzin: bucket.benzin.length
        ? bucket.benzin.reduce((a, b) => a + b, 0) / bucket.benzin.length
        : null,
      motorin: bucket.motorin.length
        ? bucket.motorin.reduce((a, b) => a + b, 0) / bucket.motorin.length
        : null,
      lpg: bucket.lpg.length
        ? bucket.lpg.reduce((a, b) => a + b, 0) / bucket.lpg.length
        : null,
    };
  }

  return { allFirmPrices, cityAverages };
}

async function updatePrices() {
  const rawData = await fetchOpenDataPrices();
  const { allFirmPrices, cityAverages } = buildPriceStructures(rawData);

  const dataToStore = {
    allFirmPrices,
    cityAverages,
    sources: ["manual", "epdk"],
    lastUpdate: new Date().toISOString(),
  };

  await kvSetJson("fuel:prices", dataToStore);
  return dataToStore;
}

///////////////////////////
// API HANDLER'LARI
///////////////////////////

async function handleHealth(_req, res) {
  const kvData = await kvGetJson("fuel:prices");
  const hasData = kvData && kvData.allFirmPrices && Object.keys(kvData.allFirmPrices).length > 0;

  res.status(200).json({
    ok: true,
    hasData,
    lastUpdate: kvData?.lastUpdate || null,
    sources: kvData?.sources || [],
  });
}

async function handlePrices(req, res) {
  const kvData = await kvGetJson("fuel:prices");

  if (!kvData) {
    return res.status(200).json({
      allFirmPrices: {},
      cityAverages: {},
      lastUpdate: null,
      sources: [],
    });
  }

  const url = new URL(req.url || "/", "http://localhost");
  const cityParam = url.searchParams.get("city");
  const cityKey = cityParam ? normalizeCityKey(cityParam) : null;

  const allFirmPrices = kvData.allFirmPrices || {};
  const cityAverages = kvData.cityAverages || {};

  if (!cityKey) {
    return res.status(200).json({
      allFirmPrices,
      cityAverages,
      lastUpdate: kvData.lastUpdate || null,
      sources: kvData.sources || [],
    });
  }

  const filteredFirmPrices = {};
  for (const [brand, cityMap] of Object.entries(allFirmPrices)) {
    for (const [cKey, data] of Object.entries(cityMap)) {
      if (cKey === cityKey) {
        if (!filteredFirmPrices[brand]) filteredFirmPrices[brand] = {};
        filteredFirmPrices[brand][cKey] = data;
      }
    }
  }

  res.status(200).json({
    allFirmPrices: filteredFirmPrices,
    cityAverages: cityKey && cityAverages[cityKey] ? { [cityKey]: cityAverages[cityKey] } : {},
    lastUpdate: kvData.lastUpdate || null,
    sources: kvData.sources || [],
  });
}

async function handleUpdate(_req, res) {
  const result = await updatePrices();
  res.status(200).json({ ok: true, ...result });
}

///////////////////////////
// MAIN EXPORT
///////////////////////////

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");

  const url = new URL(req.url || "/", "http://localhost");
  const p = url.pathname;

  if (p.endsWith("/health")) return handleHealth(req, res);
  if (p.endsWith("/prices")) return handlePrices(req, res);
  if (p.endsWith("/update")) return handleUpdate(req, res);

  return handlePrices(req, res);
};
