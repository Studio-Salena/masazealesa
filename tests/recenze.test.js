// Regresní test: správa recenzí (admin) + veřejné zobrazení na webu.
//
// Cíl testu:
//  1) Nová recenze vzniká jako "koncept" — veřejný endpoint ji NEUKAZUJE.
//  2) Po zveřejnění ("stav":"zverejneno") se objeví ve veřejném /api/recenze
//     — a to s "Paní " před jménem, i když admin uložila jen křestní jméno.
//  3) Skrytí zpátky na koncept ji z veřejného výpisu zase odstraní.
//  4) Admin endpointy vyžadují heslo, veřejný ne.
//  5) Validace (chybějící jméno/text, neplatný počet hvězdiček, neplatný stav).
//  6) Smazání funguje a mizí z obou výpisů.
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=http://localhost:3001/api node tests/recenze.test.js

const assert = require('node:assert/strict');
const { ziskatTestApiBase } = require('./env-guard');
const API = ziskatTestApiBase();
const HESLO = process.env.ADMIN_HESLO;

if (!HESLO) {
  console.error('Chybí ADMIN_HESLO v prostředí.');
  process.exit(1);
}

function adminFetch(cesta, opts = {}) {
  return fetch(API + cesta, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-admin-heslo': HESLO, ...(opts.headers || {}) }
  });
}
function verejnyFetch(cesta) {
  return fetch(API + cesta);
}

const uklidRecenze = [];

async function main() {
  console.log('--- Recenze na web ---');

  // 1) Nová recenze = koncept, veřejně neviditelná
  let id;
  {
    const res = await adminFetch('/admin/recenze', {
      method: 'POST', body: JSON.stringify({ jmeno: 'TEST-RECENZE-Jana', text: 'Testovací recenze, velmi spokojená.', hvezdicky: 5 })
    });
    const data = await res.json();
    assert.equal(res.status, 200, 'vytvoření recenze musí uspět: ' + JSON.stringify(data));
    assert.equal(data.recenze.stav, 'koncept', '1a) nová recenze musí mít výchozí stav "koncept"');
    id = data.recenze.id;
    uklidRecenze.push(id);

    const verejne = await verejnyFetch('/recenze').then(r => r.json());
    assert.ok(!verejne.some(r => r.id === id), '1b) koncept se nesmí objevit ve veřejném výpisu');
    console.log('OK — 1) nová recenze vzniká jako koncept, veřejně není vidět');
  }

  // 2) Zveřejnění — objeví se veřejně, s "Paní " před jménem
  {
    const res = await adminFetch('/admin/recenze/' + id, { method: 'PATCH', body: JSON.stringify({ stav: 'zverejneno' }) });
    assert.equal(res.status, 200, 'zveřejnění musí uspět');

    const verejne = await verejnyFetch('/recenze').then(r => r.json());
    const nalezena = verejne.find(r => r.id === id);
    assert.ok(nalezena, '2a) zveřejněná recenze se musí objevit ve veřejném výpisu');
    assert.equal(nalezena.jmeno, 'TEST-RECENZE-Jana', '2b) veřejný endpoint vrací holé jméno (prefix "Paní" si skládá až web, viz index.html)');
    assert.equal(nalezena.text, 'Testovací recenze, velmi spokojená.');
    assert.equal(nalezena.hvezdicky, 5);
    console.log('OK — 2) zveřejněná recenze je ve veřejném výpisu se správnými údaji');
  }

  // 3) Skrytí zpátky na koncept ji z veřejného výpisu odstraní
  {
    const res = await adminFetch('/admin/recenze/' + id, { method: 'PATCH', body: JSON.stringify({ stav: 'koncept' }) });
    assert.equal(res.status, 200);
    const verejne = await verejnyFetch('/recenze').then(r => r.json());
    assert.ok(!verejne.some(r => r.id === id), '3) skrytí (koncept) musí recenzi z veřejného výpisu odstranit');
    console.log('OK — 3) skrytí recenze ji odstraní z veřejného webu');
  }

  // 4) Admin endpointy vyžadují heslo, veřejný ne
  {
    const bezHesla = await fetch(API + '/admin/recenze');
    assert.equal(bezHesla.status, 401, '4a) GET /admin/recenze bez hesla musí být odmítnuto');
    const verejnyBezHesla = await fetch(API + '/recenze');
    assert.equal(verejnyBezHesla.status, 200, '4b) GET /recenze (veřejný) nesmí vyžadovat heslo');
    console.log('OK — 4) admin endpointy jsou chráněné heslem, veřejný výpis ne');
  }

  // 5) Validace
  {
    const chybejiciJmeno = await adminFetch('/admin/recenze', { method: 'POST', body: JSON.stringify({ text: 'jen text' }) });
    assert.equal(chybejiciJmeno.status, 400, '5a) chybějící jméno musí být odmítnuto');

    const chybejiciText = await adminFetch('/admin/recenze', { method: 'POST', body: JSON.stringify({ jmeno: 'Jana' }) });
    assert.equal(chybejiciText.status, 400, '5b) chybějící text musí být odmítnut');

    const spatneHvezdicky = await adminFetch('/admin/recenze', { method: 'POST', body: JSON.stringify({ jmeno: 'Jana', text: 'text', hvezdicky: 6 }) });
    assert.equal(spatneHvezdicky.status, 400, '5c) 6 hvězdiček musí být odmítnuto (max 5)');

    const spatnyStav = await adminFetch('/admin/recenze/' + id, { method: 'PATCH', body: JSON.stringify({ stav: 'neplatny' }) });
    assert.equal(spatnyStav.status, 400, '5d) neplatný stav musí být odmítnut');
    console.log('OK — 5) validace jména, textu, hvězdiček a stavu funguje');
  }

  // 6) Smazání
  {
    const res = await adminFetch('/admin/recenze/' + id, { method: 'DELETE' });
    assert.equal(res.status, 200, 'smazání musí uspět');
    const seznam = await adminFetch('/admin/recenze').then(r => r.json());
    assert.ok(!seznam.some(r => r.id === id), '6) smazaná recenze nesmí zůstat v admin seznamu');
    uklidRecenze.length = 0; // už smazáno, není co uklízet
    console.log('OK — 6) smazání recenze funguje');
  }

  console.log('\n✅ VŠECHNY TESTY RECENZÍ PROŠLY');
}

main()
  .catch(e => { console.error('❌ CHYBA TESTU:', e.message); process.exitCode = 1; })
  .finally(async () => {
    for (const id of uklidRecenze) {
      await adminFetch('/admin/recenze/' + id, { method: 'DELETE' }).catch(() => {});
    }
    if (uklidRecenze.length) console.log(`(uklizeno: ${uklidRecenze.length} testovacích recenzí)`);
  });
