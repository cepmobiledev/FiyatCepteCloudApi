import axios from 'axios';
import * as cheerio from 'cheerio';

const CITIES = [
  'ADANA', 'ADIYAMAN', 'AFYON', 'AGRI', 'AKSARAY', 'AMASYA', 'ANKARA', 'ANTALYA',
  'ARDAHAN', 'ARTVIN', 'AYDIN', 'BALIKESIR', 'BARTIN', 'BATMAN', 'BAYBURT',
  'BILECIK', 'BINGOL', 'BITLIS', 'BOLU', 'BURDUR', 'BURSA', 'CANAKKALE',
  'CANKIRI', 'CORUM', 'DENIZLI', 'DIYARBAKIR', 'DUZCE', 'EDIRNE', 'ELAZIG',
  'ERZINCAN', 'ERZURUM', 'ESKISEHIR', 'GAZIANTEP', 'GIRESUN', 'GUMUSHANE',
  'HAKKARI', 'HATAY', 'IGDIR', 'ISPARTA', 'ISTANBUL', 'IZMIR', 'K.MARAS',
  'KARABUK', 'KARAMAN', 'KARS', 'KASTAMONU', 'KAYSERI', 'KILIS', 'KIRIKKALE',
  'KIRKLARELI', 'KIRSEHIR', 'KOCAELI', 'KONYA', 'KUTAHYA', 'MALATYA', 'MANISA',
  'MARDIN', 'MERSIN', 'MUGLA', 'MUS', 'NEVSEHIR', 'NIGDE', 'ORDU', 'OSMANIYE',
  'RIZE', 'SAKARYA', 'SAMSUN', 'SANLIURFA', 'SIIRT', 'SINOP', 'SIRNAK', 'SIVAS',
  'TEKIRDAG', 'TOKAT', 'TRABZON', 'TUNCELI', 'USAK', 'VAN', 'YALOVA', 'YOZGAT',
  'ZONGULDAK'
];

async function scrapeAytemiz() {
  const prices = {};
  const errors = [];
  
  try {
    // İlk olarak en son tarihi almak için bir sorgu yap
    const initResponse = await axios.get('https://www.aytemiz.com.tr/akaryakit-fiyatlari/arsiv-fiyat-listesi', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });
    
    const $init = cheerio.load(initResponse.data);
    const latestDate = $init('#ContentPlaceHolder1_C002_ddlLpg option').first().attr('value');
    
    if (!latestDate) {
      throw new Error('Tarih bulunamadı');
    }

    // Her şehir için fiyatları çek
    for (const city of CITIES) {
      try {
        // Benzin/Motorin fiyatları
        const fuelResponse = await axios.post('https://www.aytemiz.com.tr/akaryakit-fiyatlari/arsiv-fiyat-listesi', 
          `ContentPlaceHolder1_C002_rdbPriceType=0&ContentPlaceHolder1_C002_ddlLpg=${latestDate}&ContentPlaceHolder1_C002_selCities=${city}&ContentPlaceHolder1_C002_btnSorgula=Sorgula`,
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
          }
        );

        // LPG fiyatları
        const lpgResponse = await axios.post('https://www.aytemiz.com.tr/akaryakit-fiyatlari/arsiv-fiyat-listesi',
          `ContentPlaceHolder1_C002_rdbPriceType=1&ContentPlaceHolder1_C002_ddlLpg=${latestDate}&ContentPlaceHolder1_C002_selCities=${city}&ContentPlaceHolder1_C002_btnSorgula=Sorgula`,
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
          }
        );

        // Parse fuel prices
        const $fuel = cheerio.load(fuelResponse.data);
        const fuelRows = $fuel('#ContentPlaceHolder1_C002_gvList tr').slice(1); // İlk satır header
        
        let benzinSum = 0, motorinSum = 0, count = 0;
        
        fuelRows.each((i, row) => {
          const cols = $fuel(row).find('td');
          if (cols.length >= 3) {
            const benzin = parseFloat($fuel(cols.eq(1)).text().trim().replace(',', '.'));
            const motorin = parseFloat($fuel(cols.eq(2)).text().trim().replace(',', '.'));
            if (!isNaN(benzin) && !isNaN(motorin)) {
              benzinSum += benzin;
              motorinSum += motorin;
              count++;
            }
          }
        });

        // Parse LPG prices
        const $lpg = cheerio.load(lpgResponse.data);
        const lpgRows = $lpg('#ContentPlaceHolder1_C002_gvList tr').slice(1);
        
        let lpgSum = 0, lpgCount = 0;
        
        lpgRows.each((i, row) => {
          const cols = $lpg(row).find('td');
          if (cols.length >= 2) {
            const lpg = parseFloat($lpg(cols.eq(1)).text().trim().replace(',', '.'));
            if (!isNaN(lpg)) {
              lpgSum += lpg;
              lpgCount++;
            }
          }
        });

        // Ortalama fiyatları kaydet
        if (count > 0 && lpgCount > 0) {
          prices[city] = {
            benzin: (benzinSum / count).toFixed(2),
            motorin: (motorinSum / count).toFixed(2),
            lpg: (lpgSum / lpgCount).toFixed(2)
          };
        }

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (cityError) {
        errors.push(`${city}: ${cityError.message}`);
      }
    }

  } catch (error) {
    return { ok: false, error: error.message, prices: {}, cityCount: 0 };
  }

  return {
    ok: Object.keys(prices).length > 0,
    prices,
    cityCount: Object.keys(prices).length,
    errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
    date: new Date().toISOString()
  };
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Mevcut fiyatları getir
    // Burada cache/database'den fiyatları döndürürsün
    res.status(200).json({ message: 'Price API ready' });
  } else if (req.method === 'POST' && req.query.action === 'update') {
    // Manuel güncelleme tetikle
    const aytemizData = await scrapeAytemiz();
    
    res.status(200).json({
      sources: {
        aytemiz: aytemizData
      },
      totalCities: aytemizData.cityCount,
      lastUpdate: new Date().toISOString()
    });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}
