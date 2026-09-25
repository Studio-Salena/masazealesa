// Regresní test: tržba za rezervaci se musí v účetnictví počítat podle DATA
// MASÁŽE (rezervace.datum), ne podle data, kdy byla rezervace vytvořena
// (vytvoreno). Vytvoří testovací rezervaci na termín ~120 dní dopředu a ověří,
// že se v přehledu objeví pod tímto budoucím datem, ne pod dneškem.
//
// Spuštění:  ADMIN_HESLO=... node tests/ucetnictvi.test.js

const assert = require('node:assert/strict');

const API = process.env.TEST_API_BASE || 'https://masazealesa.onrender.com/api';
const HESLO = process.env.ADMIN_HESLO;

if (!HESLO) {
  console.error('Chybí ADMIN_HESLO v prostředí — test se přeskakuje (spusťte s ADMIN_HESLO=... node tests/ucetnictvi.test.js).');
  process.exit(0);
}

function adminFetch(cesta, options = {}) {
  return fetch(API + cesta, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-admin-heslo': HESLO, ...(options.headers || {}) }
  });
}

async function najitVolnyTermin(datum, cenikId) {
  const terminy = await fetch(`${API}/rezervace/volne-terminy?datum=${datum}&cenik_id=${cenikId}`).then(r => r.json());
  const volny = Array.isArray(terminy) ? terminy.find(t => t.volno) : null;
  return volny ? volny.cas : null;
}

async function main() {
  let rezervaceId = null;
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');

    // Termín daleko v budoucnu (mimo dnešek), ať je jistě volný a jasně odlišný od "dnes"
    let datumIso = null, cas = null;
    for (let i = 90; i < 150 && !cas; i += 7) {
      const d = new Date(); d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const nalezenyCas = await najitVolnyTermin(iso, polozka.id);
      if (nalezenyCas) { datumIso = iso; cas = nalezenyCas; }
    }
    assert.ok(cas, 'Nenalezen žádný volný termín v rozmezí 90–150 dní pro test');

    const vytvorRes = await adminFetch('/admin/rezervace', {
      method: 'POST',
      body: JSON.stringify({ cenik_id: polozka.id, datum: datumIso, cas_od: cas, jmeno: 'TEST-UCETNICTVI (smazat)' })
    });
    const vytvor = await vytvorRes.json();
    assert.equal(vytvorRes.status, 200, 'Vytvoření testovací rezervace selhalo: ' + JSON.stringify(vytvor));
    rezervaceId = vytvor.rezervace.id;
    console.log('OK — testovací rezervace vytvořena na', datumIso, cas);

    const ucetnictvi = await adminFetch('/admin/ucetnictvi').then(r => r.json());
    const dnesIso = new Date().toISOString().slice(0, 10);

    const polozkaPodDatumMasaze = ucetnictvi.polozky.find(p =>
      p.zdroj === 'rezervace' && p.datum.slice(0, 10) === datumIso && Number(p.castka) === Number(polozka.cena)
    );
    assert.ok(polozkaPodDatumMasaze, 'Rezervace se v účetnictví neobjevila pod datem masáže — chyba přetrvává');
    console.log('OK — tržba je v účetnictví započtená pod datem masáže (' + datumIso + ')');

    const polozkaPodDnesniDatum = ucetnictvi.polozky.find(p =>
      p.zdroj === 'rezervace' && p.datum.slice(0, 10) === dnesIso && Number(p.castka) === Number(polozka.cena) && p.vytvoreno.slice(0, 10) === dnesIso
    );
    // Nezaměnit: vytvoreno je dnes (rezervace se vytvořila teď), ale datum (den masáže) je v budoucnu —
    // pokud by chyba přetrvávala, položka by se objevila i pod dnešním dnem, což nesmí.
    assert.equal(polozkaPodDnesniDatum, undefined, 'Rezervace se chybně objevila i pod dnešním datem (podle vytvoreno, ne podle datum masáže)');
    console.log('OK — tržba se NEZAPOČÍTALA pod dnešní datum, i když byla rezervace vytvořena dnes');

    console.log('\n✅ VŠECHNY TESTY ÚČETNICTVÍ PROŠLY');
  } finally {
    if (rezervaceId) {
      await adminFetch(`/admin/rezervace/${rezervaceId}`, { method: 'DELETE' });
      console.log('(testovací rezervace smazána)');
    }
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
