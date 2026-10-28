// Regresní test: GET /api/admin/statistiky (Rozvoj administrace, bod 4).
// Ověřuje: tržby podle měsíců počítají stejně jako Účetnictví kategorie A
// (potvrzena+dokoncena podle data masáže), počet/oblíbenost/průměrná cena
// počítají jen z "dokoncena", a míra zrušení/nedostavení ze všech rezervací
// v období. Vše se ověřuje v jediném dni (od=do=ten den), ať se výsledek
// nemůže zamíchat se zbytkem dat v TEST DB.
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=... node tests/statistiky.test.js

const assert = require('node:assert/strict');

const { ziskatTestApiBase } = require('./env-guard');
const API = ziskatTestApiBase(); // Fáze 7C.6 — fail-closed, žádný produkční fallback
const HESLO = process.env.ADMIN_HESLO;

if (!HESLO) {
  console.error('Chybí ADMIN_HESLO v prostředí — test se přeskakuje (spusťte s ADMIN_HESLO=... node tests/statistiky.test.js).');
  process.exit(0);
}

function adminFetch(cesta, options = {}) {
  return fetch(API + cesta, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-admin-heslo': HESLO, ...(options.headers || {}) }
  });
}
// Najde den s aspoň "pocetPotreba" volnými termíny PŘED jakýmkoliv bookováním
// — jen pro výběr vhodného dne, skutečné sloty se pak zjišťují vždy znovu
// těsně před každou rezervací (viz vytvorRezervaci níž), ať se nikdy netrefí
// do mezičasu zabraného předchozí testovací rezervací.
async function denSVolnymiTerminy(cenikId, odpocetDni, pocetPotreba) {
  for (let i = odpocetDni; i < odpocetDni + 120; i += 3) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const terminy = await fetch(`${API}/rezervace/volne-terminy?datum=${iso}&cenik_id=${cenikId}`).then(r => r.json());
    const volne = Array.isArray(terminy) ? terminy.filter(t => t.volno) : [];
    if (volne.length >= pocetPotreba) return iso;
  }
  throw new Error('Nenalezen den s dostatkem volných termínů pro test');
}
// Vždy čerstvě zjistí PRVNÍ aktuálně volný čas daného dne (ne předem
// vypočtený) a hned ho obsadí — spolehlivé i když předchozí testovací
// rezervace tentýž den zabrala/zablokovala bufferem část dřívějších časů.
async function vytvorRezervaci(cenikId, datum, telefonSuffix, jmeno) {
  const terminy = await fetch(`${API}/rezervace/volne-terminy?datum=${datum}&cenik_id=${cenikId}`).then(r => r.json());
  const volny = Array.isArray(terminy) ? terminy.find(t => t.volno) : null;
  assert.ok(volny, `Nenalezen žádný volný termín dne ${datum} pro testovací rezervaci ${jmeno}`);
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: volny.cas, jmeno, telefon: '0009920' + telefonSuffix, email: 'test-statistiky-' + telefonSuffix + '@example.com' })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'Vytvoření testovací rezervace selhalo: ' + JSON.stringify(data));
  return data.rezervace;
}
async function nastavStav(id, stav) {
  const res = await adminFetch(`/admin/rezervace/${id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav }) });
  assert.equal(res.status, 200, `Nastavení stavu "${stav}" selhalo`);
}

async function main() {
  const uklidRezervace = [];
  const uklidKlientky = new Set();
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');
    const cena = Number(polozka.cena);

    // 4 rezervace ve stejný den — A/B dokončené, C zrušená, D ponechaná na
    // výchozím stavu (potvrzena), ať test pokryje i kategorii, která se do
    // trzbyPoMesicich počítá, ale do pocetDokoncenychMasazi ne.
    const datum = await denSVolnymiTerminy(polozka.id, 20, 4);

    const rA = await vytvorRezervaci(polozka.id, datum, '1', 'TEST-STATISTIKY-A (smazat)');
    const rB = await vytvorRezervaci(polozka.id, datum, '2', 'TEST-STATISTIKY-B (smazat)');
    const rC = await vytvorRezervaci(polozka.id, datum, '3', 'TEST-STATISTIKY-C (smazat)');
    const rD = await vytvorRezervaci(polozka.id, datum, '4', 'TEST-STATISTIKY-D (smazat)');
    [rA, rB, rC, rD].forEach(r => { uklidRezervace.push(r.id); if (r.klientka_id) uklidKlientky.add(r.klientka_id); });

    await nastavStav(rA.id, 'dokoncena');
    await nastavStav(rB.id, 'dokoncena');
    await nastavStav(rC.id, 'zrusena');
    // rD zůstává na výchozím stavu (potvrzena) — admin-vytvořená rezervace
    // vzniká rovnou jako "potvrzena", ne "cekajici" (viz POST /admin/rezervace).
    assert.equal(rD.stav, 'potvrzena', 'Předpoklad testu: admin-vytvořená rezervace vzniká jako "potvrzena"');

    const d = await adminFetch(`/admin/statistiky?od=${datum}&do=${datum}`).then(r => r.json());

    // trzbyPoMesicich — stejná pravidla jako Účetnictví (A): potvrzena+dokoncena,
    // tedy A+B+D (ne C/zrušená) = 3× cena.
    assert.equal(d.trzbyPoMesicich.length, 1, 'a) musí vyjít přesně jeden měsíc v jednodenním období');
    assert.equal(d.trzbyPoMesicich[0].mesic, datum.slice(0, 7), 'a) měsíc musí odpovídat datu testovacích rezervací');
    assert.equal(Number(d.trzbyPoMesicich[0].castka), cena * 3, 'a) tržby musí zahrnout potvrzenou i obě dokončené, ne zrušenou (3× cena)');
    console.log('OK — a) trzbyPoMesicich počítá potvrzena+dokoncena stejně jako Účetnictví kategorie A, vylučuje zrušenou');

    // pocetDokoncenychMasazi / nejzadanejsiMasaze / prumernaUtrata — jen A+B.
    assert.equal(d.pocetDokoncenychMasazi, 2, 'b) pocetDokoncenychMasazi musí počítat jen skutečně dokončené (A+B)');
    const polozkaMasaze = d.nejzadanejsiMasaze.find(m => m.masaz === rA.masaz);
    assert.ok(polozkaMasaze, 'b) testovaná masáž musí být v nejzadanejsiMasaze');
    assert.ok(polozkaMasaze.pocet >= 2, 'b) nejzadanejsiMasaze musí zahrnout obě dokončené testovací rezervace');
    assert.equal(Number(d.prumernaUtrata), cena, 'b) prumernaUtrata (A+B) / 2 musí odpovídat ceně jedné masáže (obě mají stejnou cenu)');
    console.log('OK — b) pocetDokoncenychMasazi, nejzadanejsiMasaze a prumernaUtrata počítají jen z "dokoncena"');

    // zruseni — ze všech 4 rezervací v období, 1 zrušená.
    assert.ok(d.zruseni.pocetCelkem >= 4, 'c) pocetCelkem musí zahrnout všechny 4 testovací rezervace v období');
    assert.ok(d.zruseni.pocetZrusenych >= 1, 'c) pocetZrusenych musí zahrnout testovací zrušenou rezervaci');
    assert.equal(d.zruseni.podilZrusenych, d.zruseni.pocetZrusenych / d.zruseni.pocetCelkem, 'c) podilZrusenych musí odpovídat pocetZrusenych/pocetCelkem');
    console.log('OK — c) zruseni.pocetCelkem/pocetZrusenych/podilZrusenych odpovídají skutečnému stavu rezervací v období');

    // Okrajový případ: období úplně mimo testovací data musí vrátit nuly, ne chybu.
    const prazdne = await adminFetch('/admin/statistiky?od=2000-01-01&do=2000-01-02').then(r => r.json());
    assert.deepEqual(prazdne.trzbyPoMesicich, [], 'd) prázdné období nesmí vracet žádné měsíce');
    assert.equal(prazdne.pocetDokoncenychMasazi, 0, 'd) prázdné období nesmí počítat žádné dokončené masáže');
    assert.equal(prazdne.prumernaUtrata, null, 'd) prumernaUtrata bez dat musí být null, ne NaN/dělení nulou');
    console.log('OK — d) období bez dat vrací prázdné/nulové hodnoty, ne chybu');

    const bezHesla = await fetch(API + '/admin/statistiky');
    assert.equal(bezHesla.status, 401, 'e) /api/admin/statistiky bez hesla musí vrátit 401');
    console.log('OK — e) /api/admin/statistiky je chráněné admin heslem stejně jako ostatní admin endpointy');

    console.log('\n✅ VŠECHNY TESTY STATISTIK PROŠLY');
  } finally {
    for (const id of uklidRezervace) await adminFetch(`/admin/rezervace/${id}`, { method: 'DELETE' }).catch(() => {});
    for (const id of uklidKlientky) await adminFetch(`/admin/klientky/${id}`, { method: 'DELETE' }).catch(() => {});
    console.log(`(uklizeno: ${uklidRezervace.length} testovacích rezervací, ${uklidKlientky.size} testovacích klientek)`);
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
