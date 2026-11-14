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

// Stejný fail-closed princip jako ziskatTestApiBase výš, ale pro PŘÍMÉ
// připojení k databázi (pg) — potřebné jen pro testy, co musí sestavit
// přesně kontrolovanou fixturu přes raw SQL (např. zpětné datování
// konkrétního řádku "platby" při testování rozpoznání peněz podle měsíce),
// ne přes běžné HTTP API. Produkční hostname (aws-1-eu-west-1...) je
// natvrdo zakázaný, i kdyby DATABASE_URL v prostředí omylem ukazovalo tam.
function ziskatTestDatabaseUrl() {
  const hodnota = process.env.DATABASE_URL;
  if (!hodnota || !hodnota.trim()) {
    console.error(
      'Chybí DATABASE_URL v prostředí — test se odmítá spustit (žádný implicitní fallback na produkci).\n' +
      'Nastavte DATABASE_URL z .env.test (TEST databáze), ne z .env.production.'
    );
    process.exit(1);
  }
  const cista = hodnota.trim();
  if (/aws-1-eu-west-1\.pooler\.supabase\.com/i.test(cista)) {
    console.error('DATABASE_URL míří na PRODUKČNÍ databázi (aws-1-eu-west-1.pooler.supabase.com) — test se odmítá spustit.');
    process.exit(1);
  }
  return cista;
}

module.exports = { ziskatTestApiBase, ziskatTestDatabaseUrl };
