javascript
import axios from 'axios';
import * as cheerio from 'cheerio';

let cachedPrices = null;
let lastUpdateTime = 0;
const CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 saat

const CITIES = [
  'ADANA', 'ADIYAMAN', 'AFYONKARAHISAR', 'AGRI', 'AKSARAY', 'AMASYA', 'ANKARA', 'ANTALYA',
  'ARDAHAN', 'ARTVIN', 'AYDIN', 'BALIKESIR', 'BARTIN', 'BATMAN', 'BAYBURT', 'BILECIK',
  'BINGOL', 'BITLIS', 'BOLU', 'BURDUR', 'BURSA', 'CANAKKALE', 'CANKIRI', 'CORUM',
  'DENIZLI', 'DIYARBAKIR', 'DUZCE', 'EDIRNE', 'ELAZIG', 'ERZINCAN', 'ERZURUM', 'ESKISEHIR',
  'GAZIANTEP', 'GIRESUN', 'GUMUSHANE', 'HAKKARI', 'HATAY', 'IGDIR', 'ISPARTA', 'ISTANBUL',
  'IZMIR', 'KARABUK', 'KARAMAN', 'KARS', 'KASTAMONU', 'KAYSERI', 'KILIS', 'KIRIKKALE',
  'KIRKLARELI', 'KIRSEHIR', 'KOCAELI', 'KONYA', 'KUTAHYA', 'MALATYA', 'MANISA', 'MARDIN',
  'MERSIN', 'MUGLA', 'MUS', 'NEVSEHIR', 'NIGDE', 'ORDU', 'OSMANIYE', 'RIZE', 'SAKARYA',
  'SAMSUN', 'SANLIURFA', 'SIIRT', 'SINOP', 'SIRNAK', 'SIVAS', 'TEKIRDAG', 'TOKAT',
  'TRABZON', 'TUNCELI', 'USAK', 'VAN', 'YALOVA', 'YOZGAT', 'ZONGULDAK'
];

async function scrapeAytemiz() {
  const allBrandPrices = {};
  
  try {
    // Seçenekleri çek
    const optionsResponse = await axios.get(
      'https://www.aytemiz.com.tr/akaryakit-fiyatlari/arsiv-fiyat-listesi',
      { 
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 15000
      }
    );
    
    const $options = cheerio.load(optionsResponse.data);
    const latestDate = $options('#ContentPlaceHolder1_C002_ddlLpg option').first().attr('value');
    
    if (!latestDate) throw new Error('Tarih bulunamadı');

    // Her şehir için fiyat çek
    for (const city of CITIES) {
      try {
        // Benzin + Motorin
        const fuelResponse = await axios.post(
          'https://www.aytemiz.com.tr/akaryakit-fiyatlari/arsiv-fiyat-listesi',
          new URLSearchParams({
            'ContentPlaceHolder1_C002_rdbPriceType': '0',
            'ContentPlaceHolder1_C002_ddlLpg': latestDate,
            'ContentPlaceHolder1_C002_selCities': city,
            'ContentPlaceHolder1_C002_btnSorgula': 'Sorgula'
          }),
          {
            headers: { 
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            timeout: 15000
          }
        );

        const $fuel = cheerio.load(fuelResponse.data);
        const table = $fuel('#ContentPlaceHolder1_C002_gvList tbody tr');
        
        const brands = {};
        table.each((_, row) => {
          const cells = $fuel(row).find('td');
          if (cells.length >= 3) {
            const brand = $fuel(cells.eq(0)).text().trim().toUpperCase();
            const benzin = parseFloat($fuel(cells.eq(1)).text().trim().replace(',', '.'));
            const motorin = parseFloat($fuel(cells.eq(2)).text().trim().replace(',', '.'));
            
            if (brand && !isNaN(benzin) && !isNaN(motorin)) {
              if (!brands[brand]) brands[brand] = [];
              brands[brand].push({ benzin, motorin });
            }
          }
        });

        // LPG fiyatlarını çek
        const lpgResponse = await axios.post(
          'https://www.aytemiz.com.tr/akaryakit-fiyatlari/arsiv-fiyat-listesi',
          new URLSearchParams({
            'ContentPlaceHolder1_C002_rdbPriceType': '1',
            'ContentPlaceHolder1_C002_ddlLpg': latestDate,
            'ContentPlaceHolder1_C002_selCities': city,
            'ContentPlaceHolder1_C002_btnSorgula': 'Sorgula'
          }),
          {
            headers: { 
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            timeout: 15000
          }
        );

        const $lpg = cheerio.load(lpgResponse.data);
        const lpgTable = $lpg('#ContentPlaceHolder1_C002_gvList tbody tr');
        
        const lpgByBrand = {};
        lpgTable.each((_, row) => {
          const cells = $lpg(row).find('td');
          if (cells.length >= 2) {
            const brand = $lpg(cells.eq(0)).text().trim().toUpperCase();
            const lpg = parseFloat($lpg(cells.eq(1)).text().trim().replace(',', '.'));
            
            if (brand && !isNaN(lpg)) {
              if (!lpgByBrand[brand]) lpgByBrand[brand] = [];
              lpgByBrand[brand].push(lpg);
            }
          }
        });

        // Markaları şehire göre kaydet
        for (const [brand, prices] of Object.entries(brands)) {
          if (!allBrandPrices[brand]) allBrandPrices[brand] = {};
          
          const avgBenzin = prices.reduce((a, b) => a + b.benzin, 0) / prices.length;
          const avgMotorin = prices.reduce((a, b) => a + b.motorin, 0) / prices.length;
          const avgLpg = lpgByBrand[brand] 
            ? lpgByBrand[brand].reduce((a, b) => a + b, 0) / lpgByBrand[brand].length 
            : null;
          
          allBrandPrices[brand][city.toUpperCase()] = {
            benzin: parseFloat(avgBenzin.toFixed(2)),
            motorin: parseFloat(avgMotorin.toFixed(2)),
            lpg: avgLpg ? parseFloat(avgLpg.toFixed(2)) : null
          };
        }

        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.log(`${city} hatası:`, err.message);
      }
    }

    return { 
      ok: Object.keys(allBrandPrices).length > 0,
      prices: allBrandPrices,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Scrape hatası:', error);
    return { ok: false, prices: {}, error: error.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=3600');

  try {
    // GET /api/prices - Cachedlenen fiyatları döndür
    if (req.url.includes('/api/prices')) {
      if (cachedPrices && Date.now() - lastUpdateTime < CACHE_DURATION) {
        return res.status(200).json(cachedPrices);
      }
      
      const result = await scrapeAytemiz();
      if (result.ok) {
        cachedPrices = { prices: result.prices };
        lastUpdateTime = Date.now();
        return res.status(200).json(cachedPrices);
      }
      return res.status(500).json({ error: 'Fiyatlar çekilemedi' });
    }

    // POST /api/update - Fiyatları güncelle
    if (req.url.includes('/api/update')) {
      const result = await scrapeAytemiz();
      if (result.ok) {
        cachedPrices = { prices: result.prices };
        lastUpdateTime = Date.now();
        return res.status(200).json({ success: true, cities: Object.values(result.prices).length });
      }
      return res.status(500).json({ success: false, error: result.error });
    }

    res.status(404).json({ error: 'Endpoint bulunamadı' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
