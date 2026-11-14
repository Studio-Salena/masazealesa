// Cílené ověření dvou věcí, které si Alena vyžádala PO prvním kole testů
// "Provedené masáže":
//
//  1) Peněžní příjmy podle období: záloha zaplacená v jednom měsíci, masáž
//     proběhne a doplatek se zaplatí v NÁSLEDUJÍCÍM měsíci — ověřuje, že
//     GET /api/admin/provedene-masaze správně rozlišuje "kdy proběhla
//     masáž" (hodnotaSluzeb/uhrazenoKSluzbam, podle rezervace.datum) od
//     "kdy fyzicky přišly peníze" (skutecnePrijato, podle platby.vytvoreno),
//     bez jakéhokoli dvojího započítání, a že peníze přijaté na rezervaci,
//     která JEŠTĚ NENÍ dokončená, se v "skutecnePrijato" neztratí.
//
//     Protože platby.vytvoreno nejde přes běžné HTTP API zpětně nastavit
//     (na rozdíl od historických poukazů, které na to mají vlastní
//     endpoint), tenhle test se napřímo připojuje k TEST databázi (přes
//     tests/env-guard.js ziskatTestDatabaseUrl() — fail-closed, produkční
//     hostname je tvrdě zakázaný) a přesně JEDEN konkrétní, testem právě
//     vytvořený řádek "platby" si zpětně podatuje do minulého měsíce. Nic
//     jiného se přes SQL nemění — všechny ostatní kroky jdou přes běžné
//     admin API, stejně jako by to dělala Alena v adminu.
//
//  2) Opakované odeslání STEJNÉ částečné platby (např. 300 Kč při doplatku
//     1050 Kč) — diagnostický důkaz, že kontrola "částka nesmí přesáhnout
//     zbývající dluh" u částečné platby NESTAČÍ (300 + 300 = 600 ≤ 1050,
//     obě by prošly) — přesně to, na co Alena upozornila. Tenhle test NIC
//     neopravuje (oprava — idempotentní klíč — vyžaduje změnu databáze a
//     API, viz návrh v hlášení), jen ověřuje a dokumentuje současné chování.
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=http://localhost:3001/api DATABASE_URL=... node tests/provedene-masaze-obdobi.test.js

const assert = require('node:assert/strict');
const { Client } = require('pg');

const { ziskatTestApiBase, ziskatTestDatabaseUrl } = require('./env-guard');
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

// Najde volný termín KONKRÉTNĚ v TOMTO měsíci (dřív než konec měsíce) — na
// rozdíl od ostatních testů v provedene-masaze.test.js, kde na konkrétním
// měsíci nezáleží, tady musí jít o "tento měsíc", aby šlo smysluplně
// porovnat s "minulým měsícem" (kam se zpětně podatuje záloha).
async function volnyTerminTentoMesic(cenikId) {
  const dnes = new Date();
  const posledniDenMesice = new Date(dnes.getFullYear(), dnes.getMonth() + 1, 0).getDate();
  for (let den = dnes.getDate() + 1; den <= posledniDenMesice; den++) {
    const d = new Date(dnes.getFullYear(), dnes.getMonth(), den);
    const iso = d.toISOString().slice(0, 10);
    const cas = await najitVolnyTermin(iso, cenikId);
    if (cas) return { datum: iso, cas };
  }
  throw new Error('V TOMTO měsíci (od zítřka do konce měsíce) není žádný volný termín pro test — zkuste spustit test jindy v měsíci.');
}

async function vytvorRezervaci(cenikId, telefonSuffix, datum, cas) {
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: cas, jmeno: 'TEST-PM-OBDOBI (smazat)', telefon: '00002' + telefonSuffix, email: 'test-pm-obdobi@example.cz' })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'Vytvoření testovací rezervace selhalo: ' + JSON.stringify(data));
  if (data.rezervace.klientka_id) uklidKlientky.add(data.rezervace.klientka_id);
  return data.rezervace;
}

async function zaplatit(id, castka, zpusob_platby) {
  return adminFetch(`/admin/rezervace/${id}/platba`, { method: 'PATCH', body: JSON.stringify({ castka, zpusob_platby }) }).then(async r => ({ status: r.status, data: await r.json() }));
}

async function dokoncit(id) {
  const res = await adminFetch(`/admin/rezervace/${id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'dokoncena' }) });
  const data = await res.json();
  assert.equal(res.status, 200, 'Dokončení rezervace selhalo: ' + JSON.stringify(data));
  return data;
}

async function posledniPlatbaId(pg, rezervaceId) {
  const { rows } = await pg.query(
    'SELECT id FROM platby WHERE rezervace_id = $1 ORDER BY vytvoreno DESC, id DESC LIMIT 1', [rezervaceId]
  );
  assert.ok(rows[0], 'Nenalezen žádný platební řádek k rezervaci ' + rezervaceId);
  return rows[0].id;
}

function mesicRozsah(datumVMesici) {
  const prvni = new Date(datumVMesici.getFullYear(), datumVMesici.getMonth(), 1);
  const posledni = new Date(datumVMesici.getFullYear(), datumVMesici.getMonth() + 1, 0);
  return { od: prvni.toISOString().slice(0, 10), do: posledni.toISOString().slice(0, 10) };
}

async function souhrnZaRozsah(od, doD) {
  return adminFetch(`/admin/provedene-masaze?od=${od}&do=${doD}`).then(r => r.json());
}

const uklidRezervace = [];
const uklidKlientky = new Set();

async function main() {
  const pg = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');
    const cena = Number(polozka.cena);

    const dnes = new Date();
    const minulyMesicDatum = new Date(dnes.getFullYear(), dnes.getMonth() - 1, 15, 10, 0, 0);
    const rozsahTentoMesic = mesicRozsah(dnes);
    const rozsahMinulyMesic = mesicRozsah(minulyMesicDatum);

    // ── 1) Peněžní příjmy podle období ──────────────────────────────────
    console.log('--- 1) záloha minulý měsíc, masáž + doplatek tento měsíc ---');
    let r;
    {
      const { datum, cas } = await volnyTerminTentoMesic(polozka.id);
      r = await vytvorRezervaci(polozka.id, '21', datum, cas);
      uklidRezervace.push(r.id);

      const zaloha = Math.max(1, Math.floor(cena / 3));
      const doplatek = cena - zaloha;

      // Záloha se zaplatí TEĎ (vytvoreno = dnes), ale pro scénář potřebujeme,
      // aby ten konkrétní platební řádek měl vytvoreno v MINULÉM měsíci —
      // proto hned po zápisu zjistíme jeho id a přímo v TEST databázi mu
      // zpětně nastavíme datum. Nic jiného se nemění.
      const p1 = await zaplatit(r.id, zaloha, 'hotove');
      assert.equal(p1.status, 200, JSON.stringify(p1.data));
      const zalohaId = await posledniPlatbaId(pg, r.id);
      await pg.query('UPDATE platby SET vytvoreno = $1 WHERE id = $2', [minulyMesicDatum, zalohaId]);

      // Ověření PŘED dokončením masáže: záloha už je zaplacená a rezervace
      // JEŠTĚ NENÍ "dokoncena" (je "potvrzena") — peníze se nesmí v
      // "skutecnePrijato" ztratit jen proto, že masáž ještě neproběhla.
      const pred = await souhrnZaRozsah(rozsahMinulyMesic.od, rozsahMinulyMesic.do);
      const polozkaPred = pred.polozky.find(p => p.zdroj === 'rezervace' && p.id === r.id);
      assert.equal(polozkaPred, undefined, 'Rezervace, která ještě není dokončená, se nesmí objevit v itemizovaném seznamu "polozky"');
      console.log('   (mezikontrola: před dokončením masáže — záloha z minulého měsíce je zaplacená, rezervace je stále "potvrzena", v "polozky" se správně NEOBJEVUJE)');

      // Doplatek se zaplatí TEĎ (= tento měsíc) a masáž se dokončí.
      const p2 = await zaplatit(r.id, doplatek, 'kartou');
      assert.equal(p2.status, 200, JSON.stringify(p2.data));
      await dokoncit(r.id);

      // a) Hodnota provedené masáže patří do TOHOTO měsíce (podle data masáže)
      const tento = await souhrnZaRozsah(rozsahTentoMesic.od, rozsahTentoMesic.do);
      const polozkaTento = tento.polozky.find(p => p.zdroj === 'rezervace' && p.id === r.id);
      assert.ok(polozkaTento, 'Dokončená masáž se měla objevit v přehledu pro TENTO měsíc (podle data masáže)');
      assert.equal(polozkaTento.cena, cena);
      assert.equal(polozkaTento.uhrazeno, cena, 'uhrazenoKSluzbam má zahrnout OBĚ platby (zálohu i doplatek), bez ohledu na to, kdy byly zaplacené');
      assert.equal(polozkaTento.stav_platby, 'zaplaceno');

      const minuly = await souhrnZaRozsah(rozsahMinulyMesic.od, rozsahMinulyMesic.do);
      const polozkaMinuly = minuly.polozky.find(p => p.zdroj === 'rezervace' && p.id === r.id);
      assert.equal(polozkaMinuly, undefined, 'Hodnota provedené masáže nesmí patřit do minulého měsíce — datum masáže je v TOMTO měsíci');
      console.log('   OK — hodnota provedené masáže patří celá do TOHOTO měsíce (datum masáže), ne do minulého');

      // b) Minulý měsíc: skutecnePrijato obsahuje přesně zálohu
      assert.equal(minuly.souhrn.skutecnePrijato, zaloha,
        'Minulý měsíc má mezi "skutečně přijaté peníze" zahrnovat přesně zálohu (' + zaloha + ' Kč), dostáno ' + minuly.souhrn.skutecnePrijato);
      console.log('   OK — minulý měsíc: skutečně přijaté peníze = záloha (' + zaloha + ' Kč)');

      // c) Tento měsíc: skutecnePrijato obsahuje přesně doplatek (NE zálohu)
      assert.equal(tento.souhrn.skutecnePrijato, doplatek,
        'Tento měsíc má mezi "skutečně přijaté peníze" zahrnovat přesně doplatek (' + doplatek + ' Kč), dostáno ' + tento.souhrn.skutecnePrijato);
      console.log('   OK — tento měsíc: skutečně přijaté peníze = doplatek (' + doplatek + ' Kč), záloha se NEOPAKUJE');

      // d) Žádná platba se nezapočítá dvakrát: součet obou měsíců = přesně cena
      assert.equal(minuly.souhrn.skutecnePrijato + tento.souhrn.skutecnePrijato, cena,
        'Součet "skutečně přijato" za oba měsíce musí přesně odpovídat ceně masáže (žádné dvojí započítání, žádná ztráta)');
      console.log('   OK — záloha (minulý měsíc) + doplatek (tento měsíc) = přesně cena masáže (' + cena + ' Kč), žádné dvojí započítání');

      // e) Souhrn přes OBA měsíce najednou dá stejný výsledek jako součet
      // dvou samostatných dotazů (konzistence filtru, ne jen náhoda).
      const oba = await souhrnZaRozsah(rozsahMinulyMesic.od, rozsahTentoMesic.do);
      assert.equal(oba.souhrn.skutecnePrijato, cena, 'Dotaz přes rozsah obou měsíců musí dát stejný součet jako dva dotazy zvlášť');
      console.log('   OK — dotaz přes celý rozsah (minulý+tento měsíc) dá stejný součet jako dva dotazy zvlášť');
    }

    // ── 2) Opakované odeslání stejné částečné platby ────────────────────
    console.log('--- 2) dvojí odeslání stejné částečné platby (diagnostika) ---');
    {
      const { datum, cas } = await volnyTerminTentoMesic(polozka.id);
      const r2 = await vytvorRezervaci(polozka.id, '22', datum, cas);
      uklidRezervace.push(r2.id);
      const cena2 = Number(polozka.cena);
      const castka = Math.max(1, Math.floor(cena2 * 0.3)); // obdoba "300 Kč z 1050 Kč" ze zadání

      // Dvojí odeslání STEJNÉHO požadavku — simulace ztraceného
      // potvrzení / dvojkliku, kdy klient neví, že první pokus už prošel.
      const [a, b] = await Promise.all([
        zaplatit(r2.id, castka, 'hotove'),
        zaplatit(r2.id, castka, 'hotove')
      ]);
      const historie = await adminFetch(`/admin/rezervace/${r2.id}/platby`).then(res => res.json());
      const soucet = historie.reduce((s, p) => s + Number(p.castka), 0);

      console.log('   Pokus A: ' + a.status + ', pokus B: ' + b.status + ', řádků v historii: ' + historie.length + ', zapsáno celkem: ' + soucet + ' Kč (odesláno ' + castka + ' Kč jednou)');
      if (historie.length === 2 && soucet === castka * 2) {
        console.log('   POTVRZENO RIZIKO — kontrola "částka ≤ zbývající dluh" dvojí odeslání částečné platby NEZACHYTÍ: vznikly 2 platební řádky na ' + soucet + ' Kč místo 1 na ' + castka + ' Kč.');
        console.log('   (Přesně to, na co Alena upozornila — řešení: idempotentní klíč, viz návrh v hlášení. Tenhle test nic neopravuje, jen to dokládá.)');
      } else {
        console.log('   Neočekávaný výsledek (' + historie.length + ' řádků, ' + soucet + ' Kč) — zkontrolovat ručně, chování se může lišit podle časování souběhu.');
      }
      // Úklid dalšího doplatku, ať testovací rezervace nezůstane se zbytkovým
      // dluhem viditelná jako "nedoplaceno" déle, než je pro úklid potřeba —
      // rezervace se ale stejně hned po testu maže, takže jde jen o pořádek.
    }

    console.log('\n✅ OBĚ CÍLENÁ OVĚŘENÍ DOKONČENA (viz výsledky a POTVRZENÉ RIZIKO výš)');
  } finally {
    for (const id of uklidRezervace) {
      await adminFetch(`/admin/rezervace/${id}`, { method: 'DELETE' }).catch(() => null);
    }
    let klientkySmazano = 0;
    for (const id of uklidKlientky) {
      const r = await adminFetch(`/admin/klientky/${id}`, { method: 'DELETE' }).catch(() => null);
      if (r && r.ok) klientkySmazano++;
    }
    await pg.end();
    if (uklidRezervace.length || uklidKlientky.size) {
      console.log(`(uklizeno: ${uklidRezervace.length} testovacích rezervací, ${klientkySmazano}/${uklidKlientky.size} testovacích klientek)`);
    }
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
