// Regresní test: ochrana proti trvalému smazání rezervace, která by ztratila
// evidenci provedené služby a/nebo platební historie (viz rezervace č. 466,
// která v produkci zmizela z přehledu "Provedené masáže" beze stopy, beze
// varování a bez auditu).
//
// Pravidla (viz server.js DELETE /api/admin/rezervace/:id, PATCH .../stav,
// a schema.sql — trigger rezervace_bez_mazani_dokoncene + FK
// platby_rezervace_id_fkey ON DELETE RESTRICT + tabulka
// rezervace_ochrana_udalosti):
//  1) Dokončenou rezervaci (stav='dokoncena') nelze trvale smazat NIKDY,
//     ani bez jakékoli platby.
//  2) Rezervaci s JAKOUKOLI historií v deníku "platby" (plná, částečná,
//     vrácená/net nula, poukazová) nelze trvale smazat, dokud ta historie
//     existuje — ochrana se neptá jen na aktuální "uhrazeno".
//  3) Ochrana platí i na úrovni databáze (trigger + FK RESTRICT), ne jen
//     v Express vrstvě — přímý SQL DELETE musí selhat stejně.
//  4) Povolené smazání (bez platby, ne dokončená) i přechod stavu PRYČ z
//     "dokoncena" se zapisují do auditu (rezervace_ochrana_udalosti).
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=http://localhost:3001/api DATABASE_URL=... node tests/ochrana-mazani-rezervaci.test.js

const assert = require('node:assert/strict');

const { ziskatTestApiBase, ziskatTestDatabaseUrl } = require('./env-guard');
const { uklidRezervaciSFallbackem } = require('./test-helpers');
const API = ziskatTestApiBase();
const DB_URL = ziskatTestDatabaseUrl();
const HESLO = process.env.ADMIN_HESLO;

if (!HESLO) {
  console.error('Chybí ADMIN_HESLO v prostředí — test se přeskakuje.');
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

async function vytvorRezervaci(cenikId, telefonSuffix) {
  const { datum, cas } = await novyVolnyTermin(cenikId, 1000 + Math.floor(Math.random() * 100));
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: cas, jmeno: 'TEST-OCHRANA-MAZANI (smazat)', telefon: '00006' + telefonSuffix, email: 'test-ochrana-mazani@example.cz' })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'Vytvoření testovací rezervace selhalo: ' + JSON.stringify(data));
  if (data.rezervace.klientka_id) uklidKlientky.add(data.rezervace.klientka_id);
  return data.rezervace;
}

async function zaplatit(id, castka, zpusob_platby, typ) {
  const body = { castka, zpusob_platby };
  if (typ) body.typ = typ;
  return adminFetch(`/admin/rezervace/${id}/platba`, { method: 'PATCH', body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));
}
async function dokoncit(id) {
  return adminFetch(`/admin/rezervace/${id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'dokoncena' }) }).then(async r => ({ status: r.status, data: await r.json() }));
}
async function zmenitStav(id, stav) {
  return adminFetch(`/admin/rezervace/${id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav }) }).then(async r => ({ status: r.status, data: await r.json() }));
}
async function smazat(id) {
  return adminFetch(`/admin/rezervace/${id}`, { method: 'DELETE' }).then(async r => ({ status: r.status, data: await r.json() }));
}
async function auditZaznamy(rezervaceId) {
  const vse = await adminFetch('/admin/rezervace-ochrana-udalosti').then(r => r.json());
  return vse.filter(u => u.rezervace_id === rezervaceId);
}

const uklidRezervace = [];
const uklidKlientky = new Set();

async function main() {
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');
    const cena = Number(polozka.cena);

    // 1) Nezaplacená BUDOUCÍ rezervace — smazání musí zůstat povolené.
    console.log('--- 1) nezaplacená budoucí rezervace → smazání povoleno ---');
    {
      const r = await vytvorRezervaci(polozka.id, '1');
      const vysledek = await smazat(r.id);
      assert.equal(vysledek.status, 200, JSON.stringify(vysledek.data));
      const seznam = await adminFetch('/admin/rezervace').then(res => res.json());
      assert.ok(!seznam.some(x => x.id === r.id), 'Smazaná rezervace nesmí dál existovat');
      const audit = await auditZaznamy(r.id);
      assert.equal(audit.length, 1, 'Povolené smazání se musí zapsat do auditu');
      assert.equal(audit[0].udalost, 'smazana');
      assert.equal(audit[0].mela_historii_plateb, false);
      console.log('OK — nezaplacená budoucí rezervace se smaže normálně, zapíše se do auditu jako "smazana"');
    }

    // 2) DOKONČENÁ nezaplacená rezervace — přesně scénář rezervace č. 466.
    console.log('--- 2) dokončená nezaplacená rezervace → smazání odmítnuto ---');
    {
      const r = await vytvorRezervaci(polozka.id, '2');
      uklidRezervace.push(r.id);
      await dokoncit(r.id);
      const vysledek = await smazat(r.id);
      assert.equal(vysledek.status, 400, 'Dokončenou (i nezaplacenou) rezervaci nelze smazat: ' + JSON.stringify(vysledek.data));
      const seznam = await adminFetch('/admin/rezervace').then(res => res.json());
      assert.ok(seznam.some(x => x.id === r.id), 'Odmítnuté smazání nesmí rezervaci odstranit');
      console.log('OK — dokončená rezervace bez jakékoli platby (přesně scénář č. 466) nelze smazat');
    }

    // 3) Částečně zaplacená rezervace (ne dokončená) — smazání odmítnuto.
    console.log('--- 3) částečně zaplacená rezervace → smazání odmítnuto ---');
    {
      const r = await vytvorRezervaci(polozka.id, '3');
      uklidRezervace.push(r.id);
      const castecna = Math.max(1, Math.floor(cena / 3));
      await zaplatit(r.id, castecna, 'hotove');
      const vysledek = await smazat(r.id);
      assert.equal(vysledek.status, 400, JSON.stringify(vysledek.data));
      console.log('OK — částečně zaplacenou rezervaci (bez dokončení) nelze smazat');
    }

    // 4) Plně zaplacená rezervace — smazání odmítnuto.
    console.log('--- 4) plně zaplacená rezervace → smazání odmítnuto ---');
    {
      const r = await vytvorRezervaci(polozka.id, '4');
      uklidRezervace.push(r.id);
      await zaplatit(r.id, cena, 'hotove');
      const vysledek = await smazat(r.id);
      assert.equal(vysledek.status, 400, JSON.stringify(vysledek.data));
      console.log('OK — plně zaplacenou rezervaci nelze smazat');
    }

    // 5) Rezervace s VRÁCENOU platbou (plná vratka, aktuální uhrazeno=0) —
    // ochrana se nesmí spolehnout jen na "uhrazeno", musí zůstat blokovaná.
    console.log('--- 5) rezervace s vrácenou platbou (uhrazeno=0) → smazání odmítnuto ---');
    {
      const r = await vytvorRezervaci(polozka.id, '5');
      uklidRezervace.push(r.id);
      await zaplatit(r.id, cena, 'hotove');
      const vratka = await zaplatit(r.id, cena, 'hotove', 'vratka');
      assert.equal(vratka.status, 200, JSON.stringify(vratka.data));
      assert.equal(Number(vratka.data.rezervace.uhrazeno), 0, 'test předpoklad: po plné vratce má být uhrazeno 0');
      const vysledek = await smazat(r.id);
      assert.equal(vysledek.status, 400, 'Rezervaci s historií platby/vratky (i když je NETTO 0) nelze smazat: ' + JSON.stringify(vysledek.data));
      console.log('OK — plně vrácená platba (uhrazeno=0) rezervaci STEJNĚ chrání před smazáním (ochrana se neřídí jen aktuální hodnotou uhrazeno)');
    }

    // 6) Rezervace s poukazovou platbou — smazání odmítnuto.
    console.log('--- 6) rezervace s poukazovou platbou → smazání odmítnuto ---');
    {
      const r = await vytvorRezervaci(polozka.id, '6');
      uklidRezervace.push(r.id);
      const poukazRes = await adminFetch('/admin/poukazy', {
        method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-OCHRANA-MAZANI-POUKAZ (smazat)', zaplaceno: true, zpusob_platby: 'hotove' })
      });
      const poukazData = await poukazRes.json();
      assert.equal(poukazRes.status, 200, JSON.stringify(poukazData));
      const uplatnitRes = await adminFetch(`/admin/poukazy/${poukazData.poukaz.id}/uplatnit`, {
        method: 'POST', body: JSON.stringify({ castka: cena, rezervace_id: r.id })
      });
      assert.equal(uplatnitRes.status, 200);
      const vysledek = await smazat(r.id);
      assert.equal(vysledek.status, 400, JSON.stringify(vysledek.data));
      console.log('OK — rezervaci zaplacenou poukazem nelze smazat');
      // Úklid: rezervace je v uklidRezervace (viz výš) → při závěrečném
      // úklidu ji uklidRezervaciSFallbackem natvrdo smaže a tenhle poukaz
      // (jeho jediné využití patří právě týhle rezervaci) se smaže celý
      // spolu s ní — viz tests/test-helpers.js.
    }

    // 7) Pokus o smazání PŘÍMO přes databázi (ne přes HTTP API) — ochrana
    // musí platit i tady, ne jen v Express vrstvě.
    console.log('--- 7) pokus o smazání přímo přes databázi ---');
    {
      const { Client } = require('pg');
      const pg = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
      await pg.connect();
      try {
        // 7a) Dokončená, nezaplacená — musí selhat na triggeru.
        const rA = await vytvorRezervaci(polozka.id, '7a');
        uklidRezervace.push(rA.id);
        await dokoncit(rA.id);
        let chybaA = null;
        try { await pg.query('DELETE FROM rezervace WHERE id = $1', [rA.id]); }
        catch (e) { chybaA = e; }
        assert.ok(chybaA, '7a) přímý SQL DELETE dokončené rezervace musí selhat (trigger)');
        assert.match(chybaA.message, /nelze trvale smazat/, '7a) chybová hláška má být ta z triggeru, ne obecná: ' + chybaA.message);
        const existujeA = await adminFetch('/admin/rezervace').then(res => res.json()).then(seznam => seznam.some(x => x.id === rA.id));
        assert.ok(existujeA, '7a) rezervace musí po selhaném SQL DELETE dál existovat');

        // 7b) Nedokončená, ale zaplacená — musí selhat na FK RESTRICT (platby).
        const rB = await vytvorRezervaci(polozka.id, '7b');
        uklidRezervace.push(rB.id);
        await zaplatit(rB.id, cena, 'kartou');
        let chybaB = null;
        try { await pg.query('DELETE FROM rezervace WHERE id = $1', [rB.id]); }
        catch (e) { chybaB = e; }
        assert.ok(chybaB, '7b) přímý SQL DELETE zaplacené rezervace musí selhat (FK RESTRICT na platby)');
        assert.equal(chybaB.code, '23503', '7b) má to být porušení cizího klíče (foreign_key_violation): ' + chybaB.code);
        const existujeB = await adminFetch('/admin/rezervace').then(res => res.json()).then(seznam => seznam.some(x => x.id === rB.id));
        assert.ok(existujeB, '7b) rezervace musí po selhaném SQL DELETE dál existovat');

        console.log('OK — přímý SQL DELETE je odmítnutý jak pro dokončenou (trigger), tak pro zaplacenou (FK RESTRICT) rezervaci');
      } finally {
        await pg.end();
      }
    }

    // 8) Zachování účetních součtů — odmítnutý pokus o smazání nesmí
    // jakkoli posunout souhrny v "Provedené masáže".
    console.log('--- 8) zachování účetních součtů po odmítnutém smazání ---');
    {
      const r = await vytvorRezervaci(polozka.id, '8');
      uklidRezervace.push(r.id);
      await zaplatit(r.id, cena, 'hotove');
      await dokoncit(r.id);
      const pred = await adminFetch(`/admin/provedene-masaze?od=${r.datum}&do=${r.datum}`).then(res => res.json());
      const vysledek = await smazat(r.id);
      assert.equal(vysledek.status, 400);
      const po = await adminFetch(`/admin/provedene-masaze?od=${r.datum}&do=${r.datum}`).then(res => res.json());
      assert.deepEqual(po.souhrn, pred.souhrn, 'Odmítnuté smazání nesmí změnit účetní součty v "Provedené masáže"');
      console.log('OK — odmítnutý pokus o smazání nezmění souhrny v "Provedené masáže"');
    }

    // 9) Audit přechodu stavu PRYČ z "dokoncena" (bez smazání) — rezervace
    // zůstává v DB, ale mizí z evidence "Provedené masáže"; musí se zapsat.
    console.log('--- 9) audit přechodu stavu PRYČ z "dokoncena" ---');
    {
      const r = await vytvorRezervaci(polozka.id, '9');
      uklidRezervace.push(r.id);
      await dokoncit(r.id);
      const zmena = await zmenitStav(r.id, 'potvrzena');
      assert.equal(zmena.status, 200, JSON.stringify(zmena.data));
      const audit = await auditZaznamy(r.id);
      assert.equal(audit.length, 1, 'Přechod pryč z "dokoncena" se musí zapsat do auditu');
      assert.equal(audit[0].udalost, 'stav_zmenen_z_dokoncena');
      assert.equal(audit[0].stav_pred, 'dokoncena');
      assert.equal(audit[0].stav_po, 'potvrzena');
      console.log('OK — přechod stavu pryč z "dokoncena" (bez platby) se zapíše do auditu');

      // Zpátky na dokoncena a znovu pryč — nesmí vzniknout jen jeden
      // kumulativní záznam, každý přechod svůj vlastní.
      await dokoncit(r.id);
      await zmenitStav(r.id, 'zrusena');
      const audit2 = await auditZaznamy(r.id);
      assert.equal(audit2.length, 2, 'Každý přechod pryč z "dokoncena" má vlastní auditní záznam');
      console.log('OK — opakovaný přechod pryč z "dokoncena" zapíše druhý, samostatný auditní záznam');
    }

    // 10) Zachování dosavadního rušení a vracení plateb — PATCH .../stav
    // (zrušení) a PATCH .../platba (vratka) se touhle ochranou nesmí nijak
    // omezit, jen samotné trvalé mazání.
    console.log('--- 10) zachování zrušení a vratek ---');
    {
      const r = await vytvorRezervaci(polozka.id, '10');
      uklidRezervace.push(r.id);
      const platba = await zaplatit(r.id, cena, 'hotove');
      assert.equal(platba.status, 200, JSON.stringify(platba.data));
      const zruseni = await zmenitStav(r.id, 'zrusena');
      assert.equal(zruseni.status, 200, 'Zrušení zaplacené rezervace musí zůstat povolené (jen mazání je chráněné): ' + JSON.stringify(zruseni.data));
      const vratka = await zaplatit(r.id, cena, 'hotove', 'vratka');
      assert.equal(vratka.status, 200, 'Vrácení platby musí zůstat povolené: ' + JSON.stringify(vratka.data));
      assert.equal(Number(vratka.data.rezervace.uhrazeno), 0);
      console.log('OK — zrušení i vrácení platby u zaplacené rezervace zůstává plně funkční, jen trvalé smazání je chráněné');
    }

    console.log('\n✅ VŠECHNY TESTY OCHRANY MAZÁNÍ REZERVACÍ PROŠLY');
  } finally {
    for (const id of uklidRezervace) {
      await uklidRezervaciSFallbackem(adminFetch, id);
    }
    let klientkySmazano = 0;
    for (const id of uklidKlientky) {
      const r = await adminFetch(`/admin/klientky/${id}`, { method: 'DELETE' }).catch(() => null);
      if (r && r.ok) klientkySmazano++;
    }
    if (uklidRezervace.length || uklidKlientky.size) {
      console.log(`(uklizeno: ${uklidRezervace.length} testovacích rezervací, ${klientkySmazano}/${uklidKlientky.size} testovacích klientek)`);
    }
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
