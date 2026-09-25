// Regresní test: stav platby u rezervace (Fáze 2).
// Ověřuje 10 scénářů zadaných v zadání Fáze 2, včetně opraveného bugu
// "ruční rezervace bez telefonu nesmí skončit HTTP 500".
//
// Spuštění:  ADMIN_HESLO=... node tests/platby.test.js

const assert = require('node:assert/strict');

const API = process.env.TEST_API_BASE || 'https://masazealesa.onrender.com/api';
const HESLO = process.env.ADMIN_HESLO;

if (!HESLO) {
  console.error('Chybí ADMIN_HESLO v prostředí — test se přeskakuje (spusťte s ADMIN_HESLO=... node tests/platby.test.js).');
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

async function novyVolnyTermin(cenikId, odpocetDni) {
  for (let i = odpocetDni; i < odpocetDni + 60; i += 3) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const cas = await najitVolnyTermin(iso, cenikId);
    if (cas) return { datum: iso, cas };
  }
  throw new Error('Nenalezen volný termín pro test');
}

async function vytvorRezervaci(cenikId, telefonSuffix, extra = {}) {
  const { datum, cas } = await novyVolnyTermin(cenikId, 30 + Math.floor(Math.random() * 200));
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: cas, jmeno: 'TEST-PLATBY (smazat)', telefon: '00000' + telefonSuffix, ...extra })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'Vytvoření testovací rezervace selhalo: ' + JSON.stringify(data));
  return data.rezervace;
}

const uklidRezervace = [];
const uklidPoukazy = [];

async function main() {
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');
    const cena = Number(polozka.cena);

    // 10) Ruční rezervace bez telefonu nesmí skončit HTTP 500
    console.log('--- 10) rezervace bez telefonu ---');
    {
      const { datum, cas } = await novyVolnyTermin(polozka.id, 400);
      const res = await adminFetch('/admin/rezervace', {
        method: 'POST',
        body: JSON.stringify({ cenik_id: polozka.id, datum, cas_od: cas, jmeno: 'TEST-BEZ-TELEFONU (smazat)' })
      });
      assert.notEqual(res.status, 500, 'Chybějící telefon způsobil HTTP 500 — bug přetrvává!');
      assert.equal(res.status, 400, 'Chybějící telefon měl vrátit 400, vrátil ' + res.status);
      const data = await res.json();
      assert.ok(data.chyba, 'Chybová odpověď nemá srozumitelnou zprávu');
      console.log('OK — chybějící telefon vrací 400 s jasnou zprávou, ne 500:', data.chyba);
    }

    // 1) Nezaplacená rezervace (výchozí stav po vytvoření)
    console.log('--- 1) nezaplacená rezervace ---');
    let r1 = await vytvorRezervaci(polozka.id, '01');
    uklidRezervace.push(r1.id);
    assert.equal(r1.stav_platby, 'nezaplaceno');
    assert.equal(Number(r1.uhrazeno), 0);
    assert.equal(r1.zpusob_platby, null);
    console.log('OK — nová rezervace je "nezaplaceno", uhrazeno 0, bez způsobu platby');

    // 6) Změna platby z nezaplaceno → zaplaceno (plná platba, viz i bod 2)
    console.log('--- 2/6) plná platba (nezaplaceno → zaplaceno) ---');
    {
      const res = await adminFetch(`/admin/rezervace/${r1.id}/platba`, {
        method: 'PATCH', body: JSON.stringify({ castka: cena, zpusob_platby: 'hotove' })
      });
      const data = await res.json();
      assert.equal(res.status, 200, JSON.stringify(data));
      assert.equal(data.rezervace.stav_platby, 'zaplaceno');
      assert.equal(Number(data.rezervace.uhrazeno), cena);
      assert.equal(data.rezervace.zpusob_platby, 'hotove');
      assert.ok(data.rezervace.uhrazeno_kdy, 'uhrazeno_kdy nebylo nastaveno při plné platbě');
      console.log('OK — plná platba hotově: stav "zaplaceno", uhrazeno = cena, uhrazeno_kdy nastaveno');
    }

    // 3) Částečně zaplacená rezervace
    console.log('--- 3) částečná platba ---');
    let r3 = await vytvorRezervaci(polozka.id, '03');
    uklidRezervace.push(r3.id);
    {
      const castecna = Math.max(1, Math.floor(cena / 3));
      const res = await adminFetch(`/admin/rezervace/${r3.id}/platba`, {
        method: 'PATCH', body: JSON.stringify({ castka: castecna, zpusob_platby: 'kartou' })
      });
      const data = await res.json();
      assert.equal(res.status, 200, JSON.stringify(data));
      assert.equal(data.rezervace.stav_platby, 'castecne_zaplaceno');
      assert.equal(Number(data.rezervace.uhrazeno), castecna);
      console.log('OK — částečná platba kartou: stav "castecne_zaplaceno", uhrazeno = zaplacená částka');
    }

    // 4) Platba poukazem (plná)
    console.log('--- 4) platba poukazem (plná) ---');
    let r4 = await vytvorRezervaci(polozka.id, '04');
    uklidRezervace.push(r4.id);
    {
      const poukazRes = await adminFetch('/admin/poukazy', {
        method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-PLATBY-POUKAZ (smazat)' })
      });
      const poukazData = await poukazRes.json();
      assert.equal(poukazRes.status, 200, JSON.stringify(poukazData));
      uklidPoukazy.push(poukazData.poukaz.id);
      const hodnotaPoukazu = Number(poukazData.poukaz.hodnota);
      assert.equal(hodnotaPoukazu, cena, 'Poukaz na tuto masáž by měl mít stejnou hodnotu jako cena — jinak test níž neplatí 1:1');

      const uplatnitRes = await adminFetch(`/admin/poukazy/${poukazData.poukaz.id}/uplatnit`, {
        method: 'POST', body: JSON.stringify({ castka: cena, rezervace_id: r4.id })
      });
      const uplatnitData = await uplatnitRes.json();
      assert.equal(uplatnitRes.status, 200, JSON.stringify(uplatnitData));
      assert.equal(uplatnitData.rezervace.stav_platby, 'zaplaceno');
      assert.equal(uplatnitData.rezervace.zpusob_platby, 'poukaz');
      assert.equal(Number(uplatnitData.rezervace.uhrazeno), cena);
      assert.equal(Number(uplatnitData.poukaz.zustatek), 0);
      assert.equal(uplatnitData.poukaz.stav, 'pouzity');
      console.log('OK — poukaz plně uhradí rezervaci: rezervace "zaplaceno" + "poukaz", poukaz vyčerpán');
    }

    // 5) Poukaz + doplatek
    console.log('--- 5) poukaz + doplatek ---');
    let r5 = await vytvorRezervaci(polozka.id, '05');
    uklidRezervace.push(r5.id);
    {
      // Poukaz s hodnotou nižší než cena masáže (typ 500 Kč, pokud existuje) — jinak
      // částečné uplatnění vlastní částkou nižší než hodnota poukazu.
      const poukazRes = await adminFetch('/admin/poukazy', {
        method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-PLATBY-DOPLATEK (smazat)' })
      });
      const poukazData = await poukazRes.json();
      assert.equal(poukazRes.status, 200, JSON.stringify(poukazData));
      uklidPoukazy.push(poukazData.poukaz.id);

      const castPoukazem = Math.max(1, Math.floor(cena * 0.6));
      const doplatek = cena - castPoukazem;
      assert.ok(doplatek > 0, 'Testovací scénář potřebuje reálný doplatek > 0 — zkontrolujte ceník');

      const u1 = await adminFetch(`/admin/poukazy/${poukazData.poukaz.id}/uplatnit`, {
        method: 'POST', body: JSON.stringify({ castka: castPoukazem, rezervace_id: r5.id })
      }).then(r => r.json());
      assert.equal(u1.rezervace.stav_platby, 'castecne_zaplaceno');
      assert.equal(Number(u1.rezervace.uhrazeno), castPoukazem);
      assert.equal(u1.rezervace.zpusob_platby, 'poukaz');
      console.log('OK — poukaz pokryje část ceny (' + castPoukazem + ' Kč): stav "castecne_zaplaceno"');

      const u2 = await adminFetch(`/admin/rezervace/${r5.id}/platba`, {
        method: 'PATCH', body: JSON.stringify({ castka: doplatek, zpusob_platby: 'hotove' })
      }).then(r => r.json());
      assert.equal(u2.rezervace.stav_platby, 'zaplaceno');
      assert.equal(Number(u2.rezervace.uhrazeno), cena);
      console.log('OK — doplatek hotově (' + doplatek + ' Kč) dorovná na "zaplaceno", uhrazeno = cena');
    }

    // 7) Dokončená rezervace bez platby (nezávislost stav × stav_platby)
    console.log('--- 7) dokončená rezervace bez platby ---');
    let r7 = await vytvorRezervaci(polozka.id, '07');
    uklidRezervace.push(r7.id);
    {
      await adminFetch(`/admin/rezervace/${r7.id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'dokoncena' }) });
      const seznam = await adminFetch('/admin/rezervace').then(r => r.json());
      const aktualni = seznam.find(x => x.id === r7.id);
      assert.equal(aktualni.stav, 'dokoncena');
      assert.equal(aktualni.stav_platby, 'nezaplaceno');
      console.log('OK — dokončená masáž zůstává "nezaplaceno", dokud se platba nezaznamená (stav a stav_platby jsou nezávislé)');
    }

    // 8) Zrušená rezervace — platba se sama od sebe nemění
    console.log('--- 8) zrušená rezervace ---');
    let r8 = await vytvorRezervaci(polozka.id, '08');
    uklidRezervace.push(r8.id);
    {
      await adminFetch(`/admin/rezervace/${r8.id}/platba`, { method: 'PATCH', body: JSON.stringify({ castka: cena, zpusob_platby: 'kartou' }) });
      await adminFetch(`/admin/rezervace/${r8.id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zrusena' }) });
      const seznam = await adminFetch('/admin/rezervace').then(r => r.json());
      const aktualni = seznam.find(x => x.id === r8.id);
      assert.equal(aktualni.stav, 'zrusena');
      assert.equal(aktualni.stav_platby, 'zaplaceno', 'Zrušení rezervace nesmí samo od sebe měnit platbu');
      console.log('OK — zrušení rezervace samo o sobě nemění stav platby (zůstala "zaplaceno" — případné vrácení peněz je ruční krok)');
    }

    // 9) Historická rezervace bez payment údajů (existující řádek z doby před migrací)
    console.log('--- 9) historická rezervace bez payment údajů ---');
    {
      const seznam = await adminFetch('/admin/rezervace').then(r => r.json());
      const nejstarsi = [...seznam].sort((a, b) => a.id - b.id)[0];
      assert.ok(nejstarsi, 'V databázi není žádná rezervace pro kontrolu historických dat');
      assert.ok(['nezaplaceno', 'castecne_zaplaceno', 'zaplaceno'].includes(nejstarsi.stav_platby), 'Historická rezervace má neplatný/chybějící stav_platby: ' + nejstarsi.stav_platby);
      assert.ok(Number.isFinite(Number(nejstarsi.uhrazeno)), 'Historická rezervace má neplatné uhrazeno: ' + nejstarsi.uhrazeno);
      console.log('OK — nejstarší rezervace v databázi (id ' + nejstarsi.id + ') má platné výchozí platební údaje: stav_platby=' + nejstarsi.stav_platby + ', uhrazeno=' + nejstarsi.uhrazeno);
    }

    console.log('\n✅ VŠECHNY TESTY PLATEB PROŠLY');
  } finally {
    for (const id of uklidRezervace) {
      await adminFetch(`/admin/rezervace/${id}`, { method: 'DELETE' });
    }
    for (const id of uklidPoukazy) {
      await adminFetch(`/admin/poukazy/${id}`, { method: 'DELETE' });
    }
    if (uklidRezervace.length || uklidPoukazy.length) {
      console.log(`(uklizeno: ${uklidRezervace.length} testovacích rezervací, ${uklidPoukazy.length} testovacích poukazů)`);
    }
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
