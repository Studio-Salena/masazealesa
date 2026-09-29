// Sdílená fail-closed kontrola TEST_API_BASE (Fáze 7C.6). Používají ji
// všechny síťové testy místo dřívějšího:
//   process.env.TEST_API_BASE || 'https://masazealesa.onrender.com/api'
// Cíl: žádný test nesmí mít ŽÁDNOU cestu, jak bez výslovně a bezpečně
// nastaveného TEST_API_BASE dopadnout na produkci — ani tichým fallbackem,
// ani žádným ALLOW_PRODUCTION_TESTS obchvatem (záměrně žádný takový
// nezavádíme). TEST_API_BASE je POVINNÉ, produkční hostname je ZAKÁZANÝ,
// localhost (nebo cokoli jiného, co není produkce) je v pořádku.
function ziskatTestApiBase() {
  const hodnota = process.env.TEST_API_BASE;
  if (!hodnota || !hodnota.trim()) {
    console.error(
      'Chybí TEST_API_BASE v prostředí — test se odmítá spustit (žádný implicitní fallback na produkci).\n' +
      'Nastavte např.: TEST_API_BASE=http://localhost:3001/api'
    );
    process.exit(1);
  }
  const cista = hodnota.trim();
  if (/masazealesa\.onrender\.com/i.test(cista)) {
    console.error('TEST_API_BASE míří na produkční URL (masazealesa.onrender.com) — test se odmítá spustit.');
    process.exit(1);
  }
  return cista;
}

module.exports = { ziskatTestApiBase };
