// Regresní test: Krok 3b EET 2.0 — napojení skutečných platebních operací
// na databázovou evidenci z Kroku 3a (přes HTTP admin endpointy, ne přímým
// SQL jako eet-krok3a.test.js — tady testujeme PROPOJENÍ, ne samotné funkce).
//
// Tenhle test VYŽADUJE, aby TEST databáze měla nastaveni.eet_evidence_zapnuta
// = 'true' (jinak by níže popsané scénáře triviálně "prošly" tím, že se
// nic neeviduje vůbec). V produkci zůstává 'false' — tohle přepnutí je
// výhradně pro TEST prostředí, viz zpráva k Kroku 3b.
//
// Cíl testu:
//  1) Platba rezervace (hotově) vytvoří evidovanou tržbu (smer='prijem',
//     správná částka).
//  2) Skutečná vratka vytvoří NEZÁVISLÉ storno (jiné pokladni_udalost_id,
//     záporná částka) — storno a původní platba nejsou propojené (spec).
//  3) "Vratka jako poukaz" NEvytváří žádný EET záznam (neověřený právní
//     závěr, zatím výslovně neimplementováno — viz bod 5 zprávy).
//  4) Idempotence platby rezervace: opakovaný požadavek (retry po výpadku)
//     se stejným idempotency_klic nezdvojí EET záznam.
//  5) Prodej poukazu (zaplaceno rovnou) vytvoří EET zdroj typu 'poukaz'.
//  6) Potvrzení platby existujícího poukazu vytvoří EET zdroj.
//  7) Doplnění HISTORICKÉ platby poukazu NEvytváří žádný EET záznam.
//  8) Čerpání poukazu NA ČÁSTKU bez rezervace vytvoří EET zdroj (cerp_zuct).
//  9) Čerpání poukazu NA KONKRÉTNÍ SLUŽBU nevytváří při čerpání nic (jen
//     při prodeji).
// 10) Prodejna — kombinovaná platba (poukaz na částku + hotovostní zbytek)
//     se sloučí do JEDNÉ evidované tržby (jedna zpráva pro kombinovanou
//     platbu, podle spec).
// 11) Prodejna — SKUTEČNÝ souběh dvou požadavků se stejným idempotenčním
//     klíčem (ne jen sekvenční opakování) vytvoří jen JEDEN prodej a jen
//     JEDNU evidovanou tržbu.
// 12) Produkty — prodej vytvoří EET zdroj a je stejně odolný proti souběhu.
// 13) Mazání prodeje, který je už evidovaný pro EET, je odmítnuto (ochrana
//     návaznosti, bod 6 zprávy).
// 14) Atomicita: selhání EET databázové funkce uvnitř transakce způsobí
//     ROLLBACK CELÉ transakce, včetně obchodního řádku (přímé SQL, protože
//     žádný HTTP parametr neumí tohle selhání vyvolat zvenčí).
// 15) Při eet_evidence_zapnuta='false' se nevytváří žádný nový záznam, i
//     když kód hák zavolá.
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=http://localhost:3001/api DATABASE_URL=... node tests/eet-krok3b-platby.test.js

const assert = require('node:assert/strict');
const { Client } = require('pg');
const { ziskatTestApiBase, ziskatTestDatabaseUrl } = require('./env-guard');
const { uklidRezervaciSFallbackem } = require('./test-helpers');

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

let c; // hlavní přímé DB spojení pro ověřovací dotazy — zavřeno v .finally() na konci
async function dotaz(sql, params) { return (await c.query(sql, params)).rows; }

const uklidTrzbaId = new Set(); // JEN tržby vytvořené tímto testem — cleanup nikdy nesahá na cizí/cizí testy
async function zdrojeTrzby(zdrojTyp, zdrojId) {
  const radky = await dotaz(
    `SELECT et.* FROM evidovana_trzba_zdroje z JOIN evidovana_trzba et ON et.id = z.evidovana_trzba_id
     WHERE z.zdroj_typ = $1 AND z.zdroj_id = $2`,
    [zdrojTyp, zdrojId]
  );
  radky.forEach(r => uklidTrzbaId.add(r.id));
  return radky;
}
// Delegováno na zdrojeTrzby (ne vlastní dotaz) — jinak by řádky zjištěné
// JEN přes pocetZdroju nebyly v uklidTrzbaId a po testu by v databázi
// osaměly (reálně se to stalo — viz oprava po auditu bodu 5/7: takhle
// osamělé evidované tržby ze SPOLEČNÉ TEST databáze narušily jiný test,
// eet-krok3a.test.js scénář 4b, přetížením fronty).
async function pocetZdroju(zdrojTyp, zdrojId) {
  return (await zdrojeTrzby(zdrojTyp, zdrojId)).length;
}

const uklidRezervace = [];
const uklidPoukazy = [];
const uklidProdejny = [];
const uklidProdukty = [];

let telefonCitac = 90000;
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
async function vytvorRezervaci(cenikId, sufix) {
  telefonCitac++;
  const { datum, cas } = await novyVolnyTermin(cenikId, 1800 + telefonCitac);
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: cas, jmeno: 'TEST-EET3B ' + sufix + ' (smazat)', telefon: '0000' + telefonCitac, email: 'test-eet3b@example.cz' })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'vytvoření testovací rezervace musí uspět: ' + JSON.stringify(data));
  uklidRezervace.push(data.rezervace.id);
  return data.rezervace;
}

async function main() {
  console.log('--- Krok 3b EET: napojení skutečných plateb na evidenci ---');

  const cenikRes = await adminFetch('/admin/cenik').then(r => r.json());
  const polozka = cenikRes.find(p => Number(p.cena) > 0 && p.rezervovatelna !== false);
  assert.ok(polozka, 'ceník musí mít aspoň jednu rezervovatelnou položku s cenou > 0');

  // 1) Platba rezervace (hotově) → evidovaná tržba
  {
    const r = await vytvorRezervaci(polozka.id, '1-platba');
    const castka = Number(r.cena);
    const res = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka, zpusob_platby: 'hotove', kontaktni_platba: true })
    });
    const data = await res.json();
    assert.equal(res.status, 200, '1) platba musí uspět: ' + JSON.stringify(data));
    const platbaId = data.rezervace ? (await dotaz('SELECT id FROM platby WHERE rezervace_id=$1 ORDER BY id DESC LIMIT 1', [r.id]))[0].id : null;
    const zdroje = await zdrojeTrzby('platba', platbaId);
    assert.equal(zdroje.length, 1, '1a) musí vzniknout právě jedna evidovaná tržba pro tuhle platbu');
    assert.equal(zdroje[0].smer, 'prijem', '1b) smer musí být "prijem"');
    assert.equal(Number(zdroje[0].celk_trzba), castka, '1c) celk_trzba musí sedět s zaplacenou částkou');
    console.log('OK — 1) platba rezervace vytváří evidovanou tržbu se správnou částkou');

    // 2) Skutečná vratka (hotově) → NEZÁVISLÉ storno
    const vratkaCastka = Math.min(50, castka);
    const resV = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: vratkaCastka, typ: 'vratka', zpusob_platby: 'hotove', kontaktni_platba: true })
    });
    const dataV = await resV.json();
    assert.equal(resV.status, 200, '2) vratka musí uspět: ' + JSON.stringify(dataV));
    const vratkaId = (await dotaz('SELECT id FROM platby WHERE rezervace_id=$1 AND typ=$2 ORDER BY id DESC LIMIT 1', [r.id, 'vratka']))[0].id;
    const zdrojeV = await zdrojeTrzby('platba', vratkaId);
    assert.equal(zdrojeV.length, 1, '2a) storno musí vzniknout jako vlastní evidovaná tržba');
    assert.equal(zdrojeV[0].smer, 'storno', '2b) smer musí být "storno"');
    assert.equal(Number(zdrojeV[0].celk_trzba), -vratkaCastka, '2c) celk_trzba musí být záporná částka vratky');
    assert.notEqual(zdrojeV[0].pokladni_udalost_id, zdroje[0].pokladni_udalost_id, '2d) storno NESMÍ být propojené s původní platbou (jiné pokladni_udalost_id)');
    console.log('OK — 2) skutečná vratka vytváří nezávislé EET storno');
  }

  // 3) Vratka "jako poukaz" — žádný EET záznam
  {
    const r = await vytvorRezervaci(polozka.id, '3-vratka-poukaz');
    const castka = Number(r.cena);
    await adminFetch(`/admin/rezervace/${r.id}/platba`, { method: 'PATCH', body: JSON.stringify({ castka, zpusob_platby: 'hotove' }) });
    const vratkaCastka = Math.min(30, castka);
    const res = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: vratkaCastka, typ: 'vratka', zpusob_platby: 'poukaz' })
    });
    const data = await res.json();
    assert.equal(res.status, 200, '3) vratka jako poukaz musí uspět: ' + JSON.stringify(data));
    assert.ok(data.poukaz && data.poukaz.id, '3a) musí vzniknout nový poukaz');
    uklidPoukazy.push(data.poukaz.id);
    const vratkaId = (await dotaz('SELECT id FROM platby WHERE rezervace_id=$1 AND typ=$2 ORDER BY id DESC LIMIT 1', [r.id, 'vratka']))[0].id;
    const n = await pocetZdroju('platba', vratkaId);
    assert.equal(n, 0, '3b) vratka jako poukaz NESMÍ vytvořit žádný EET záznam (zatím neimplementováno, viz bod 5)');
    console.log('OK — 3) vratka jako poukaz nevytváří žádný EET záznam (jak má, zatím neimplementováno)');
  }

  // 4) Idempotence platby rezervace — retry po "výpadku" nezdvojí EET
  {
    const r = await vytvorRezervaci(polozka.id, '4-idempotence');
    const castka = Number(r.cena);
    const klic = require('crypto').randomUUID();
    const telo = JSON.stringify({ castka, zpusob_platby: 'kartou', idempotency_klic: klic });
    const res1 = await adminFetch(`/admin/rezervace/${r.id}/platba`, { method: 'PATCH', body: telo });
    assert.equal(res1.status, 200, '4a) první požadavek musí uspět: ' + JSON.stringify(await res1.json().catch(() => ({}))));
    // Retry STEJNÉHO požadavku (simulace opakování po výpadku spojení)
    const res2 = await adminFetch(`/admin/rezervace/${r.id}/platba`, { method: 'PATCH', body: telo });
    const data2 = await res2.json();
    assert.equal(res2.status, 200, '4b) opakovaný požadavek musí uspět (idempotentně): ' + JSON.stringify(data2));
    assert.equal(data2.idempotentni, true, '4c) opakovaný požadavek se musí poznat jako idempotentní replay');
    const platbaId = (await dotaz('SELECT id FROM platby WHERE idempotency_klic=$1', [klic]))[0].id;
    const n = await pocetZdroju('platba', platbaId);
    assert.equal(n, 1, '4d) i po opakování musí existovat JEN JEDEN EET zdroj pro tuhle platbu');
    console.log('OK — 4) opakování požadavku po výpadku spojení nezdvojí EET záznam');
  }

  // 5) Prodej poukazu (zaplaceno rovnou) → EET zdroj 'poukaz'
  let poukazTypId;
  {
    let typy = await adminFetch('/admin/poukazy/typy').then(r => r.json());
    if (!typy.length) {
      const resTyp = await adminFetch('/admin/poukazy/typy', { method: 'POST', body: JSON.stringify({ hodnota: 500, platnost_mesicu: 12 }) });
      poukazTypId = (await resTyp.json()).typ.id;
    } else {
      poukazTypId = typy[0].id;
    }
    const res = await adminFetch('/admin/poukazy', {
      method: 'POST',
      body: JSON.stringify({ poukaz_typ_id: poukazTypId, kupujici_jmeno: 'TEST-EET3B Poukaz (smazat)', zaplaceno: true, zpusob_platby: 'hotove', kontaktni_platba: true })
    });
    const data = await res.json();
    assert.equal(res.status, 200, '5) vydání poukazu musí uspět: ' + JSON.stringify(data));
    uklidPoukazy.push(data.poukaz.id);
    const zdroje = await zdrojeTrzby('poukaz', data.poukaz.id);
    assert.equal(zdroje.length, 1, '5a) prodej poukazu musí vytvořit evidovanou tržbu');
    assert.equal(Number(zdroje[0].celk_trzba), Number(data.poukaz.hodnota), '5b) celk_trzba musí sedět s hodnotou poukazu');
    console.log('OK — 5) prodej poukazu vytváří evidovanou tržbu');
  }

  // 6) Potvrzení platby existujícího (nezaplaceného) poukazu → EET zdroj
  let poukazNaCastkuId;
  {
    const resVydani = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ poukaz_typ_id: poukazTypId, kupujici_jmeno: 'TEST-EET3B Potvrzeni (smazat)', zaplaceno: false })
    });
    const dataVydani = await resVydani.json();
    assert.equal(resVydani.status, 200, '6) vydání nezaplaceného poukazu musí uspět');
    poukazNaCastkuId = dataVydani.poukaz.id;
    uklidPoukazy.push(poukazNaCastkuId);
    const res = await adminFetch(`/admin/poukazy/${poukazNaCastkuId}/potvrdit-platbu`, {
      method: 'PATCH', body: JSON.stringify({ zpusob_platby: 'qr', kontaktni_platba: true })
    });
    const data = await res.json();
    assert.equal(res.status, 200, '6a) potvrzení platby musí uspět: ' + JSON.stringify(data));
    const zdroje = await zdrojeTrzby('poukaz', poukazNaCastkuId);
    assert.equal(zdroje.length, 1, '6b) potvrzení platby musí vytvořit evidovanou tržbu');
    console.log('OK — 6) potvrzení platby poukazu vytváří evidovanou tržbu');
  }

  // 7) Doplnění HISTORICKÉ platby — žádný EET záznam
  {
    const resVydani = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ poukaz_typ_id: poukazTypId, kupujici_jmeno: 'TEST-EET3B Historie (smazat)', zaplaceno: false })
    });
    const poukazId = (await resVydani.json()).poukaz.id;
    uklidPoukazy.push(poukazId);
    // Historický poukaz = stav_uhrady IS NULL (ne 'nezaplaceno') — přímo v DB,
    // stejně jako existující historické řádky, žádný endpoint na "vytvoření
    // historického poukazu" neexistuje (logicky, ty vznikly před Etapou 2).
    await c.query(`UPDATE poukazy SET stav_uhrady = NULL WHERE id = $1`, [poukazId]);
    const res = await adminFetch(`/admin/poukazy/${poukazId}/doplnit-historickou-platbu`, {
      method: 'PATCH', body: JSON.stringify({ zpusob_platby: 'hotove', zaplaceno_kdy: '2020-01-15' })
    });
    const data = await res.json();
    assert.equal(res.status, 200, '7) doplnění historické platby musí uspět: ' + JSON.stringify(data));
    const n = await pocetZdroju('poukaz', poukazId);
    assert.equal(n, 0, '7a) doplnění historické platby NESMÍ vytvořit žádný EET záznam');
    console.log('OK — 7) doplnění historické platby nevytváří EET záznam (historické platby se zpětně neevidují)');
  }

  // 8) Čerpání poukazu NA ČÁSTKU bez rezervace → EET zdroj (cerp_zuct)
  {
    const zustatekPred = Number((await adminFetch(`/admin/poukazy`).then(r => r.json())).find(p => p.id === poukazNaCastkuId).zustatek);
    const castka = Math.min(50, zustatekPred);
    const res = await adminFetch(`/admin/poukazy/${poukazNaCastkuId}/uplatnit`, { method: 'POST', body: JSON.stringify({ castka }) });
    const data = await res.json();
    assert.equal(res.status, 200, '8) čerpání bez rezervace musí uspět: ' + JSON.stringify(data));
    const historieId = (await dotaz('SELECT id FROM poukazy_historie WHERE poukaz_id=$1 ORDER BY id DESC LIMIT 1', [poukazNaCastkuId]))[0].id;
    const zdroje = await zdrojeTrzby('poukaz_historie', historieId);
    assert.equal(zdroje.length, 1, '8a) čerpání poukazu na částku musí vytvořit evidovanou tržbu');
    assert.equal(Number(zdroje[0].cerp_zuct), castka, '8b) cerp_zuct musí sedět s čerpanou částkou');
    console.log('OK — 8) čerpání poukazu na částku bez rezervace vytváří evidovanou tržbu (cerp_zuct)');
  }

  // 9) Čerpání poukazu NA KONKRÉTNÍ SLUŽBU — žádný nový záznam při čerpání
  {
    const res = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-EET3B Konkretni (smazat)', zaplaceno: true, zpusob_platby: 'hotove' })
    });
    const data = await res.json();
    assert.equal(res.status, 200, '9) vydání poukazu na konkrétní službu musí uspět');
    const poukazId = data.poukaz.id;
    uklidPoukazy.push(poukazId);
    assert.ok(data.poukaz.konkretni_masaz, '9a) poukaz musí mít vyplněné konkretni_masaz');
    const pocetPoProdeji = await pocetZdroju('poukaz', poukazId);
    assert.equal(pocetPoProdeji, 1, '9b) prodej musí vytvořit evidovanou tržbu (to je v pořádku, to je bod 5)');
    const resUplatnit = await adminFetch(`/admin/poukazy/${poukazId}/uplatnit`, { method: 'POST', body: JSON.stringify({ castka: Number(data.poukaz.hodnota) }) });
    assert.equal(resUplatnit.status, 200, '9c) čerpání musí uspět');
    const historieId = (await dotaz('SELECT id FROM poukazy_historie WHERE poukaz_id=$1 ORDER BY id DESC LIMIT 1', [poukazId]))[0].id;
    const n = await pocetZdroju('poukaz_historie', historieId);
    assert.equal(n, 0, '9d) čerpání poukazu na KONKRÉTNÍ SLUŽBU NESMÍ vytvořit nový EET záznam (byl evidovaný už při prodeji)');
    console.log('OK — 9) čerpání poukazu na konkrétní službu nevytváří nový EET záznam při čerpání');
  }

  // 10) Prodejna — kombinovaná platba (poukaz na částku + hotovostní zbytek) → JEDNA evidovaná tržba
  {
    const resVydani = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ poukaz_typ_id: poukazTypId, kupujici_jmeno: 'TEST-EET3B Kombi (smazat)', zaplaceno: true, zpusob_platby: 'hotove' })
    });
    const poukaz = (await resVydani.json()).poukaz;
    uklidPoukazy.push(poukaz.id);
    const cena = Number(poukaz.hodnota) + 390; // cena je o 390 vyšší než zůstatek na poukazu -> kombinace
    const res = await adminFetch('/admin/prodejna', {
      method: 'POST', body: JSON.stringify({ masaz: 'TEST-EET3B kombinovana platba', cena, zpusob_platby: 'hotove', poukaz_kod: poukaz.kod })
    });
    const data = await res.json();
    assert.equal(res.status, 200, '10) kombinovaný prodej musí uspět: ' + JSON.stringify(data));
    uklidProdejny.push(data.prodej.id);
    assert.equal(Number(data.prodej.poukaz_castka), Number(poukaz.hodnota), '10a) z poukazu se musí strhnout celý jeho zůstatek');
    const zdrojeProdej = await zdrojeTrzby('prodej', data.prodej.id);
    const historieId = (await dotaz('SELECT id FROM poukazy_historie WHERE prodej_id=$1', [data.prodej.id]))[0].id;
    const zdrojeHistorie = await zdrojeTrzby('poukaz_historie', historieId);
    assert.equal(zdrojeProdej.length, 1, '10b) musí existovat evidovaná tržba pro hotovostní zbytek');
    assert.equal(zdrojeHistorie.length, 1, '10c) musí existovat evidovaná tržba pro čerpání poukazu');
    assert.equal(zdrojeProdej[0].id, zdrojeHistorie[0].id, '10d) OBA zdroje se musí sloučit do JEDNÉ evidované tržby (kombinovaná platba = jedna zpráva)');
    assert.equal(Number(zdrojeProdej[0].celk_trzba), cena, '10e) celk_trzba musí sedět s celkovou cenou (poukaz + hotovost)');
    assert.equal(Number(zdrojeProdej[0].cerp_zuct), Number(poukaz.hodnota), '10f) cerp_zuct musí sedět s částkou kryté poukazem');
    console.log('OK — 10) kombinovaná platba poukazem + hotovostí se sloučí do jedné evidované tržby');
  }

  // 11) Prodejna — SKUTEČNÝ souběh dvou požadavků se stejným klíčem
  {
    const klic = require('crypto').randomUUID();
    const telo = JSON.stringify({ masaz: 'TEST-EET3B soubeh', cena: 500, zpusob_platby: 'hotove', idempotency_klic: klic });
    const [r1, r2] = await Promise.all([
      adminFetch('/admin/prodejna', { method: 'POST', body: telo }),
      adminFetch('/admin/prodejna', { method: 'POST', body: telo })
    ]);
    const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
    assert.equal(r1.status, 200, '11a) první z dvojice souběžných požadavků musí uspět: ' + JSON.stringify(d1));
    assert.equal(r2.status, 200, '11b) druhý z dvojice souběžných požadavků musí uspět (ne chybu): ' + JSON.stringify(d2));
    assert.equal(d1.prodej.id, d2.prodej.id, '11c) oba požadavky musí vrátit TENTÝŽ prodej (ne dva různé)');
    uklidProdejny.push(d1.prodej.id);
    const pocetProdeju = Number((await dotaz('SELECT count(*) FROM prodeje WHERE idempotency_klic = $1', [klic]))[0].count);
    assert.equal(pocetProdeju, 1, '11d) v databázi musí existovat jen JEDEN prodej, i při skutečném souběhu dvou požadavků');
    const n = await pocetZdroju('prodej', d1.prodej.id);
    assert.equal(n, 1, '11e) a jen JEDEN EET zdroj pro tenhle prodej');
    console.log('OK — 11) skutečný souběh dvou požadavků se stejným klíčem vytvoří jen jeden prodej a jednu evidovanou tržbu');
  }

  // 12) Produkty — prodej vytváří EET zdroj a je odolný proti souběhu
  {
    const resProdukt = await adminFetch('/admin/produkty', {
      method: 'POST', body: JSON.stringify({ skupina: 'TEST-EET3B', varianta: 'produkt (smazat)', cena: 199, sklad: 10 })
    });
    const produkt = (await resProdukt.json()).produkt;
    uklidProdukty.push(produkt.id);
    const klic = require('crypto').randomUUID();
    const telo = JSON.stringify({ mnozstvi: 1, zpusob_platby: 'hotove', idempotency_klic: klic });
    const [r1, r2] = await Promise.all([
      adminFetch(`/admin/produkty/${produkt.id}/prodat`, { method: 'POST', body: telo }),
      adminFetch(`/admin/produkty/${produkt.id}/prodat`, { method: 'POST', body: telo })
    ]);
    const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
    assert.equal(r1.status, 200, '12a) první požadavek musí uspět: ' + JSON.stringify(d1));
    assert.equal(r2.status, 200, '12b) druhý (souběžný) požadavek musí uspět idempotentně: ' + JSON.stringify(d2));
    assert.equal(d1.prodej.id, d2.prodej.id, '12c) oba musí vrátit tentýž prodej');
    const pocetProdeju = Number((await dotaz('SELECT count(*) FROM prodeje_produktu WHERE idempotency_klic = $1', [klic]))[0].count);
    assert.equal(pocetProdeju, 1, '12d) jen JEDEN prodej produktu v databázi, i při souběhu');
    const pocetSkladu = Number((await adminFetch('/admin/produkty').then(r => r.json())).find(p => p.id === produkt.id).sklad);
    assert.equal(pocetSkladu, 9, '12e) sklad se musí snížit jen o 1 ks, ne o 2');
    const zdroje = await zdrojeTrzby('prodej_produktu', d1.prodej.id);
    assert.equal(zdroje.length, 1, '12f) musí vzniknout evidovaná tržba pro prodej produktu');
    const kontaktniNaZdroji = (await dotaz('SELECT kontaktni_platba FROM prodeje_produktu WHERE id=$1', [d1.prodej.id]))[0].kontaktni_platba;
    assert.equal(kontaktniNaZdroji, true, '12g) prodej produktu musí mít kontaktni_platba=true (explicitně, osobní prodej v salonu)');
    console.log('OK — 12) prodej produktu vytváří evidovanou tržbu, je odolný proti souběhu a má explicitní kontaktni_platba=true');
  }

  // 13) Mazání evidovaného prodeje je odmítnuto (ochrana návaznosti)
  {
    const res = await adminFetch('/admin/prodejna', {
      method: 'POST', body: JSON.stringify({ masaz: 'TEST-EET3B mazani', cena: 300, zpusob_platby: 'hotove' })
    });
    const prodej = (await res.json()).prodej;
    const resSmazat = await adminFetch(`/admin/prodejna/${prodej.id}`, { method: 'DELETE' });
    const dataSmazat = await resSmazat.json();
    assert.equal(resSmazat.status, 400, '13a) smazání evidovaného prodeje musí být odmítnuto');
    assert.match(dataSmazat.chyba, /EET/, '13b) chybová zpráva musí zmínit EET');
    const stale = await dotaz('SELECT id FROM prodeje WHERE id = $1', [prodej.id]);
    assert.equal(stale.length, 1, '13c) prodej musí v databázi zůstat (nebyl smazán)');
    uklidProdejny.push(prodej.id); // (zůstane jen jako historická stopa, nejde smazat — stejně jako v produkci)
    console.log('OK — 13) mazání prodeje, který je už evidovaný pro EET, je odmítnuto');
  }

  // 14) Atomicita — selhání EET funkce vrátí ZPĚT i obchodní řádek (přímé SQL)
  {
    const r = await vytvorRezervaci(polozka.id, '14-atomicita');
    const castka = Number(r.cena);
    const c2 = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await c2.connect();
    try {
      await c2.query('BEGIN');
      const { rows: [platba] } = await c2.query(
        `INSERT INTO platby (rezervace_id, castka, typ, zpusob_platby) VALUES ($1,$2,'platba','hotove') RETURNING id`,
        [r.id, castka]
      );
      let selhalo = false;
      try {
        // 'neplatny' porušuje "smer in ('prijem','storno')" — simuluje chybu
        // EET funkce PŘESNĚ tak, jak by k ní mohlo dojít (např. budoucí chyba
        // v kódu, poškozená konfigurace) — server.js na tohle reaguje
        // standardním catch+ROLLBACK (stejný kód jako na jakoukoli jinou
        // chybu v transakci).
        await c2.query(`SELECT * FROM eet_zaevidovat_zdroj($1,'neplatny','platba',$2,$3,'X','Y',now())`, [require('crypto').randomUUID(), platba.id, castka]);
      } catch (e) {
        selhalo = true;
      }
      assert.equal(selhalo, true, '14a) neplatný "smer" musí vyvolat chybu (ne tiše prolétnout)');
      await c2.query('ROLLBACK');
    } finally {
      await c2.end();
    }
    const stalePlatby = await dotaz('SELECT id FROM platby WHERE rezervace_id = $1', [r.id]);
    assert.equal(stalePlatby.length, 0, '14b) po ROLLBACKu nesmí v databázi zůstat ANI obchodní řádek (platba), ani EET záznam — celá transakce musí zmizet beze stopy');
    console.log('OK — 14) selhání EET funkce vrátí zpět celou transakci včetně obchodního řádku (atomicita)');
  }

  // 15) Vypnutá evidence (eet_evidence_zapnuta=false) → opravdu nic nevzniká
  {
    await c.query(`UPDATE nastaveni SET hodnota = 'false' WHERE klic = 'eet_evidence_zapnuta'`);
    try {
      const r = await vytvorRezervaci(polozka.id, '15-vypnuto');
      const castka = Number(r.cena);
      const res = await adminFetch(`/admin/rezervace/${r.id}/platba`, { method: 'PATCH', body: JSON.stringify({ castka, zpusob_platby: 'hotove' }) });
      assert.equal(res.status, 200, '15a) platba samotná musí i tak uspět (EET vypnuté neblokuje byznys)');
      const platbaId = (await dotaz('SELECT id FROM platby WHERE rezervace_id=$1', [r.id]))[0].id;
      const n = await pocetZdroju('platba', platbaId);
      assert.equal(n, 0, '15b) při vypnuté evidenci nesmí vzniknout ŽÁDNÝ nový EET záznam');
      console.log('OK — 15) při eet_evidence_zapnuta=false nevzniká žádný nový EET záznam');
    } finally {
      await c.query(`UPDATE nastaveni SET hodnota = 'true' WHERE klic = 'eet_evidence_zapnuta'`);
    }
  }

  // ── Audit idempotentních operací (dodatečné schválení) ──────────────────

  // 16) Prodejna + kupón — SKUTEČNÝ souběh dvou požadavků se stejným klíčem
  //     a stejným kupónem: oprava bodu 1 — druhý nesmí dostat "kupón už
  //     použit", musí dostat stejný idempotentní výsledek.
  {
    const resKupon = await adminFetch('/admin/slevove-kupony/vygenerovat', {
      method: 'POST', body: JSON.stringify({ pocet: 1, nazev_akce: 'TEST-EET3B-kupon', sleva_castka: 50 })
    });
    const kupon = (await resKupon.json()).kupony[0];
    const klic = require('crypto').randomUUID();
    const telo = JSON.stringify({ masaz: 'TEST-EET3B kupon soubeh', cena: 450, zpusob_platby: 'hotove', kupon_kod: kupon.kod, idempotency_klic: klic });
    const [r1, r2] = await Promise.all([
      adminFetch('/admin/prodejna', { method: 'POST', body: telo }),
      adminFetch('/admin/prodejna', { method: 'POST', body: telo })
    ]);
    const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
    assert.equal(r1.status, 200, '16a) první požadavek s kupónem musí uspět: ' + JSON.stringify(d1));
    assert.equal(r2.status, 200, '16b) druhý (souběžný) požadavek musí uspět idempotentně, NE "kupón už byl použit": ' + JSON.stringify(d2));
    assert.equal(d1.prodej.id, d2.prodej.id, '16c) oba musí vrátit tentýž prodej');
    uklidProdejny.push(d1.prodej.id);
    const pocetProdeju = Number((await dotaz('SELECT count(*) FROM prodeje WHERE idempotency_klic = $1', [klic]))[0].count);
    assert.equal(pocetProdeju, 1, '16d) jen JEDEN prodej, kupón spotřebovaný jen jednou');
    const kuponPo = (await dotaz('SELECT pouzito_kdy FROM slevove_kupony WHERE id = $1', [kupon.id]))[0];
    assert.ok(kuponPo.pouzito_kdy, '16e) kupón musí být označený jako použitý (přesně jednou)');
    console.log('OK — 16) prodejna + kupón: souběh se stejným klíčem nevrací chybně "kupón už použit"');
  }

  // 17) Prodejna + poukaz (plné vyčerpání) — SKUTEČNÝ souběh, oprava bodu 1
  //     (stejná třída chyby jako kupón, jen na straně poukazu).
  {
    const resVydani = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ poukaz_typ_id: poukazTypId, kupujici_jmeno: 'TEST-EET3B Soubeh-vycerpani (smazat)', zaplaceno: true, zpusob_platby: 'hotove' })
    });
    const poukaz = (await resVydani.json()).poukaz;
    uklidPoukazy.push(poukaz.id);
    const klic = require('crypto').randomUUID();
    const telo = JSON.stringify({ masaz: 'TEST-EET3B vycerpani soubeh', cena: Number(poukaz.hodnota), zpusob_platby: 'hotove', poukaz_kod: poukaz.kod, idempotency_klic: klic });
    const [r1, r2] = await Promise.all([
      adminFetch('/admin/prodejna', { method: 'POST', body: telo }),
      adminFetch('/admin/prodejna', { method: 'POST', body: telo })
    ]);
    const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
    assert.equal(r1.status, 200, '17a) první požadavek musí uspět: ' + JSON.stringify(d1));
    assert.equal(r2.status, 200, '17b) druhý (souběžný) požadavek musí uspět idempotentně, NE "poukaz je už plně vyčerpaný": ' + JSON.stringify(d2));
    assert.equal(d1.prodej.id, d2.prodej.id, '17c) oba musí vrátit tentýž prodej');
    uklidProdejny.push(d1.prodej.id);
    const poukazPo = (await adminFetch('/admin/poukazy').then(r => r.json())).find(p => p.id === poukaz.id);
    assert.equal(Number(poukazPo.zustatek), 0, '17d) zůstatek musí klesnout na 0 jen JEDNOU (ne do minusu)');
    console.log('OK — 17) prodejna + plné vyčerpání poukazu: souběh se stejným klíčem nevrací chybně "už vyčerpaný"');
  }

  // 18) Prodejna — stejný klíč, ale JINÁ cena → 409, původní prodej nedotčen
  {
    const klic = require('crypto').randomUUID();
    const res1 = await adminFetch('/admin/prodejna', { method: 'POST', body: JSON.stringify({ masaz: 'TEST-EET3B konflikt', cena: 300, zpusob_platby: 'hotove', idempotency_klic: klic }) });
    const d1 = await res1.json();
    assert.equal(res1.status, 200, '18a) první požadavek musí uspět');
    uklidProdejny.push(d1.prodej.id);
    const res2 = await adminFetch('/admin/prodejna', { method: 'POST', body: JSON.stringify({ masaz: 'TEST-EET3B konflikt', cena: 999, zpusob_platby: 'hotove', idempotency_klic: klic }) });
    assert.equal(res2.status, 409, '18b) stejný klíč s JINOU cenou musí vrátit 409, ne tiše vrátit starý prodej');
    const pocet = Number((await dotaz('SELECT count(*) FROM prodeje WHERE idempotency_klic = $1', [klic]))[0].count);
    assert.equal(pocet, 1, '18c) musí zůstat jen ten PŮVODNÍ prodej (300 Kč), žádný druhý nevznikl');
    console.log('OK — 18) prodejna: znovu použitý klíč s jinými parametry vrací 409, ne cizí/špatný výsledek');
  }

  // 19) Produkty — stejný klíč, jiné množství → 409
  {
    const resProdukt = await adminFetch('/admin/produkty', { method: 'POST', body: JSON.stringify({ skupina: 'TEST-EET3B', varianta: 'konflikt (smazat)', cena: 99, sklad: 50 }) });
    const produkt = (await resProdukt.json()).produkt;
    uklidProdukty.push(produkt.id);
    const klic = require('crypto').randomUUID();
    const res1 = await adminFetch(`/admin/produkty/${produkt.id}/prodat`, { method: 'POST', body: JSON.stringify({ mnozstvi: 1, zpusob_platby: 'hotove', idempotency_klic: klic }) });
    assert.equal(res1.status, 200, '19a) první požadavek musí uspět');
    const res2 = await adminFetch(`/admin/produkty/${produkt.id}/prodat`, { method: 'POST', body: JSON.stringify({ mnozstvi: 2, zpusob_platby: 'hotove', idempotency_klic: klic }) });
    assert.equal(res2.status, 409, '19b) stejný klíč s JINÝM množstvím musí vrátit 409');
    const sklad = (await adminFetch('/admin/produkty').then(r => r.json())).find(p => p.id === produkt.id).sklad;
    assert.equal(sklad, 49, '19c) sklad se musí snížit jen o původní 1 ks, ne o 1+2');
    console.log('OK — 19) produkty: znovu použitý klíč s jiným množstvím vrací 409');
  }

  // 20) Produkty — sekvenční retry PO "výpadku spojení" (ne souběh)
  {
    const resProdukt = await adminFetch('/admin/produkty', { method: 'POST', body: JSON.stringify({ skupina: 'TEST-EET3B', varianta: 'retry (smazat)', cena: 50, sklad: 10 }) });
    const produkt = (await resProdukt.json()).produkt;
    uklidProdukty.push(produkt.id);
    const klic = require('crypto').randomUUID();
    const telo = JSON.stringify({ mnozstvi: 3, zpusob_platby: 'kartou', idempotency_klic: klic });
    const res1 = await adminFetch(`/admin/produkty/${produkt.id}/prodat`, { method: 'POST', body: telo });
    assert.equal(res1.status, 200, '20a) první požadavek musí uspět');
    const res2 = await adminFetch(`/admin/produkty/${produkt.id}/prodat`, { method: 'POST', body: telo });
    const d2 = await res2.json();
    assert.equal(res2.status, 200, '20b) retry po výpadku musí uspět idempotentně');
    assert.equal(d2.idempotentni, true, '20c) musí se poznat jako idempotentní replay');
    const sklad = (await adminFetch('/admin/produkty').then(r => r.json())).find(p => p.id === produkt.id).sklad;
    assert.equal(sklad, 7, '20d) sklad se musí snížit jen o 3 ks, ne o 6');
    console.log('OK — 20) produkty: sekvenční retry po výpadku spojení nezdvojí prodej');
  }

  // 21) Poukaz vydání — sekvenční retry PO "výpadku spojení"
  let poukazRetryId;
  {
    const klic = require('crypto').randomUUID();
    const telo = JSON.stringify({ poukaz_typ_id: poukazTypId, kupujici_jmeno: 'TEST-EET3B Retry (smazat)', zaplaceno: true, zpusob_platby: 'hotove', idempotency_klic: klic });
    const res1 = await adminFetch('/admin/poukazy', { method: 'POST', body: telo });
    const d1 = await res1.json();
    assert.equal(res1.status, 200, '21a) první požadavek musí uspět');
    poukazRetryId = d1.poukaz.id;
    uklidPoukazy.push(poukazRetryId);
    const res2 = await adminFetch('/admin/poukazy', { method: 'POST', body: telo });
    const d2 = await res2.json();
    assert.equal(res2.status, 200, '21b) retry po výpadku musí uspět idempotentně');
    assert.equal(d2.idempotentni, true, '21c) musí se poznat jako idempotentní replay');
    assert.equal(d2.poukaz.id, poukazRetryId, '21d) musí vrátit TENTÝŽ poukaz, ne nový');
    const pocet = Number((await dotaz('SELECT count(*) FROM poukazy WHERE idempotency_klic = $1', [klic]))[0].count);
    assert.equal(pocet, 1, '21e) v databázi musí existovat jen JEDEN poukaz s tímto klíčem');
    console.log('OK — 21) vydání poukazu: sekvenční retry po výpadku spojení nezdvojí poukaz');
  }

  // 22) Poukaz vydání — stejný klíč, JINÉ kupující jméno → 409
  {
    const klic = require('crypto').randomUUID();
    const res1 = await adminFetch('/admin/poukazy', { method: 'POST', body: JSON.stringify({ poukaz_typ_id: poukazTypId, kupujici_jmeno: 'TEST-EET3B Puvodni (smazat)', zaplaceno: false, idempotency_klic: klic }) });
    const d1 = await res1.json();
    assert.equal(res1.status, 200, '22a) první požadavek musí uspět');
    uklidPoukazy.push(d1.poukaz.id);
    const res2 = await adminFetch('/admin/poukazy', { method: 'POST', body: JSON.stringify({ poukaz_typ_id: poukazTypId, kupujici_jmeno: 'TEST-EET3B JINE JMENO (smazat)', zaplaceno: false, idempotency_klic: klic }) });
    assert.equal(res2.status, 409, '22b) stejný klíč s jiným kupujícím jménem musí vrátit 409');
    const pocet = Number((await dotaz('SELECT count(*) FROM poukazy WHERE idempotency_klic = $1', [klic]))[0].count);
    assert.equal(pocet, 1, '22c) musí zůstat jen PŮVODNÍ poukaz');
    console.log('OK — 22) vydání poukazu: znovu použitý klíč s jiným jménem vrací 409');
  }

  // 23) Poukaz vydání — SKUTEČNÝ souběh dvou požadavků se stejným klíčem
  {
    const klic = require('crypto').randomUUID();
    const telo = JSON.stringify({ poukaz_typ_id: poukazTypId, kupujici_jmeno: 'TEST-EET3B Soubeh (smazat)', zaplaceno: true, zpusob_platby: 'qr', idempotency_klic: klic });
    const [r1, r2] = await Promise.all([
      adminFetch('/admin/poukazy', { method: 'POST', body: telo }),
      adminFetch('/admin/poukazy', { method: 'POST', body: telo })
    ]);
    const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
    assert.equal(r1.status, 200, '23a) první souběžný požadavek musí uspět: ' + JSON.stringify(d1));
    assert.equal(r2.status, 200, '23b) druhý souběžný požadavek musí uspět idempotentně: ' + JSON.stringify(d2));
    assert.equal(d1.poukaz.id, d2.poukaz.id, '23c) oba musí vrátit tentýž poukaz');
    uklidPoukazy.push(d1.poukaz.id);
    const pocet = Number((await dotaz('SELECT count(*) FROM poukazy WHERE idempotency_klic = $1', [klic]))[0].count);
    assert.equal(pocet, 1, '23d) v databázi musí existovat jen JEDEN poukaz, i při skutečném souběhu');
    console.log('OK — 23) vydání poukazu: skutečný souběh dvou požadavků se stejným klíčem vytvoří jen jeden poukaz');
  }

  // 24) Rollback nezanechává "mrtvý" klíč — neúspěšný pokus (neplatný typ)
  //     se stejným klíčem nesmí zablokovat NÁSLEDNÝ platný požadavek.
  {
    const klic = require('crypto').randomUUID();
    const resNeplatny = await adminFetch('/admin/poukazy', { method: 'POST', body: JSON.stringify({ poukaz_typ_id: 999999999, kupujici_jmeno: 'TEST-EET3B Rollback (smazat)', idempotency_klic: klic }) });
    assert.equal(resNeplatny.status, 404, '24a) neplatný poukaz_typ_id musí vrátit 404');
    const pocetPoChybe = Number((await dotaz('SELECT count(*) FROM poukazy WHERE idempotency_klic = $1', [klic]))[0].count);
    assert.equal(pocetPoChybe, 0, '24b) po ROLLBACKu nesmí zůstat žádný řádek s tímto klíčem');
    const resPlatny = await adminFetch('/admin/poukazy', { method: 'POST', body: JSON.stringify({ poukaz_typ_id: poukazTypId, kupujici_jmeno: 'TEST-EET3B Rollback (smazat)', idempotency_klic: klic }) });
    const dataPlatny = await resPlatny.json();
    assert.equal(resPlatny.status, 200, '24c) STEJNÝ klíč musí po neúspěšném pokusu jít znovu použít na platný požadavek: ' + JSON.stringify(dataPlatny));
    uklidPoukazy.push(dataPlatny.poukaz.id);
    console.log('OK — 24) neúspěšný pokus (ROLLBACK) nezanechá klíč "mrtvý" — stejný klíč lze použít znovu');
  }

  console.log('\n✅ VŠECHNY TESTY KROKU 3b PROŠLY');
}

(async () => {
  c = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  // Zapnutí evidence je OHRANIČENÉ jen na dobu běhu tohohle souboru — původní
  // hodnotu si uložíme a na konci vrátíme zpět. Jinak by tenhle test nechal
  // "eet_evidence_zapnuta" globálně zapnuté i pro ZBYTEK regresní sady, a
  // VŠECHNY ostatní testovací soubory (co běžně vytvářejí rezervace/platby/
  // poukazy, aniž by o EET vůbec věděly) by tím nevědomky plnily EET frontu
  // — přesně tohle se stalo a rozbilo to eet-krok3a.test.js scénář 4b
  // (přetížená fronta). Viz audit bodu 5/7 ve zprávě k Kroku 3b.
  const { rows: [puvodniCfg] } = await c.query(`SELECT hodnota FROM nastaveni WHERE klic = 'eet_evidence_zapnuta'`);
  const puvodniHodnota = puvodniCfg ? puvodniCfg.hodnota : 'false';
  await c.query(`UPDATE nastaveni SET hodnota = 'true' WHERE klic = 'eet_evidence_zapnuta'`);
  try {
    await main();
    process.exitCode = 0;
  } catch (e) {
    console.error('❌ CHYBA TESTU:', e.message);
    process.exitCode = 1;
  } finally {
    await c.query(`UPDATE nastaveni SET hodnota = $1 WHERE klic = 'eet_evidence_zapnuta'`, [puvodniHodnota]).catch(() => {});
    // Úklid přímým SQL (ne přes API) — řádky, co tenhle test evidoval pro
    // EET, jsou teď API záměrně nemazatelné (to je přesně ta ochrana, kterou
    // scénář 13 ověřuje) — stejný princip jako smazatRezervaciNatvrdo, jen
    // navíc pro EET zdroje/evidenci.
    // Každý úklidový příkaz má VLASTNÍ catch — jedna chyba (např. cizí
    // zámek řádku) nesmí shodit zbytek úklidu, jak se dřív mohlo stát s
    // jedním velkým try/catch kolem všeho.
    const bezpecne = async (sql, params, popis) => { try { await c.query(sql, params); } catch (e) { console.error(`(úklid "${popis}" se nepodařil):`, e.message); } };
    if (uklidPoukazy.length) await bezpecne(`DELETE FROM evidovana_trzba_zdroje WHERE zdroj_typ = 'poukaz' AND zdroj_id = ANY($1)`, [uklidPoukazy], 'zdroje poukaz');
    if (uklidPoukazy.length || uklidProdejny.length) await bezpecne(
      `DELETE FROM evidovana_trzba_zdroje WHERE zdroj_typ = 'poukaz_historie' AND zdroj_id IN
         (SELECT id FROM poukazy_historie WHERE poukaz_id = ANY($1) OR prodej_id = ANY($2))`,
      [uklidPoukazy, uklidProdejny], 'zdroje poukaz_historie'
    );
    if (uklidProdejny.length) await bezpecne(`DELETE FROM evidovana_trzba_zdroje WHERE zdroj_typ = 'prodej' AND zdroj_id = ANY($1)`, [uklidProdejny], 'zdroje prodej');
    if (uklidProdukty.length) await bezpecne(
      `DELETE FROM evidovana_trzba_zdroje WHERE zdroj_typ = 'prodej_produktu' AND zdroj_id IN (SELECT id FROM prodeje_produktu WHERE produkt_id = ANY($1))`,
      [uklidProdukty], 'zdroje prodej_produktu'
    );
    if (uklidRezervace.length) await bezpecne(
      `DELETE FROM evidovana_trzba_zdroje WHERE zdroj_typ = 'platba' AND zdroj_id IN (SELECT id FROM platby WHERE rezervace_id = ANY($1))`,
      [uklidRezervace], 'zdroje platba'
    );
    // Jen tržby, co tenhle test SÁM vytvořil (uklidTrzbaId) — nikdy hromadný
    // dotaz na "cokoli bez zdroje", aby se nesáhlo na data jiných testů
    // (např. eet-krok3a.test.js), které mohou mít vlastní, odlišný životní
    // cyklus (a klidně i vlastní eet_odeslani záznamy, co se nikdy nemažou).
    for (const id of uklidTrzbaId) {
      await bezpecne(`DELETE FROM evidovana_trzba WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM eet_odeslani WHERE evidovana_trzba_id = $1)`, [id], 'evidovana_trzba ' + id);
    }
    if (uklidPoukazy.length || uklidProdejny.length) await bezpecne(`DELETE FROM poukazy_historie WHERE poukaz_id = ANY($1) OR prodej_id = ANY($2)`, [uklidPoukazy, uklidProdejny], 'poukazy_historie');
    if (uklidProdejny.length) await bezpecne(`DELETE FROM prodeje WHERE id = ANY($1)`, [uklidProdejny], 'prodeje');
    if (uklidProdukty.length) await bezpecne(`DELETE FROM prodeje_produktu WHERE produkt_id = ANY($1)`, [uklidProdukty], 'prodeje_produktu');
    if (uklidPoukazy.length) await bezpecne(`DELETE FROM poukazy WHERE id = ANY($1)`, [uklidPoukazy], 'poukazy');
    if (uklidProdukty.length) await bezpecne(`DELETE FROM produkty WHERE id = ANY($1)`, [uklidProdukty], 'produkty');
    // Pojistka navíc — řádek s NULOVÝM počtem zdrojů není NIKDY legitimní
    // trvalý stav (eet_zaevidovat_zdroj vždy vytvoří evidovana_trzba a
    // zdroj SPOLEČNĚ) — bezpečné smazat i bez konkrétního id v uklidTrzbaId,
    // narozdíl od hromadného dotazu to NIKDY nesmí smazat řádek, co má
    // eet_odeslani historii (ta se musí zachovat navždy).
    await bezpecne(
      `DELETE FROM evidovana_trzba WHERE id NOT IN (SELECT DISTINCT evidovana_trzba_id FROM evidovana_trzba_zdroje)
         AND NOT EXISTS (SELECT 1 FROM eet_odeslani WHERE eet_odeslani.evidovana_trzba_id = evidovana_trzba.id)`,
      [], 'osamele evidovane trzby bez zdroje'
    );
    for (const id of uklidRezervace) { await uklidRezervaciSFallbackem(adminFetch, id).catch(() => {}); }
    await c.end();
  }
})();
