// Bezpečnostní regresní test: CVE-2026-111181 (body-parser DoS přes
// zkomprimované tělo požadavku s odpadními bajty navíc po platném gzip
// rámci — útočník odešle JEDEN požadavek, který shodí celý proces).
//
// Oprava: body-parser 1.20.6 -> 1.20.9 (viz package-lock.json; express sám
// deklaruje rozsah "~1.20.5", 1.20.9 je v něm obsažená, takže šlo o čistě
// transitivní bump beze změny package.json).
//
// Tento test běží VÝHRADNĚ proti lokálnímu TEST serveru (env-guard.js
// odmítne produkční URL) — žádný útočný požadavek nikdy nejde na produkci.
//
// Spuštění:  TEST_API_BASE=http://localhost:3001/api node tests/zabezpeceni-body-parser-cve.test.js
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { ziskatTestApiBase } = require('./env-guard');

const API = ziskatTestApiBase();

async function zije() {
  try {
    const res = await fetch(API + '/cenik');
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log('--- Bezpečnostní test: CVE-2026-111181 (body-parser, zkomprimované tělo + odpadní bajty) ---');

  assert.equal(await zije(), true, 'TEST server musí běžet a odpovídat ještě PŘED útočným požadavkem');

  // Platný gzip rámec s JSON tělem, PLUS odpadní bajty navíc za ním — přesně
  // vzorec z GHSA-27r3-jxmh-p828: "jeden platný komprimovaný rámec,
  // následovaný koncovými bajty", který ve zranitelné verzi po úspěšném
  // dekódování prvního rámce vyhodí nezachycenou výjimku z již ukončeného
  // dekodéru a shodí celý Node.js proces (ne jen tenhle jeden request).
  const platnyGzip = zlib.gzipSync(Buffer.from(JSON.stringify({ kod: 'X' })));
  const odpadniBajty = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const utocnyPayload = Buffer.concat([platnyGzip, odpadniBajty]);

  // /api/login je POST bez autentizace, tělo se parsuje přes express.json()
  // ještě PŘED jakoukoli autorizační kontrolou — přesně cesta, kterou by
  // útočník reálně zneužil (nepotřebuje žádné heslo ani přihlášení).
  let odpovedStatus = null;
  let selhalPozadavek = false;
  try {
    const res = await fetch(API + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: utocnyPayload
    });
    odpovedStatus = res.status;
  } catch (e) {
    // I "selhání" samotného požadavku (např. ECONNRESET, pokud proces spadl
    // uprostřed spojení) je validní výsledek TOHOTO požadavku — klíčové je,
    // co se stane POTOM (viz kontrola "zije()" níž).
    selhalPozadavek = true;
    console.log(`  (požadavek sám skončil chybou spojení: ${e.message} — ověřuji teď, že server přesto žije dál)`);
  }

  console.log(`  útočný požadavek vyřízen, HTTP status: ${selhalPozadavek ? '(spojení selhalo)' : odpovedStatus}`);

  // KLÍČOVÉ OVĚŘENÍ: server musí žít dál a normálně odpovídat na DALŠÍ,
  // zcela běžný požadavek. Pokud by byl proces spadl (zranitelná verze),
  // tohle by selhalo (ECONNREFUSED).
  const ziveiPoUtoku = await zije();
  assert.equal(ziveiPoUtoku, true, 'KRITICKÉ: server NEPŘEŽIL útočný požadavek — CVE-2026-111181 by stále bylo přítomné!');

  console.log('OK — server přežil požadavek se zkomprimovaným tělem + odpadními bajty navíc (CVE-2026-111181 opraveno)');
  console.log('\n✅ BEZPEČNOSTNÍ TEST PROŠEL');
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
