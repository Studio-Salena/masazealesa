// Regresní test: ochrana EET přepínačů v obecném endpointu nastavení.
//
// Kontext: GET/PUT/DELETE /api/admin/nastaveni/:klic je obecný endpoint pro
// VŠECHNA nastavení administrace (otvírací doba, připomínky, obrázky
// poukazů...). Audit před produkčním nasazením Kroku 3b zjistil, že přes
// tenhle endpoint šlo bez jakékoli ochrany změnit i klíče "eet_*" (aktivace
// evidence/odesílání EET) — admin.html ho na EET dnes nikdy nevolá, ale
// samotný endpoint to nijak nezakazoval. Tenhle test ověřuje opravu.
//
// Cíl testu:
//  1) PUT na "eet_evidence_zapnuta" je odmítnut (403), hodnota se nezmění.
//  2) PUT na "eet_odesilani_pozastaveno" je odmítnut (403), hodnota se nezmění.
//  3) PUT na libovolný JINÝ klíč začínající "eet_" (i neexistující) je odmítnut.
//  4) DELETE na klíč "eet_*" je odmítnut (403), řádek zůstává.
//  5) Běžné, nesouvisející nastavení (buffer_minut) PUT i nadále funguje beze změny.
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=http://localhost:3001/api DATABASE_URL=... node tests/eet-ochrana-nastaveni.test.js

const assert = require('node:assert/strict');
const { Client } = require('pg');
const { ziskatTestApiBase, ziskatTestDatabaseUrl } = require('./env-guard');

const API = ziskatTestApiBase();
const DB_URL = ziskatTestDatabaseUrl();
const HESLO = process.env.ADMIN_HESLO;
if (!HESLO) { console.error('Chybí ADMIN_HESLO v prostředí.'); process.exit(1); }

function adminFetch(cesta, opts = {}) {
  return fetch(API + cesta, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-admin-heslo': HESLO, ...(opts.headers || {}) }
  });
}

async function main() {
  console.log('--- Ochrana EET přepínačů v /api/admin/nastaveni ---');
  const c = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    // 1) eet_evidence_zapnuta — PUT odmítnut, hodnota beze změny
    {
      const pred = (await c.query(`SELECT hodnota FROM nastaveni WHERE klic = 'eet_evidence_zapnuta'`)).rows[0];
      const res = await adminFetch('/admin/nastaveni/eet_evidence_zapnuta', { method: 'PUT', body: JSON.stringify({ hodnota: 'true' }) });
      const data = await res.json();
      assert.equal(res.status, 403, '1a) PUT na eet_evidence_zapnuta musí vrátit 403: ' + JSON.stringify(data));
      const po = (await c.query(`SELECT hodnota FROM nastaveni WHERE klic = 'eet_evidence_zapnuta'`)).rows[0];
      assert.equal(po ? po.hodnota : null, pred ? pred.hodnota : null, '1b) hodnota se nesmí změnit');
      console.log('OK — 1) eet_evidence_zapnuta nelze zapnout přes PUT /admin/nastaveni');
    }

    // 2) eet_odesilani_pozastaveno — PUT odmítnut, hodnota beze změny
    {
      const pred = (await c.query(`SELECT hodnota FROM nastaveni WHERE klic = 'eet_odesilani_pozastaveno'`)).rows[0];
      const res = await adminFetch('/admin/nastaveni/eet_odesilani_pozastaveno', { method: 'PUT', body: JSON.stringify({ hodnota: 'false' }) });
      const data = await res.json();
      assert.equal(res.status, 403, '2a) PUT na eet_odesilani_pozastaveno musí vrátit 403: ' + JSON.stringify(data));
      const po = (await c.query(`SELECT hodnota FROM nastaveni WHERE klic = 'eet_odesilani_pozastaveno'`)).rows[0];
      assert.equal(po ? po.hodnota : null, pred ? pred.hodnota : null, '2b) hodnota se nesmí změnit');
      console.log('OK — 2) eet_odesilani_pozastaveno nelze vypnout přes PUT /admin/nastaveni');
    }

    // 3) Libovolný jiný klíč začínající "eet_" (i neexistující, i jiná velikost písmen)
    {
      const res1 = await adminFetch('/admin/nastaveni/eet_id_jednotky', { method: 'PUT', body: JSON.stringify({ hodnota: '12345' }) });
      assert.equal(res1.status, 403, '3a) PUT na eet_id_jednotky musí vrátit 403');
      const res2 = await adminFetch('/admin/nastaveni/eet_neexistujici_klic', { method: 'PUT', body: JSON.stringify({ hodnota: 'cokoliv' }) });
      assert.equal(res2.status, 403, '3b) PUT na libovolný NEEXISTUJÍCÍ klíč začínající eet_ musí vrátit 403 (nejde ho tak nenápadně založit)');
      const res3 = await adminFetch('/admin/nastaveni/EET_VELKA_PISMENA', { method: 'PUT', body: JSON.stringify({ hodnota: 'cokoliv' }) });
      assert.equal(res3.status, 403, '3c) kontrola nesmí jít obejít velkými písmeny');
      const existuje = (await c.query(`SELECT 1 FROM nastaveni WHERE klic IN ('eet_neexistujici_klic','EET_VELKA_PISMENA')`)).rows;
      assert.equal(existuje.length, 0, '3d) žádný z odmítnutých klíčů se nesmí v databázi objevit');
      console.log('OK — 3) libovolný klíč začínající "eet_" (i neexistující, i jiná velikost písmen) je odmítnut');
    }

    // 4) DELETE na klíč "eet_*" — odmítnut, řádek zůstává
    {
      const res = await adminFetch('/admin/nastaveni/eet_odesilani_pozastaveno', { method: 'DELETE' });
      assert.equal(res.status, 403, '4a) DELETE na eet_odesilani_pozastaveno musí vrátit 403');
      const po = (await c.query(`SELECT hodnota FROM nastaveni WHERE klic = 'eet_odesilani_pozastaveno'`)).rows[0];
      assert.ok(po, '4b) řádek musí v databázi zůstat');
      assert.equal(po.hodnota, 'true', '4c) hodnota musí zůstat "true" (EET odesílání stále pozastavené)');
      console.log('OK — 4) DELETE na klíč "eet_*" je odmítnut, řádek zůstává');
    }

    // 5) Běžné, nesouvisející nastavení dál funguje beze změny
    {
      const pred = (await c.query(`SELECT hodnota FROM nastaveni WHERE klic = 'buffer_minut'`)).rows[0];
      const novaHodnota = pred && pred.hodnota === '45' ? '30' : '45';
      const res = await adminFetch('/admin/nastaveni/buffer_minut', { method: 'PUT', body: JSON.stringify({ hodnota: novaHodnota }) });
      const data = await res.json();
      assert.equal(res.status, 200, '5a) PUT na běžné nastavení (buffer_minut) musí i nadále uspět: ' + JSON.stringify(data));
      const po = (await c.query(`SELECT hodnota FROM nastaveni WHERE klic = 'buffer_minut'`)).rows[0];
      assert.equal(po.hodnota, novaHodnota, '5b) hodnota se musí skutečně změnit');
      // vrátit zpět na původní hodnotu, ať test nezanechá vedlejší efekt
      await adminFetch('/admin/nastaveni/buffer_minut', { method: 'PUT', body: JSON.stringify({ hodnota: pred ? pred.hodnota : '30' }) });
      console.log('OK — 5) běžné nastavení (buffer_minut) funguje beze změny — ochrana se týká JEN klíčů "eet_*"');
    }

    console.log('\n✅ VŠECHNY TESTY OCHRANY EET PŘEPÍNAČŮ PROŠLY');
  } finally {
    await c.end();
  }
}

main().catch(e => { console.error('❌ CHYBA TESTU:', e.message); process.exitCode = 1; });
