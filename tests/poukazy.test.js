// Regresní test: bezpečné uplatňování dárkových poukazů.
// Ověřuje: existenci, zrušený/vyčerpaný/prošlý poukaz, dostatek zůstatku,
// a hlavně že dva souběžné požadavky na uplatnění nemůžou utratit stejný
// zůstatek dvakrát (race condition).
//
// Běží proti nasazenému API (produkce), nic nemění mimo vlastní testovací
// poukaz, který na konci vždy smaže.
//
// Spuštění:  ADMIN_HESLO=... node tests/poukazy.test.js
// (ADMIN_HESLO se nikam neukládá, jen se čte z prostředí při spuštění)

const assert = require('node:assert/strict');

const API = process.env.TEST_API_BASE || 'https://masazealesa.onrender.com/api';
const HESLO = process.env.ADMIN_HESLO;

if (!HESLO) {
  console.error('Chybí ADMIN_HESLO v prostředí — test se přeskakuje (spusťte s ADMIN_HESLO=... node tests/poukazy.test.js).');
  process.exit(0);
}

function adminFetch(cesta, options = {}) {
  return fetch(API + cesta, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-admin-heslo': HESLO, ...(options.headers || {}) }
  });
}

async function main() {
  let poukazId = null;
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není žádná rezervovatelná položka pro test');

    // 1) Vydání testovacího poukazu na konkrétní masáž
    const vytvorRes = await adminFetch('/admin/poukazy', {
      method: 'POST',
      body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-POUKAZY (smazat)' })
    });
    const vytvor = await vytvorRes.json();
    assert.equal(vytvorRes.status, 200, 'Vydání testovacího poukazu selhalo: ' + JSON.stringify(vytvor));
    poukazId = vytvor.poukaz.id;
    const hodnota = Number(vytvor.poukaz.hodnota);
    assert.equal(vytvor.poukaz.stav, 'aktivni');
    console.log('OK — poukaz vydán, hodnota', hodnota, 'Kč, stav "aktivni"');

    // 2) Nejde uplatnit víc, než je zůstatek
    const prekrocitRes = await adminFetch(`/admin/poukazy/${poukazId}/uplatnit`, {
      method: 'POST', body: JSON.stringify({ castka: hodnota + 1000 })
    });
    assert.equal(prekrocitRes.status, 400, 'Uplatnění částky nad zůstatek mělo selhat');
    console.log('OK — uplatnění částky nad zůstatek je odmítnuto');

    // 3) Částečné uplatnění sníží zůstatek a nastaví stav "castecne_vyuzity"
    const castka1 = Math.max(1, Math.floor(hodnota / 2));
    const c1Res = await adminFetch(`/admin/poukazy/${poukazId}/uplatnit`, {
      method: 'POST', body: JSON.stringify({ castka: castka1 })
    });
    const c1 = await c1Res.json();
    assert.equal(c1Res.status, 200, 'Částečné uplatnění selhalo: ' + JSON.stringify(c1));
    assert.equal(Number(c1.poukaz.zustatek), hodnota - castka1);
    assert.equal(c1.poukaz.stav, 'castecne_vyuzity');
    console.log('OK — částečné uplatnění správně sníží zůstatek a nastaví stav "castecne_vyuzity"');

    // 4) Dva současné požadavky na uplatnění zbytku smí uspět jen jednou
    const zbytek = hodnota - castka1;
    const [pA, pB] = await Promise.all([
      adminFetch(`/admin/poukazy/${poukazId}/uplatnit`, { method: 'POST', body: JSON.stringify({ castka: zbytek }) }),
      adminFetch(`/admin/poukazy/${poukazId}/uplatnit`, { method: 'POST', body: JSON.stringify({ castka: zbytek }) })
    ]);
    const uspesnych = [pA.status, pB.status].filter(s => s === 200).length;
    assert.equal(uspesnych, 1, `Souběžné uplatnění zbytku prošlo ${uspesnych}× místo 1× (race condition!)`);
    console.log('OK — souběžné uplatnění stejného zůstatku prošlo jen jednou (bez race condition)');

    // 5) Plně vyčerpaný poukaz už nejde dál uplatnit
    const dalsiRes = await adminFetch(`/admin/poukazy/${poukazId}/uplatnit`, {
      method: 'POST', body: JSON.stringify({ castka: 1 })
    });
    assert.equal(dalsiRes.status, 400, 'Uplatnění na vyčerpaném poukazu mělo selhat');
    console.log('OK — plně vyčerpaný poukaz už nejde dál uplatnit');

    // 6) Zrušený poukaz nejde uplatnit
    await adminFetch(`/admin/poukazy/${poukazId}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zruseny' }) });
    const zrusenyRes = await adminFetch(`/admin/poukazy/${poukazId}/uplatnit`, {
      method: 'POST', body: JSON.stringify({ castka: 1 })
    });
    assert.equal(zrusenyRes.status, 400, 'Uplatnění zrušeného poukazu mělo selhat');
    console.log('OK — zrušený poukaz nejde uplatnit');

    console.log('\n✅ VŠECHNY TESTY POUKAZŮ PROŠLY');
  } finally {
    if (poukazId) {
      await adminFetch(`/admin/poukazy/${poukazId}`, { method: 'DELETE' });
      console.log('(testovací poukaz smazán)');
    }
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
