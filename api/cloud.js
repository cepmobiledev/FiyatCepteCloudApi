// cloud.js
// Vercel Serverless API - Akaryakıt Cloud (CollectAPI)
//
// Kaynak: CollectAPI Gas Price (TR) endpoint'leri
//  - /gasPrice/turkeyGasoline?city={city}&district={district}
//  - /gasPrice/turkeyDiesel?city={city}&district={district}
//  - /gasPrice/turkeyLpg?city={city}
//
// ENV GEREKSİNİMLERİ
//  - KV_REST_API_URL                veya  UPSTASH_REDIS_KV_REST_API_URL
//  - KV_REST_API_TOKEN              veya  UPSTASH_REDIS_KV_REST_API_TOKEN
//  - COLLECTAPI_KEY                 → "2kBD..." (sadece anahtar, başına 'apikey ' ekleme)
//
// ROUTES
//  - GET /api/health   → KV durumu
//  - GET /api/prices   → tüm şehirler veya ?city=ISPARTA
//  - GET /api/update   → CollectAPI'den çek, KV'ye yaz

///////////////////////////
// KV BAĞLANTISI
///////////////////////////

async function redisCmd(args) {
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;

  if (!url || !token) {
    console.error("KV env missing", { url: !!url, token: !!token });
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
      console.error("KV HTTP error", response.status);
      return { ok: false, result: null, error: `KV HTTP ${response.status}` };
    }

    const json = await response.json().catch(() => null);
    if (!json) return { ok: false, result: null, error: "KV bad json" };
    if (json.error) {
      console.error("KV logical error", json.error);
      return { ok: false, result: null, error: String(json.error) };
    }
    return { ok: true, result: json.result, error: null };
  } catch (e) {
    console.error("KV fetch error", e);
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
    .replace(/İ/g, "I")
    .replace(/Ğ/g, "G")
    .replace(/Ü/g, "U")
    .replace(/Ş/g, "S")
    .replace(/Ö/g, "O")
    .replace(/Ç/g, "C")
    .replace(/Â/g, "A")
    .replace(/[^A-Z0-9\s]/g, "")
    .replace(/\s+/g, "_");
}

function parseMaybeNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const cleaned = value
    .trim()
    .replace(/\./g, "")
    .replace(/,/g, ".")
    .replace(/[^\d.]/g, "");
  if (!cleaned) return null;
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCollectApiKey() {
  const key = process.env.COLLECTAPI_KEY;
  if (!key) {
    console.error("COLLECTAPI_KEY env missing");
  }
  return key;
}

///////////////////////////
// COLLECTAPI ENDPOINT'LERİ
///////////////////////////

// Not: Burada performans ve kota açısından "şehir odaklı" çalışılacak.
// Türkiye il listesi:
const TURKEY_CITIES = [
  "Adana","Adıyaman","Afyonkarahisar","Ağrı","Aksaray","Amasya","Ankara",
  "Antalya","Ardahan","Artvin","Aydın","Balıkesir","Bartın","Batman",
  "Bayburt","Bilecik","Bingöl","Bitlis","Bolu","Burdur","Bursa","Çanakkale",
  "Çankırı","Çorum","Denizli","Diyarbakır","Düzce","Edirne","Elazığ",
  "Erzincan","Erzurum","Eskişehir","Gaziantep","Giresun","Gümüşhane",
  "Hakkari","Hatay","Iğdır","Isparta","İstanbul","İzmir","Kahramanmaraş",
  "Karabük","Karaman","Kars","Kastamonu","Kayseri","Kırıkkale","Kırklareli",
  "Kırşehir","Kilis","Kocaeli","Konya","Kütahya","Malatya","Manisa",
  "Mardin","Mersin","Muğla","Muş","Nevşehir","Niğde","Ordu","Osmaniye",
  "Rize","Sakarya","Samsun","Siirt","Sinop","Sivas","Şanlıurfa","Şırnak",
  "Tekirdağ","Tokat","Trabzon","Tunceli","Uşak","Van","Yalova","Yozgat",
  "Zonguldak"
];

// CollectAPI dokümantasyonundaki benzin endpoint'i.[web:71]
const GASOLINE_URL = "https://api.collectapi.com/gasPrice/turkeyGasoline";
const DIESEL_URL = "https://api.collectapi.com/gasPrice/turkeyDiesel";
const LPG_URL = "https://api.collectapi.com/gasPrice/turkeyLpg"; // LPG şehir bazlı.[web:54]

async function collectGet(url) {
  const key = getCollectApiKey();
  if (!key) return null;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        authorization: `apikey ${key}`,
      },
    });

    if (!res.ok) {
      console.error("CollectAPI HTTP", res.status, url);
      return null;
    }

    const json = await res.json().catch(() => null);
    if (!json || json.success !== true) {
      console.error("CollectAPI bad json", url);
      return null;
    }

    return json.result || [];
  } catch (e) {
    console.error("CollectAPI error", url, e);
    return null;
  }
}

// Şehir için benzin + motorin + LPG verilerini çeker.
// İlçe parametresi yoksa şehir ortalaması (CollectAPI ne veriyorsa) alınır.[web:54][web:71]
async function fetchCityCombined(cityName) {
  const cityParam = encodeURIComponent(cityName);

  const [gasolineResult, dieselResult, lpgResult] = await Promise.all([
    collectGet(`${GASOLINE_URL}?city=${cityParam}`),
    collectGet(`${DIESEL_URL}?city=${cityParam}`),
    collectGet(`${LPG_URL}?city=${cityParam}`),
  ]);

  // JSON şekilleri:
  // gasolineResult: [{ benzin, katkili, marka }, ...]
  // dieselResult:   [{ motorin, katkili, marka }, ...]
  // lpgResult:      [{ lastupdate, price: [{ lpg, marka }, ...] }]
  const cityKey = normalizeCityKey(cityName);

  const byBrand = {};

  if (Array.isArray(gasolineResult)) {
    for (const item of gasolineResult) {
      const brand = (item.marka || "").toString().trim().toUpperCase();
      if (!brand) continue;
      if (!byBrand[brand]) byBrand[brand] = { city: cityKey, brand };
      const benzin = parseMaybeNumber(item.benzin);
      if (benzin != null) byBrand[brand].benzin = benzin;
    }
  }

  if (Array.isArray(dieselResult)) {
    for (const item of dieselResult) {
      const brand = (item.marka || "").toString().trim().toUpperCase();
      if (!brand) continue;
      if (!byBrand[brand]) byBrand[brand] = { city: cityKey, brand };
      const motorin = parseMaybeNumber(item.motorin);
      if (motorin != null) byBrand[brand].motorin = motorin;
    }
  }

  if (Array.isArray(lpgResult) && lpgResult.length > 0) {
    const first = lpgResult[0];
    if (first && Array.isArray(first.price)) {
      for (const p of first.price) {
        const brand = (p.marka || "").toString().trim().toUpperCase();
        if (!brand) continue;
        if (!byBrand[brand]) byBrand[brand] = { city: cityKey, brand };
        const lpg = parseMaybeNumber(p.lpg);
        if (lpg != null) byBrand[brand].lpg = lpg;
      }
    }
  }

  return { cityKey, byBrand };
}

///////////////////////////
// TÜM ŞEHİRLERİ ÇEK + ORTALAMA
///////////////////////////

function buildStructures(allCitiesByBrand) {
  // allCitiesByBrand: { [cityKey]: { [brand]: { city, brand, benzin?, motorin?, lpg? } } }

  const allFirmPrices = {}; // MARKA → CITY → data
  const cityBuckets = {}; // CITY → arrays for averaging

  for (const [cityKey, brandMap] of Object.entries(allCitiesByBrand)) {
    if (!cityBuckets[cityKey]) {
      cityBuckets[cityKey] = { benzin: [], motorin: [], lpg: [] };
    }

    for (const [brand, data] of Object.entries(brandMap)) {
      if (!allFirmPrices[brand]) allFirmPrices[brand] = {};
      allFirmPrices[brand][cityKey] = {
        city: cityKey,
        brand,
        benzin: data.benzin ?? null,
        motorin: data.motorin ?? null,
        lpg: data.lpg ?? null,
      };

      if (data.benzin != null) cityBuckets[cityKey].benzin.push(data.benzin);
      if (data.motorin != null) cityBuckets[cityKey].motorin.push(data.motorin);
      if (data.lpg != null) cityBuckets[cityKey].lpg.push(data.lpg);
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

async function scrapeAndStoreAllPrices() {
  const allCitiesByBrand = {};

  for (const city of TURKEY_CITIES) {
    await sleep(350); // API limitine saygı.[web:54]
    const { cityKey, byBrand } = await fetchCityCombined(city);
    if (Object.keys(byBrand).length > 0) {
      allCitiesByBrand[cityKey] = byBrand;
    }
  }

  const { allFirmPrices, cityAverages } = buildStructures(allCitiesByBrand);

  const dataToStore = {
    allFirmPrices,
    cityAverages,
    sources: ["collectapi"],
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
  const hasData =
    kvData &&
    kvData.allFirmPrices &&
    Object.keys(kvData.allFirmPrices).length > 0;

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
    cityAverages:
      cityKey && cityAverages[cityKey]
        ? { [cityKey]: cityAverages[cityKey] }
        : {},
    lastUpdate: kvData.lastUpdate || null,
    sources: kvData.sources || [],
  });
}

async function handleUpdate(_req, res) {
  const result = await scrapeAndStoreAllPrices();
  res.status(200).json({ ok: true, ...result });
}

///////////////////////////
// MAIN EXPORT
///////////////////////////

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate");

  const url = new URL(req.url || "/", "http://localhost");
  const p = url.pathname;

  if (p.endsWith("/health")) return handleHealth(req, res);
  if (p.endsWith("/prices")) return handlePrices(req, res);
  if (p.endsWith("/update")) return handleUpdate(req, res);

  return handlePrices(req, res);
};
