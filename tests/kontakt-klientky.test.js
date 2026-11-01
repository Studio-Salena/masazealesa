// Testy PATCH /api/admin/klientky/:id — ruční úprava kontaktních údajů
// (jméno/telefon/e-mail) z karty klientky v adminu. Schválený bod 1 auditu
// "Rozvoj administrace" (viz zadání v historii konverzace) — tohle NENÍ
// najitNeboVytvoritKlientku (ta jen COALESCE doplňuje chybějící údaje), je to
// výslovná ruční oprava, která smí přepsat i už vyplněné hodnoty, s jedinou
// výjimkou: telefon zůstává povinný a je to JEDINÝ identifikační údaj
// (unique index na telefon_normalizovany), takže změna na číslo, které už
// patří jiné klientce, se vždy celá odmítne (409) — nikdy žádné automatické
// sloučení dvou klientek.
//
// Spuštění:  ADMIN_HESLO=... node tests/kontakt-klientky.test.js

const assert = require('node:assert/strict');

const { ziskatTestApiBase } = require('./env-guard');
const API = ziskatTestApiBase(); // Fáze 7C.6 — fail-closed, žádný produkční fallback
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
function novyTelefon() {
  return '777' + Math.floor(100000 + Math.random() * 900000);
}
async function najitVolnyTermin(datum, cenikId) {
  const terminy = await fetch(`${API}/rezervace/volne-terminy?datum=${datum}&cenik_id=${cenikId}`).then(r => r.json());
  const volny = Array.isArray(terminy) ? terminy.find(t => t.volno) : null;
  return volny ? volny.cas : null;
}
async function novyVolnyTermin(cenikId, odpocetDni) {
  for (let i = odpocetDni; i < odpocetDni + 90; i += 3) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const cas = await najitVolnyTermin(iso, cenikId);
    if (cas) return { datum: iso, cas };
  }
  throw new Error('Nenalezen volný termín pro test');
}

const uklidRezervace = [];
const uklidPoukazy = [];
const uklidKlientky = new Set();

async function main() {
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');

    const TEL_A = novyTelefon();
    const TEL_B = novyTelefon();

    const vytvorA = await adminFetch('/admin/klientky', {
      method: 'POST', body: JSON.stringify({ jmeno: 'TEST-KONTAKT-A (smazat)', telefon: TEL_A, email: 'test-kontakt-a@example.cz' })
    }).then(r => r.json());
    const idA = vytvorA.klientka.id;
    uklidKlientky.add(idA);
    const vytvorB = await adminFetch('/admin/klientky', {
      method: 'POST', body: JSON.stringify({ jmeno: 'TEST-KONTAKT-B (smazat)', telefon: TEL_B, email: 'test-kontakt-b@example.cz' })
    }).then(r => r.json());
    const idB = vytvorB.klientka.id;
    uklidKlientky.add(idB);

    // ================= 1) Úspěšná změna jména =================
    let res = await adminFetch(`/admin/klientky/${idA}`, {
      method: 'PATCH', body: JSON.stringify({ jmeno: 'TEST-KONTAKT-A2 (smazat)', telefon: TEL_A, email: 'test-kontakt-a@example.cz' })
    });
    let data = await res.json();
    assert.equal(res.status, 200, 'Změna jména selhala: ' + JSON.stringify(data));
    assert.equal(data.klientka.jmeno, 'TEST-KONTAKT-A2 (smazat)');
    console.log('OK — 1) úspěšná změna jména');

    // ================= 2) Úspěšná změna e-mailu =================
    res = await adminFetch(`/admin/klientky/${idA}`, {
      method: 'PATCH', body: JSON.stringify({ jmeno: 'TEST-KONTAKT-A2 (smazat)', telefon: TEL_A, email: 'novy-a@example.cz' })
    });
    data = await res.json();
    assert.equal(res.status, 200, 'Změna e-mailu selhala: ' + JSON.stringify(data));
    assert.equal(data.klientka.email, 'novy-a@example.cz');
    assert.equal(data.klientka.email_normalizovany, 'novy-a@example.cz');
    console.log('OK — 2) úspěšná změna e-mailu');

    // ================= 3) Úspěšná změna telefonu =================
    const TEL_NOVE = novyTelefon();
    res = await adminFetch(`/admin/klientky/${idA}`, {
      method: 'PATCH', body: JSON.stringify({ jmeno: 'TEST-KONTAKT-A2 (smazat)', telefon: TEL_NOVE, email: 'novy-a@example.cz' })
    });
    data = await res.json();
    assert.equal(res.status, 200, 'Změna telefonu selhala: ' + JSON.stringify(data));
    assert.equal(data.klientka.telefon, TEL_NOVE);
    assert.equal(data.klientka.telefon_normalizovany, TEL_NOVE);
    assert.equal(data.klientka.id, idA, 'Musí jít o STEJNOU klientku (stejné id), ne nově založenou');
    console.log('OK — 3) úspěšná změna telefonu, identita (id) zůstává stejná');

    // ================= 4) Změna na telefon jiné klientky — odmítnuto =================
    res = await adminFetch(`/admin/klientky/${idA}`, {
      method: 'PATCH', body: JSON.stringify({ jmeno: 'TEST-KONTAKT-A2 (smazat)', telefon: TEL_B, email: 'novy-a@example.cz' })
    });
    data = await res.json();
    assert.equal(res.status, 409, 'Změna na telefon jiné klientky musí vrátit 409, ne projít');
    assert.ok(data.chyba, 'Chybová odpověď musí obsahovat srozumitelnou hlášku');
    const kontrolaA = await adminFetch(`/admin/klientky/${idA}`).then(r => r.json());
    assert.equal(kontrolaA.telefon, TEL_NOVE, 'Po odmítnuté změně musí zůstat PŮVODNÍ telefon (žádná částečná změna)');
    const kontrolaB = await adminFetch(`/admin/klientky/${idB}`).then(r => r.json());
    assert.equal(kontrolaB.telefon, TEL_B, 'Klientka B nesmí být tou odmítnutou změnou nijak dotčena');
    console.log('OK — 4) změna na telefon jiné existující klientky je odmítnuta (409), žádná částečná změna ani sloučení');

    // ================= 5) Neplatný e-mail =================
    res = await adminFetch(`/admin/klientky/${idA}`, {
      method: 'PATCH', body: JSON.stringify({ jmeno: 'TEST-KONTAKT-A2 (smazat)', telefon: TEL_NOVE, email: 'neplatny-email-bez-zavinace' })
    });
    assert.equal(res.status, 400, 'Neplatný e-mail musí vrátit 400');
    console.log('OK — 5) neplatný e-mail (bez @) je odmítnut');

    // ================= 6) Neplatné / chybějící telefonní číslo =================
    res = await adminFetch(`/admin/klientky/${idA}`, {
      method: 'PATCH', body: JSON.stringify({ jmeno: 'TEST-KONTAKT-A2 (smazat)', telefon: '123', email: 'novy-a@example.cz' })
    });
    assert.equal(res.status, 400, 'Příliš krátké telefonní číslo musí vrátit 400');
    res = await adminFetch(`/admin/klientky/${idA}`, {
      method: 'PATCH', body: JSON.stringify({ jmeno: 'TEST-KONTAKT-A2 (smazat)', telefon: '', email: 'novy-a@example.cz' })
    });
    assert.equal(res.status, 400, 'Prázdné telefonní číslo musí vrátit 400 (telefon je povinný)');
    console.log('OK — 6) neplatné/chybějící telefonní číslo je odmítnuto');

    // ================= 7) Neexistující ID klientky =================
    res = await adminFetch('/admin/klientky/999999999', {
      method: 'PATCH', body: JSON.stringify({ jmeno: 'X', telefon: novyTelefon(), email: '' })
    });
    assert.equal(res.status, 404, 'Neexistující klientka musí vrátit 404');
    console.log('OK — 7) neexistující ID klientky vrací 404');

    // ================= 8) Neoprávněný přístup =================
    res = await fetch(`${API}/admin/klientky/${idA}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jmeno: 'X', telefon: TEL_NOVE, email: '' })
    });
    assert.equal(res.status, 401, 'Bez admin hesla musí vrátit 401');
    res = await fetch(`${API}/admin/klientky/${idA}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-admin-heslo': 'spatne-heslo-xyz' },
      body: JSON.stringify({ jmeno: 'X', telefon: TEL_NOVE, email: '' })
    });
    assert.equal(res.status, 401, 'Se špatným admin heslem musí vrátit 401');
    console.log('OK — 8) neoprávněný přístup (bez hesla i se špatným heslem) je odmítnut');

    // ================= 9) Zachování vazeb na historické rezervace =================
    const { datum, cas } = await novyVolnyTermin(polozka.id, 5);
    const rezRes = await adminFetch('/admin/rezervace', {
      method: 'POST',
      body: JSON.stringify({ cenik_id: polozka.id, datum, cas_od: cas, jmeno: 'TEST-KONTAKT-A2 (smazat)', telefon: TEL_NOVE, email: 'novy-a@example.cz' })
    });
    const rezData = await rezRes.json();
    assert.equal(rezRes.status, 200, 'Vytvoření testovací rezervace selhalo: ' + JSON.stringify(rezData));
    const rezervace = rezData.rezervace;
    uklidRezervace.push(rezervace.id);
    assert.equal(rezervace.klientka_id, idA, 'Rezervace se musí napojit na existující klientku A (podle telefonu), ne založit novou');

    const TEL_NOVE2 = novyTelefon();
    res = await adminFetch(`/admin/klientky/${idA}`, {
      method: 'PATCH', body: JSON.stringify({ jmeno: 'TEST-KONTAKT-A3 (smazat)', telefon: TEL_NOVE2, email: 'novy-a@example.cz' })
    });
    data = await res.json();
    assert.equal(res.status, 200, 'Změna kontaktu před testem vazeb selhala: ' + JSON.stringify(data));

    const rezervaceVsechny1 = await adminFetch(`/admin/rezervace`).then(r => r.json());
    const nalezenaRez = rezervaceVsechny1.find(r => r.id === rezervace.id);
    assert.ok(nalezenaRez, 'Rezervace musí po změně kontaktu stále existovat');
    assert.equal(nalezenaRez.klientka_id, idA, 'Rezervace musí zůstat napojená na STEJNOU klientku (stejné id) i po změně jejího telefonu');
    const detailA1 = await adminFetch(`/admin/klientky/${idA}`).then(r => r.json());
    assert.ok(detailA1.rezervace.some(r => r.id === rezervace.id), 'Rezervace musí být vidět v historii karty klientky i po změně kontaktu');
    console.log('OK — 9) rezervace zůstává napojená na stejnou klientku (klientka_id beze změny) i po úpravě jejího kontaktu');

    // ================= 10) Zachování vazeb na poukazy a platby =================
    const poukazRes = await adminFetch('/admin/poukazy', {
      method: 'POST',
      body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-KONTAKT-A3 (smazat)', kupujici_telefon: TEL_NOVE2 })
    });
    const poukazData = await poukazRes.json();
    assert.equal(poukazRes.status, 200, 'Vytvoření testovacího poukazu selhalo: ' + JSON.stringify(poukazData));
    const poukaz = poukazData.poukaz;
    uklidPoukazy.push(poukaz.id);
    assert.equal(poukaz.klientka_id, idA, 'Poukaz se musí napojit na existující klientku A podle (aktuálního) telefonu');

    const platbaRes = await adminFetch(`/admin/rezervace/${rezervace.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: Number(polozka.cena), zpusob_platby: 'hotove' })
    });
    assert.equal(platbaRes.status, 200, 'Zápis platby selhal');

    const TEL_NOVE3 = novyTelefon();
    res = await adminFetch(`/admin/klientky/${idA}`, {
      method: 'PATCH', body: JSON.stringify({ jmeno: 'TEST-KONTAKT-A4 (smazat)', telefon: TEL_NOVE3, email: 'novy-a@example.cz' })
    });
    assert.equal(res.status, 200, 'Druhá změna kontaktu před testem vazeb na poukaz/platbu selhala');

    const poukazyVsechny = await adminFetch(`/admin/poukazy`).then(r => r.json());
    const nalezenyPoukaz = poukazyVsechny.find(p => p.id === poukaz.id);
    assert.ok(nalezenyPoukaz, 'Poukaz musí po změně kontaktu stále existovat');
    assert.equal(nalezenyPoukaz.klientka_id, idA, 'Poukaz musí zůstat napojený na stejnou klientku i po úpravě jejího kontaktu');

    const rezervaceVsechny2 = await adminFetch(`/admin/rezervace`).then(r => r.json());
    const rezPoPlatbe = rezervaceVsechny2.find(r => r.id === rezervace.id);
    assert.equal(rezPoPlatbe.stav_platby, 'zaplaceno', 'Zaplacená rezervace musí zůstat zaplacená i po úpravě kontaktu klientky');
    assert.equal(Number(rezPoPlatbe.uhrazeno), Number(polozka.cena), 'Uhrazená částka se úpravou kontaktu nesmí změnit');
    console.log('OK — 10) poukaz i zaznamenaná platba zůstávají beze změny napojené na stejnou klientku po úpravě jejího kontaktu');

    // ================= 11) Zachování auditní historie =================
    // Žádný dedikovaný "GET auditní historie" endpoint neexistuje (klientky_
    // udalosti je čistě interní log, stejně jako retence_udalosti) — ověřuje
    // se tedy přímo v DB, výhradně READ-ONLY (SELECT), přes stejné DATABASE_URL
    // (z .env.test), jaké používá i testovaný server — nikdy žádný zápis.
    if (!process.env.DATABASE_URL) {
      console.log('⚠️  11) přeskočeno — DATABASE_URL není v prostředí nastavené (audit se neověřil přímo v DB)');
    } else {
      const { Pool } = require('pg');
      const dbPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      try {
        const { rows } = await dbPool.query(
          `SELECT udalost, pole FROM klientky_udalosti WHERE klientka_id = $1 AND udalost = 'upraveno_kontakt' ORDER BY id`,
          [idA]
        );
        assert.ok(rows.length >= 4, `Očekávám aspoň 4 auditní záznamy 'upraveno_kontakt' (testy 1,2,3,9,10), nalezeno ${rows.length}`);
        for (const r of rows) {
          assert.ok(r.pole && r.pole.length, 'Každý auditní záznam musí mít vyplněná změněná pole');
          assert.ok(!r.pole.includes('@') && !/\d{6,}/.test(r.pole), `Auditní stopa nesmí obsahovat skutečné hodnoty (jen názvy polí), nalezeno podezřelé: ${r.pole}`);
        }
        console.log(`OK — 11) auditní historie zaznamenává každou úpravu kontaktu (${rows.length} záznamů), obsahuje jen názvy změněných polí, nikdy skutečné hodnoty`);
      } finally {
        await dbPool.end();
      }
    }

    // ================= 12) Bonus: souběžná editace kontaktu + souběžné založení
    // rezervace se STEJNÝM (neměnícím se) telefonem téže klientky nesmí
    // deadlocknout. Běžná reálná situace: admin upravuje jméno na kartě
    // klientky přesně ve chvíli, kdy si ta samá klientka telefonicky
    // objednává novou rezervaci se svým (nezměněným) telefonem — PATCH i
    // najitNeboVytvoritKlientku sahají na stejný advisory zámek i stejný
    // řádek klientky, musí se tedy brát ve STEJNÉM pořadí. =================
    const TEL_D = novyTelefon();
    const vytvorD = await adminFetch('/admin/klientky', {
      method: 'POST', body: JSON.stringify({ jmeno: 'TEST-KONTAKT-D (smazat)', telefon: TEL_D, email: 'test-kontakt-d@example.cz' })
    }).then(r => r.json());
    const idD = vytvorD.klientka.id;
    uklidKlientky.add(idD);
    const terminD = await novyVolnyTermin(polozka.id, 8);

    const [patchVysledek, rezVysledek] = await Promise.all([
      adminFetch(`/admin/klientky/${idD}`, {
        method: 'PATCH', body: JSON.stringify({ jmeno: 'TEST-KONTAKT-D2 (smazat)', telefon: TEL_D, email: 'test-kontakt-d@example.cz' })
      }).then(async r => ({ status: r.status, data: await r.json() })),
      adminFetch('/admin/rezervace', {
        method: 'POST',
        body: JSON.stringify({ cenik_id: polozka.id, datum: terminD.datum, cas_od: terminD.cas, jmeno: 'TEST-KONTAKT-D (smazat)', telefon: TEL_D, email: 'test-kontakt-d@example.cz' })
      }).then(async r => ({ status: r.status, data: await r.json() }))
    ]);
    assert.equal(patchVysledek.status, 200, 'Souběžná úprava kontaktu nesmí spadnout na deadlock/chybu: ' + JSON.stringify(patchVysledek.data));
    assert.equal(rezVysledek.status, 200, 'Souběžné založení rezervace se stejným telefonem nesmí spadnout na deadlock/chybu: ' + JSON.stringify(rezVysledek.data));
    uklidRezervace.push(rezVysledek.data.rezervace.id);
    assert.equal(rezVysledek.data.rezervace.klientka_id, idD, 'Rezervace se musí napojit na STEJNOU klientku D, ne založit druhou');
    console.log('OK — 12) souběžná úprava kontaktu a založení rezervace se stejným telefonem proběhnou obě bez deadlocku/chyby');

    // ================= 13) Bonus: anonymizovanou klientku nejde upravit =================
    const vytvorC = await adminFetch('/admin/klientky', {
      method: 'POST', body: JSON.stringify({ jmeno: 'TEST-KONTAKT-C (smazat)', telefon: novyTelefon() })
    }).then(r => r.json());
    const idC = vytvorC.klientka.id;
    uklidKlientky.add(idC);
    const anonRes = await adminFetch(`/admin/klientky/${idC}/anonymizovat`, { method: 'POST', body: JSON.stringify({ potvrzeno: true }) });
    assert.equal(anonRes.status, 200, 'Anonymizace testovací klientky C selhala');
    res = await adminFetch(`/admin/klientky/${idC}`, {
      method: 'PATCH', body: JSON.stringify({ jmeno: 'X', telefon: novyTelefon(), email: '' })
    });
    assert.equal(res.status, 400, 'Anonymizovanou klientku nelze upravovat (obešlo by to smysl anonymizace)');
    console.log('OK — 13) anonymizovanou klientku nejde upravit');

    console.log('\n✅ VŠECHNY TESTY ÚPRAVY KONTAKTU KLIENTKY PROŠLY');
  } finally {
    for (const id of uklidRezervace) await adminFetch(`/admin/rezervace/${id}`, { method: 'DELETE' }).catch(() => {});
    for (const id of uklidPoukazy) await adminFetch(`/admin/poukazy/${id}`, { method: 'DELETE' }).catch(() => {});
    let klientkySmazano = 0;
    for (const id of uklidKlientky) {
      const r = await adminFetch(`/admin/klientky/${id}`, { method: 'DELETE' }).catch(() => null);
      if (r && r.ok) klientkySmazano++;
    }
    console.log(`(uklizeno: ${uklidRezervace.length} testovacích rezervací, ${uklidPoukazy.length} testovacích poukazů, ${klientkySmazano}/${uklidKlientky.size} testovacích klientek)`);
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
