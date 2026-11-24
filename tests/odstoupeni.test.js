// Regresní test: online odstoupení od smlouvy (čl. 4 obchodních podmínek,
// povinnost zpřístupnit i online kanál od 1. 1. 2027).
//
// Běží VÝHRADNĚ proti izolovanému testovacímu prostředí (viz env-guard.js —
// fail-closed, žádný produkční fallback). Nic nemění mimo vlastní testovací
// oznámení, která na konci vždy smaže.
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=... node tests/odstoupeni.test.js

const assert = require('node:assert/strict');
const { ziskatTestApiBase } = require('./env-guard');
const API = ziskatTestApiBase(); // Fáze 7C.6 — fail-closed, žádný produkční fallback
const HESLO = process.env.ADMIN_HESLO;

if (!HESLO) {
  console.error('Chybí ADMIN_HESLO v prostředí — test se přeskakuje (spusťte s ADMIN_HESLO=... node tests/odstoupeni.test.js).');
  process.exit(0);
}

function adminFetch(cesta, options = {}) {
  return fetch(API + cesta, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-admin-heslo': HESLO, ...(options.headers || {}) }
  });
}
async function odstoupeni(telo) {
  const r = await fetch(API + '/odstoupeni', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(telo)
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

async function main() {
  const uklid = [];
  try {
    // 1) validní oznámení (jen e-mail) → 200, výchozí stav "nova"
    {
      const v = await odstoupeni({ popis_sluzby: 'TEST: Rezervace masáže 1.1.2027 (smazat)', jmeno: 'TEST-ODSTOUPENI (smazat)', email: 'test-odstoupeni-1@example.invalid' });
      assert.equal(v.status, 200, JSON.stringify(v.data));
      assert.equal(v.data.zadost.stav, 'nova');
      uklid.push(v.data.zadost.id);
      console.log('OK — 1) validní oznámení (jen e-mail) → 200, stav "nova"');
    }

    // 2) validní oznámení (jen telefon, bez e-mailu) → 200
    {
      const v = await odstoupeni({ popis_sluzby: 'TEST: Rezervace masáže (smazat)', jmeno: 'TEST-ODSTOUPENI (smazat)', telefon: '602123456' });
      assert.equal(v.status, 200, JSON.stringify(v.data));
      uklid.push(v.data.zadost.id);
      console.log('OK — 2) validní oznámení (jen telefon) → 200');
    }

    // 3) chybí popis_sluzby → 400
    {
      const v = await odstoupeni({ jmeno: 'TEST-ODSTOUPENI (smazat)', email: 'test-odstoupeni-3@example.invalid' });
      assert.equal(v.status, 400, JSON.stringify(v.data));
      console.log('OK — 3) chybějící popis_sluzby → 400');
    }

    // 4) chybí jméno → 400
    {
      const v = await odstoupeni({ popis_sluzby: 'TEST (smazat)', email: 'test-odstoupeni-4@example.invalid' });
      assert.equal(v.status, 400, JSON.stringify(v.data));
      console.log('OK — 4) chybějící jméno → 400');
    }

    // 5) chybí e-mail i telefon zároveň → 400
    {
      const v = await odstoupeni({ popis_sluzby: 'TEST (smazat)', jmeno: 'TEST-ODSTOUPENI (smazat)' });
      assert.equal(v.status, 400, JSON.stringify(v.data));
      console.log('OK — 5) chybějící e-mail i telefon zároveň → 400');
    }

    // 6) neplatný e-mail → 400
    {
      const v = await odstoupeni({ popis_sluzby: 'TEST (smazat)', jmeno: 'TEST-ODSTOUPENI (smazat)', email: 'neplatny-email' });
      assert.equal(v.status, 400, JSON.stringify(v.data));
      console.log('OK — 6) neplatný e-mail → 400');
    }

    // 7) neplatné datum uzavření smlouvy → 400
    {
      const v = await odstoupeni({ popis_sluzby: 'TEST (smazat)', jmeno: 'TEST-ODSTOUPENI (smazat)', email: 'test-odstoupeni-7@example.invalid', datum_uzavreni_smlouvy: 'neplatne-datum' });
      assert.equal(v.status, 400, JSON.stringify(v.data));
      console.log('OK — 7) neplatné datum uzavření smlouvy → 400');
    }

    // 8) admin vidí nové oznámení v seznamu
    {
      const v = await odstoupeni({ popis_sluzby: 'TEST-8: Rezervace masáže (smazat)', jmeno: 'TEST-ODSTOUPENI-8 (smazat)', email: 'test-odstoupeni-8@example.invalid', datum_uzavreni_smlouvy: '2026-12-01' });
      assert.equal(v.status, 200, JSON.stringify(v.data));
      uklid.push(v.data.zadost.id);
      const seznam = await adminFetch('/admin/odstoupeni').then(r => r.json());
      const nalezeno = seznam.find(o => o.id === v.data.zadost.id);
      assert.ok(nalezeno, '8) nové oznámení musí být vidět v admin seznamu');
      assert.equal(nalezeno.stav, 'nova');
      assert.equal(nalezeno.datum_uzavreni_smlouvy, '2026-12-01');
      console.log('OK — 8) admin vidí nové oznámení v seznamu se správnými údaji');
    }

    // 9) admin může oznámení označit jako vyřízené, pak jde smazat
    {
      const v = await odstoupeni({ popis_sluzby: 'TEST-9: Rezervace masáže (smazat)', jmeno: 'TEST-ODSTOUPENI-9 (smazat)', email: 'test-odstoupeni-9@example.invalid' });
      const id = v.data.zadost.id;
      const vyrizeno = await adminFetch(`/admin/odstoupeni/${id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'vyrizena' }) });
      assert.equal(vyrizeno.status, 200, JSON.stringify(await vyrizeno.json().catch(() => ({}))));
      const seznamPo = await adminFetch('/admin/odstoupeni').then(r => r.json());
      assert.equal(seznamPo.find(o => o.id === id).stav, 'vyrizena', '9) stav se měl změnit na "vyrizena"');

      const smazano = await adminFetch(`/admin/odstoupeni/${id}`, { method: 'DELETE' });
      assert.equal(smazano.status, 200);
      const seznamPoSmazani = await adminFetch('/admin/odstoupeni').then(r => r.json());
      assert.ok(!seznamPoSmazani.find(o => o.id === id), '9) smazané oznámení už nesmí být v seznamu');
      console.log('OK — 9) admin může oznámení označit jako vyřízené a smazat');
    }

    // 10) neexistující ID → 404 u PATCH i DELETE
    {
      const patch = await adminFetch('/admin/odstoupeni/999999999/stav', { method: 'PATCH', body: JSON.stringify({ stav: 'vyrizena' }) });
      assert.equal(patch.status, 404, 'PATCH na neexistující ID musí vrátit 404');
      const del = await adminFetch('/admin/odstoupeni/999999999', { method: 'DELETE' });
      assert.equal(del.status, 404, 'DELETE na neexistující ID musí vrátit 404');
      console.log('OK — 10) neexistující ID → 404 u PATCH i DELETE');
    }

    console.log('\n✅ VŠECHNY TESTY ODSTOUPENÍ OD SMLOUVY PROŠLY');
  } finally {
    for (const id of uklid) {
      await adminFetch(`/admin/odstoupeni/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    console.log(`(uklizeno: ${uklid.length} testovacích oznámení o odstoupení)`);
  }
}

main().catch(e => { console.error('❌ CHYBA TESTU:', e); process.exit(1); });
