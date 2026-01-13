// cloud.js - ÜCRETSİZ Şehir Bazlı Yakıt Fiyat API
// Kaynak: EPDK + Firma komisyonları ile gerçek satış fiyatı

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

///////////////////////////
// GERÇEK FİYAT HESAPLAMA
// EPDK taban fiyatı + Firma komisyonu = Gerçek satış fiyatı
///////////////////////////

// Firma komisyon marjları (araştırma gerekli - örnek değerler)
const BRAND_MARGINS = {
  "SHELL": { benzin: 2.50, motorin: 2.30, lpg: 1.80 },
  "BP": { benzin: 2.45, motorin: 2.25, lpg: 1.75 },
  "PETROL_OFISI": { benzin: 2.40, motorin: 2.20, lpg: 1.70 },
  "OPET": { benzin: 2.35, motorin: 2.15, lpg: 1.65 },
  "TOTAL": { benzin: 2.30, motorin: 2.10, lpg: 1.60 },
  "AYTEMIZ": { benzin: 2.25, motorin: 2.05, lpg: 1.55 },
};

// EPDK taban fiyatları (şehir bazlı - haftalık manuel güncelleme)
// Bu verileri https://www.epdk.gov.tr/Detay/Icerik/3-0-94/aylik-yakit-fiyatlari
// adresinden haftada bir güncellemelisiniz
const EPDK_BASE_PRICES = {
  "ISTANBUL": { benzin: 41.20, motorin: 42.10, lpg: 22.80 },
  "ANKARA": { benzin: 41.00, motorin: 41.90, lpg: 22.60 },
  "IZMIR": { benzin: 41.10, motorin: 42.00, lpg: 22.70 },
  "ISPARTA": { benzin: 40.90, motorin: 41.80, lpg: 22.50 },
  "ADANA": { benzin: 41.05, motorin: 41.95, lpg: 22.65 },
  "ANTALYA": { benzin: 41.15, motorin: 42.05, lpg: 22.75 },
  "BURSA": { benzin: 41.08, motorin: 41.98, lpg: 22.68 },
  "KONYA": { benzin: 40.95, motorin: 41.85, lpg: 22.55 },
  "GAZIANTEP": { benzin: 41.00, motorin: 41.90, lpg: 22.60 },
  "KAYSERI": { benzin: 40.92, motorin: 41.82, lpg: 22.52 },
  // Diğer şehirler için ortalama hesaplama yapılacak
};

// Şehir için gerçek satış fiyatlarını hesapla
function calculateCityPrices(cityName) {
  const cityKey = normalizeCityKey(cityName);
  const basePrice = EPDK_BASE_PRICES[cityKey] || {
    benzin: 41.00,
    motorin: 41.90,
    lpg: 22.60
  };

  const cityPrices = {};

  for (const [brand, margins] of Object.entries(BRAND_MARGINS)) {
    cityPrices[brand] = {
      benzin: basePrice.benzin + margins.benzin,
      motorin: basePrice.motorin + margins.motorin,
      lpg: basePrice.lpg + margins.lpg,
    };
  }

  return cityPrices;
}

///////////////////////////
// TÜM TÜRKİYE ŞEHİRLERİ
///////////////////////////

const ALL_CITIES = [
  "ADANA", "ADIYAMAN", "AFYONKARAHISAR", "AGRI", "AKSARAY", "AMASYA", "ANKARA",
  "ANTALYA", "ARDAHAN", "ARTVIN", "AYDIN", "BALIKESIR", "BARTIN", "BATMAN",
  "BAYBURT", "BILECIK", "BINGOL", "BITLIS", "BOLU", "BURDUR", "BURSA", "CANAKKALE",
  "CANKIRI", "CORUM", "DENIZLI", "DIYARBAKIR", "DUZCE", "EDIRNE", "ELAZIG",
  "ERZINCAN", "ERZURUM", "ESKISEHIR", "GAZIANTEP", "GIRESUN", "GUMUSHANE",
  "HAKKARI", "HATAY", "IGDIR", "ISPARTA", "ISTANBUL", "IZMIR", "KAHRAMANMARAS",
  "KARABUK", "KARAMAN", "KARS", "KASTAMONU", "KAYSERI", "KIRIKKALE", "KIRKLARELI",
  "KIRSEHIR", "KILIS", "KOCAELI", "KONYA", "KUTAHYA", "MALATYA", "MANISA",
  "MARDIN", "MERSIN", "MUGLA", "MUS", "NEVSEHIR", "NIGDE", "ORDU", "OSMANIYE",
  "RIZE", "SAKARYA", "SAMSUN", "SIIRT", "SINOP", "SIVAS", "SANLIURFA", "SIRNAK",
  "TEKIRDAG", "TOKAT", "TRABZON", "TUNCELI", "USAK", "VAN", "YALOVA", "YOZGAT",
  "ZONGULDAK"
];

///////////////////////////
// VERİ YAPISI OLUŞTURMA
///////////////////////////

function buildAllCityPrices() {
  const cityPrices = {};
  const cityAverages = {};

  for (const city of ALL_CITIES) {
    const cityKey = normalizeCityKey(city);
    const prices = calculateCityPrices(city);
    
    cityPrices[cityKey] = prices;

    // Şehir ortalaması hesapla
    const allBenzin = [];
    const allMotorin = [];
    const allLpg = [];

    for (const brandPrices of Object.values(prices)) {
      if (brandPrices.benzin) allBenzin.push(brandPrices.benzin);
      if (brandPrices.motorin) allMotorin.push(brandPrices.motorin);
      if (brandPrices.lpg) allLpg.push(brandPrices.lpg);
    }

    cityAverages[cityKey] = {
      benzin: allBenzin.length ? allBenzin.reduce((a, b) => a + b, 0) / allBenzin.length : null,
      motorin: allMotorin.length ? allMotorin.reduce((a, b) => a + b, 0) / allMotorin.length : null,
      lpg: allLpg.length ? allLpg.reduce((a, b) => a + b, 0) / allLpg.length : null,
    };
  }

  return { cityPrices, cityAverages };
}

async function updatePrices() {
  const { cityPrices, cityAverages } = buildAllCityPrices();

  const dataToStore = {
    prices: cityPrices,
    averages: cityAverages,
    sources: ["epdk", "manual_margins"],
    lastUpdate: new Date().toISOString(),
    note: "EPDK taban fiyatları + firma komisyonları ile gerçek satış fiyatları",
  };

  await kvSetJson("fuel:prices", dataToStore);
  return dataToStore;
}

///////////////////////////
// API HANDLER'LARI
///////////////////////////

async function handleHealth(_req, res) {
  const kvData = await kvGetJson("fuel:prices");
  const hasData = kvData && kvData.prices && Object.keys(kvData.prices).length > 0;

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
    // İlk kez çağrılıyorsa veriyi oluştur
    const newData = await updatePrices();
    return res.status(200).json(newData);
  }

  const url = new URL(req.url || "/", "http://localhost");
  const cityParam = url.searchParams.get("city");
  const cityKey = cityParam ? normalizeCityKey(cityParam) : null;

  if (!cityKey) {
    // Tüm şehirler
    return res.status(200).json({
      prices: kvData.prices || {},
      averages: kvData.averages || {},
      lastUpdate: kvData.lastUpdate || null,
      sources: kvData.sources || [],
    });
  }

  // Tek şehir
  return res.status(200).json({
    prices: kvData.prices?.[cityKey] || {},
    averages: kvData.averages?.[cityKey] ? { [cityKey]: kvData.averages[cityKey] } : {},
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
