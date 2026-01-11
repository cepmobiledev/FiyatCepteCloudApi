// api/cloud.js
module.exports = async (req, res) => {
  // Basit health endpoint
  if (req.url.endsWith('/health')) {
    return res.status(200).json({ ok: true, message: 'API Çalışıyor!' });
  }
  // Basit prices endpoint (örnek veri)
  if (req.url.endsWith('/prices')) {
    return res.status(200).json({
      prices: {
        ISTANBUL: { benzin: 43.62, motorin: 41.95, lpg: 22.45 },
        ANKARA: { benzin: 43.10, motorin: 41.40, lpg: 21.90 }
      },
      lastUpdate: new Date().toISOString()
    });
  }
  // Basit update endpoint (dummy)
  if (req.url.endsWith('/update')) {
    return res.status(200).json({ ok: true, updated: true, date: new Date().toISOString() });
  }
  // Default: prices
  return res.status(200).json({
    prices: {
      ISTANBUL: { benzin: 43.62, motorin: 41.95, lpg: 22.45 },
      ANKARA: { benzin: 43.10, motorin: 41.40, lpg: 21.90 }
    },
    lastUpdate: new Date().toISOString()
  });
};
