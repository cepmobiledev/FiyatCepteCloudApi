// cloud-api/api/prices.js
export default function handler(req, res) {
  // Burada fiyat verilerini döndür
  res.status(200).json({ message: "Fiyatlar burada!" });
}
