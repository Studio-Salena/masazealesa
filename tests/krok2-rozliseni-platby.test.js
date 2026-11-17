// Regresní test: Krok 2 přípravy na EET 2.0 — rozlišení způsobu a charakteru
// platby (kontaktní v salonu vs. na dálku), nezávisle na zpusob_platby.
//
// Cíl testu:
//  1) 'qr' a 'prevodem' nově fungují jako zpusob_platby u rezervací, 'prevodem'
//     nově funguje u poukazů (dřív jen 'qr' s dvojznačným popiskem).
//  2) kontaktni_platba NENÍ tvrdě vyžadovaná na úrovni API (zpětná kompatibilita
//     se starší nasazenou administrací, viz jeKontaktniPlatbaPlatna v server.js)
//     — chybějící/neplatná hodnota se bezpečně uloží jako NULL, nikdy chyba.
//  3) Platná hodnota (true i false) se uloží a je čitelná zpátky, PŘESNĚ jak
//     byla zadaná (false se neztrácí/nezamění za "nezadáno").
//  4) Vratka a čerpání poukazu (zpusob_platby='poukaz') kontaktni_platba
//     nevyžadují (nejde o nový příjem peněz).
//  5) Historické řádky (vzniklé před touto migrací) mají kontaktni_platba
//     IS NULL — ŽÁDNÝ automatický dopočet/backfill.
//  6) Částečné/kombinované platby: každý řádek si nese svou vlastní správnou
//     dvojici zpusob_platby/kontaktni_platba, součet uhrazeno sedí.
//  7) 'prevodem' se správně počítá do přijatých plateb v účetnictví (není
//     vyloučené jako 'poukaz').
//  8) STATICKY: admin.html (nová administrace) skutečně POSÍLÁ kontaktni_platba
//     u každé nové přijaté platby (rezervace, dokončení masáže, poukaz vydání/
//     potvrzení/historická platba) i u skutečné vratky — a převádí volbu
//     selectu na SKUTEČNÝ boolean (true/false), ne na syrový řetězec 'ano'/'ne'
//     (to by server s přísnou kontrolou typu zahodil jako neplatné -> NULL).
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=http://localhost:3001/api DATABASE_URL=... node tests/krok2-rozliseni-platby.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ziskatTestApiBase, ziskatTestDatabaseUrl } = require('./env-guard');
const { uklidRezervaciSFallbackem } = require('./test-helpers');
const API = ziskatTestApiBase();
const DB_URL = ziskatTestDatabaseUrl();
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

const uklidRezervace = [];
const uklidKlientky = new Set();
const uklidPoukazy = [];
const uklidProdejny = [];

async function vycerpatPoukazCele(poukazKod, cena) {
  const res = await adminFetch('/admin/prodejna', {
    method: 'POST', body: JSON.stringify({ masaz: 'TEST-KROK2-UKLID-POUKAZU', cena, poukaz_kod: poukazKod })
  });
  const data = await res.json().catch(() => ({}));
  assert.equal(res.status, 200, 'úklidové vyčerpání testovacího poukazu musí uspět: ' + JSON.stringify(data));
  if (data.prodej && data.prodej.id) uklidProdejny.push(data.prodej.id);
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

let telefonCitac = 0;
async function vytvorRezervaci(cenikId, sufix) {
  telefonCitac++;
  const { datum, cas } = await novyVolnyTermin(cenikId, 1500 + telefonCitac * 3);
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: cas, jmeno: 'TEST-KROK2-PLATBY ' + sufix + ' (smazat)', telefon: '00008' + telefonCitac, email: 'test-krok2-platby@example.cz' })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'vytvoření testovací rezervace musí uspět: ' + JSON.stringify(data));
  uklidRezervace.push(data.rezervace.id);
  if (data.rezervace.klientka_id) uklidKlientky.add(data.rezervace.klientka_id);
  return data.rezervace;
}

async function posledniPlatba(rezervaceId) {
  const radky = await adminFetch(`/admin/rezervace/${rezervaceId}/platby`).then(r => r.json());
  return radky[radky.length - 1];
}

async function main() {
  console.log('--- Krok 2 EET: rozlišení způsobu a charakteru platby ---');

  const cenikRes = await adminFetch('/admin/cenik').then(r => r.json());
  const polozka = cenikRes.find(p => Number(p.cena) > 0 && p.rezervovatelna !== false);
  assert.ok(polozka, 'ceník musí mít aspoň jednu rezervovatelnou položku s cenou > 0');

  // 0) Historické řádky — kontaktni_platba musí být NULL, žádný backfill.
  // Zachytí se PŘED jakýmkoli zápisem z tohoto testu, ať se omylem nechytí
  // vlastní čerstvě vytvořená data.
  let historickaPlatbaId = null, historickyPoukazId = null;
  {
    const { Client } = require('pg');
    const c = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await c.connect();
    try {
      const { rows: [p] } = await c.query("SELECT id, kontaktni_platba FROM platby ORDER BY vytvoreno ASC LIMIT 1");
      const { rows: [pk] } = await c.query("SELECT id, kontaktni_platba FROM poukazy WHERE stav_uhrady = 'zaplaceno' ORDER BY vytvoreno ASC LIMIT 1");
      if (p) { historickaPlatbaId = p.id; assert.equal(p.kontaktni_platba, null, '0a) historicky nejstarší řádek platby musí mít kontaktni_platba NULL (žádný backfill): id ' + p.id); }
      if (pk) { historickyPoukazId = pk.id; assert.equal(pk.kontaktni_platba, null, '0b) historicky nejstarší zaplacený poukaz musí mít kontaktni_platba NULL (žádný backfill): id ' + pk.id); }
    } finally {
      await c.end();
    }
  }
  console.log('OK — 0) historické řádky (platby i poukazy) mají kontaktni_platba NULL, žádný backfill' + (historickaPlatbaId ? ` (ověřeno na platby.id=${historickaPlatbaId})` : ' (žádný starý řádek k ověření, DB je prázdná)'));

  // 1) Rezervace — platba: qr a prevodem nově fungují; kontaktni_platba NENÍ
  // tvrdě vyžadovaná na úrovni API (zpětná kompatibilita se starší
  // nasazenou administrací během postupného nasazení — viz jeKontaktniPlatbaPlatna
  // v server.js), chybějící/neplatná hodnota se tiše uloží jako NULL.
  {
    const r = await vytvorRezervaci(polozka.id, '1');
    const resChybejiciKontakt = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: 1, zpusob_platby: 'qr' })
    });
    assert.equal(resChybejiciKontakt.status, 200, '1a) chybějící kontaktni_platba u skutečné platby NESMÍ být odmítnuta (zpětná kompatibilita se starší administrací)');
    const platba1a = await posledniPlatba(r.id);
    assert.equal(platba1a.kontaktni_platba, null, '1a) chybějící kontaktni_platba se uloží jako NULL');

    const resNeplatnyKontakt = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: 1, zpusob_platby: 'qr', kontaktni_platba: 'ano' })
    });
    assert.equal(resNeplatnyKontakt.status, 200, '1b) nebooleovská hodnota kontaktni_platba se tiše ignoruje, požadavek dál uspěje');
    const platba1b = await posledniPlatba(r.id);
    assert.equal(platba1b.kontaktni_platba, null, '1b) nebooleovská hodnota kontaktni_platba se uloží jako NULL, ne jako zadaný řetězec');

    const resQr = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: 1, zpusob_platby: 'qr', kontaktni_platba: true })
    });
    assert.equal(resQr.status, 200, '1c) qr + kontaktni_platba=true u rezervace musí uspět: ' + JSON.stringify(await resQr.json().catch(() => ({}))));

    const r2 = await vytvorRezervaci(polozka.id, '1-prevodem');
    const resPrevodem = await adminFetch(`/admin/rezervace/${r2.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: 1, zpusob_platby: 'prevodem', kontaktni_platba: false })
    });
    assert.equal(resPrevodem.status, 200, '1d) prevodem + kontaktni_platba=false u rezervace musí uspět');
    const platba2 = await posledniPlatba(r2.id);
    assert.equal(platba2.zpusob_platby, 'prevodem', '1e) uložená metoda musí být přesně prevodem');
    assert.equal(platba2.kontaktni_platba, false, '1e) uložená kontaktni_platba musí být přesně false');
    console.log('OK — 1) rezervace/platba: qr i prevodem fungují; chybějící/neplatná kontaktni_platba se bezpečně uloží jako NULL (zpětná kompatibilita), platná hodnota se uloží přesně');
  }

  // 2) Rezervace — vratka: kontaktni_platba se NEVYŽADUJE (není nový příjem)
  {
    const r = await vytvorRezervaci(polozka.id, '2');
    const resPlatba = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: 200, zpusob_platby: 'hotove', kontaktni_platba: true })
    });
    assert.equal(resPlatba.status, 200, '2) příprava platby pro vratku musí uspět');

    const resVratka = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: 200, zpusob_platby: 'hotove', typ: 'vratka' })
    });
    assert.equal(resVratka.status, 200, '2a) vratka BEZ kontaktni_platba musí uspět (není vyžadovaná): ' + JSON.stringify(await resVratka.json().catch(() => ({}))));
    const vratkaRadek = await posledniPlatba(r.id);
    assert.equal(vratkaRadek.kontaktni_platba, null, '2b) vratka bez zadané kontaktni_platba se uloží jako NULL');

    // 2c) skutečná vratka SE zadanou kontaktni_platba (nová administrace u
    // skutečné vratky peněz) — false se nesmí ztratit/zaměnit za "nezadáno".
    const r2 = await vytvorRezervaci(polozka.id, '2-prevodem');
    await adminFetch(`/admin/rezervace/${r2.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: 300, zpusob_platby: 'hotove', kontaktni_platba: true })
    });
    const resVratkaPrevodem = await adminFetch(`/admin/rezervace/${r2.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: 300, zpusob_platby: 'prevodem', typ: 'vratka', kontaktni_platba: false })
    });
    assert.equal(resVratkaPrevodem.status, 200, '2c) skutečná vratka převodem s kontaktni_platba=false musí uspět');
    const vratkaPrevodemRadek = await posledniPlatba(r2.id);
    assert.equal(vratkaPrevodemRadek.zpusob_platby, 'prevodem', '2c) uložená metoda vratky musí být přesně prevodem');
    assert.equal(vratkaPrevodemRadek.kontaktni_platba, false, '2c) uložená kontaktni_platba=false u skutečné vratky se NESMÍ ztratit ani zaměnit za NULL');
    console.log('OK — 2) rezervace/vratka: kontaktni_platba se nevyžaduje (uloží se NULL, pokud není zadaná), ale pokud zadaná je (i false), uloží se přesně');
  }

  // 3) Rezervace — vratka "jako poukaz" (zpusob_platby='poukaz'): kontaktni_platba se také nevyžaduje
  {
    const r = await vytvorRezervaci(polozka.id, '3');
    await adminFetch(`/admin/rezervace/${r.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: 150, zpusob_platby: 'hotove', kontaktni_platba: true })
    });
    const resVratkaPoukaz = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: 150, zpusob_platby: 'poukaz', typ: 'vratka' })
    });
    const dataVratkaPoukaz = await resVratkaPoukaz.json();
    assert.equal(resVratkaPoukaz.status, 200, '3) vratka jako poukaz BEZ kontaktni_platba musí uspět: ' + JSON.stringify(dataVratkaPoukaz));
    assert.ok(dataVratkaPoukaz.poukaz && dataVratkaPoukaz.poukaz.id, '3) vratka jako poukaz musí vytvořit nový poukaz');
    uklidPoukazy.push(dataVratkaPoukaz.poukaz.id);
    console.log('OK — 3) rezervace/vratka jako poukaz: kontaktni_platba se nevyžaduje');
  }

  // 4) Poukaz — vydání (zaplaceno=true): prevodem funguje; kontaktni_platba
  // NENÍ tvrdě vyžadovaná (zpětná kompatibilita, viz bod 1 výš)
  {
    const resChybejici = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-KROK2 (smazat)', zaplaceno: true, zpusob_platby: 'prevodem' })
    });
    const dataChybejici = await resChybejici.json();
    assert.equal(resChybejici.status, 200, '4a) chybějící kontaktni_platba u vydání rovnou zaplaceného poukazu NESMÍ být odmítnuta: ' + JSON.stringify(dataChybejici));
    assert.equal(dataChybejici.poukaz.kontaktni_platba, null, '4a) chybějící kontaktni_platba se uloží jako NULL');
    uklidPoukazy.push(dataChybejici.poukaz.id);
    await vycerpatPoukazCele(dataChybejici.poukaz.kod, Number(polozka.cena));

    const resOk = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-KROK2-PREVODEM (smazat)', zaplaceno: true, zpusob_platby: 'prevodem', kontaktni_platba: false })
    });
    const dataOk = await resOk.json();
    assert.equal(resOk.status, 200, '4b) prevodem + kontaktni_platba=false u vydání poukazu musí uspět: ' + JSON.stringify(dataOk));
    assert.equal(dataOk.poukaz.zpusob_platby, 'prevodem', '4c) uložená metoda musí být přesně prevodem');
    assert.equal(dataOk.poukaz.kontaktni_platba, false, '4c) uložená kontaktni_platba musí být přesně false');
    uklidPoukazy.push(dataOk.poukaz.id);
    await vycerpatPoukazCele(dataOk.poukaz.kod, Number(polozka.cena));
    console.log('OK — 4) poukazy (vydání): prevodem funguje; chybějící kontaktni_platba se bezpečně uloží jako NULL, platná hodnota se uloží přesně');
  }

  // 5) Poukaz — potvrdit-platbu: kontaktni_platba NENÍ tvrdě vyžadovaná
  {
    const nezaplaceny = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-KROK2-NEZAPLACENO (smazat)', zaplaceno: false })
    }).then(r => r.json());
    uklidPoukazy.push(nezaplaceny.poukaz.id);

    const resChybejici = await adminFetch(`/admin/poukazy/${nezaplaceny.poukaz.id}/potvrdit-platbu`, {
      method: 'PATCH', body: JSON.stringify({ zpusob_platby: 'qr' })
    });
    const dataChybejici = await resChybejici.json();
    assert.equal(resChybejici.status, 200, '5a) chybějící kontaktni_platba u potvrzení platby poukazu NESMÍ být odmítnuta (stejná admin.html, jako by to dřív poslala starší verze): ' + JSON.stringify(dataChybejici));
    assert.equal(dataChybejici.poukaz.kontaktni_platba, null, '5a) chybějící kontaktni_platba se uloží jako NULL');
    await vycerpatPoukazCele(nezaplaceny.poukaz.kod, Number(polozka.cena));

    const nezaplaceny2 = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-KROK2-NEZAPLACENO-2 (smazat)', zaplaceno: false })
    }).then(r => r.json());
    uklidPoukazy.push(nezaplaceny2.poukaz.id);
    const resOk = await adminFetch(`/admin/poukazy/${nezaplaceny2.poukaz.id}/potvrdit-platbu`, {
      method: 'PATCH', body: JSON.stringify({ zpusob_platby: 'qr', kontaktni_platba: true })
    });
    const dataOk = await resOk.json();
    assert.equal(resOk.status, 200, '5b) qr + kontaktni_platba=true musí uspět: ' + JSON.stringify(dataOk));
    assert.equal(dataOk.poukaz.kontaktni_platba, true, '5c) uložená kontaktni_platba musí být přesně true');
    await vycerpatPoukazCele(nezaplaceny2.poukaz.kod, Number(polozka.cena));
    console.log('OK — 5) poukazy/potvrdit-platbu: chybějící kontaktni_platba se bezpečně uloží jako NULL, platná hodnota se uloží přesně');
  }

  // 6) Poukaz — doplnit-historickou-platbu: kontaktni_platba NENÍ tvrdě
  //    vyžadovaná ani tady (jde o nový ZÁPIS reálné platby, jen s datem v
  //    minulosti — ne o starý řádek, kterého se týká bod 0 výš, ale ze
  //    stejného důvodu zpětné kompatibility se nevynucuje)
  {
    const nezaplaceny = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-KROK2-HISTORICKA (smazat)', zaplaceno: false })
    }).then(r => r.json());
    uklidPoukazy.push(nezaplaceny.poukaz.id);

    // tenhle konkrétní poukaz má stav_uhrady='nezaplaceno' (ne NULL), takže
    // endpoint ho stejně odmítne (400) — ale z JINÉHO důvodu (stav), ne kvůli
    // kontaktni_platba. Ověřujeme tedy jen to, že chybějící kontaktni_platba
    // samo o sobě 400 NEZPŮSOBÍ (viz chybová hláška).
    const resChybejici = await adminFetch(`/admin/poukazy/${nezaplaceny.poukaz.id}/doplnit-historickou-platbu`, {
      method: 'PATCH', body: JSON.stringify({ zpusob_platby: 'prevodem', zaplaceno_kdy: '2026-01-01' })
    });
    const dataChybejici = await resChybejici.json();
    assert.equal(resChybejici.status, 400, '6) tenhle poukaz má stav_uhrady=nezaplaceno, endpoint ho odmítne (400), ale...');
    assert.doesNotMatch(dataChybejici.chyba || '', /kontaktni_platba|osobně v salonu/, '6) ...důvod odmítnutí NESMÍ být kontaktni_platba (zpětná kompatibilita): ' + JSON.stringify(dataChybejici));
    console.log('OK — 6) poukazy/doplnit-historickou-platbu: kontaktni_platba se nevynucuje (chyba 400 u tohoto poukazu je jen kvůli jeho stavu, ne kvůli kontaktni_platba)');
  }

  // 7) Kombinovaná platba: záloha prevodem (na dálku) + doplatek hotove (v salonu)
  {
    const r = await vytvorRezervaci(polozka.id, '7');
    const cena = Number(polozka.cena);
    assert.ok(cena >= 2, 'ceníková položka musí mít cenu alespoň 2 Kč pro rozdělení na zálohu+doplatek');
    const zaloha = Math.max(1, Math.floor(cena / 2));
    const doplatek = cena - zaloha;

    const resZaloha = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: zaloha, zpusob_platby: 'prevodem', kontaktni_platba: false })
    });
    assert.equal(resZaloha.status, 200, '7a) záloha prevodem musí uspět');

    if (doplatek > 0) {
      const resDoplatek = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
        method: 'PATCH', body: JSON.stringify({ castka: doplatek, zpusob_platby: 'hotove', kontaktni_platba: true })
      });
      const dataDoplatek = await resDoplatek.json();
      assert.equal(resDoplatek.status, 200, '7b) doplatek hotove musí uspět: ' + JSON.stringify(dataDoplatek));
      assert.equal(Number(dataDoplatek.rezervace.uhrazeno), cena, '7c) součet zálohy a doplatku musí přesně sedět na cenu');
    }

    const radky = await adminFetch(`/admin/rezervace/${r.id}/platby`).then(x => x.json());
    const radekZaloha = radky.find(x => x.zpusob_platby === 'prevodem');
    assert.ok(radekZaloha, '7d) řádek zálohy prevodem musí v deníku existovat');
    assert.equal(radekZaloha.kontaktni_platba, false, '7e) řádek zálohy si musí zachovat svou vlastní kontaktni_platba=false');
    if (doplatek > 0) {
      const radekDoplatek = radky.find(x => x.zpusob_platby === 'hotove');
      assert.ok(radekDoplatek, '7f) řádek doplatku hotove musí v deníku existovat');
      assert.equal(radekDoplatek.kontaktni_platba, true, '7g) řádek doplatku si musí zachovat svou vlastní kontaktni_platba=true');
    }
    console.log('OK — 7) kombinovaná platba (záloha prevodem na dálku + doplatek hotove v salonu): každý řádek má svou vlastní správnou dvojici metoda/kontakt');
  }

  // 8) Účetnictví: platba prevodem se počítá do přijatých plateb (není vyloučená jako poukaz)
  {
    const dnes = new Date().toISOString().slice(0, 10);
    const pred = await adminFetch(`/admin/ucetnictvi?od=${dnes}&do=${dnes}`).then(x => x.json());
    const r = await vytvorRezervaci(polozka.id, '8');
    const castka = 37; // nenápadná, snadno dohledatelná částka
    const res = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka, zpusob_platby: 'prevodem', kontaktni_platba: false })
    });
    assert.equal(res.status, 200, '8) platba prevodem pro účetní kontrolu musí uspět');
    const po = await adminFetch(`/admin/ucetnictvi?od=${dnes}&do=${dnes}`).then(x => x.json());
    const rozdil = Number(po.prijatePlatby.celkem) - Number(pred.prijatePlatby.celkem);
    assert.equal(rozdil, castka, '8) přijatá platba prevodem (' + castka + ' Kč) se musí objevit v součtu přijatých plateb v účetnictví, nesmí být vyloučená jako poukaz (rozdíl byl ' + rozdil + ' Kč)');
    console.log('OK — 8) účetnictví: platba prevodem se správně počítá do přijatých plateb');
  }

  // 9) STATICKY: admin.html skutečně POSÍLÁ kontaktni_platba (jako skutečný
  // boolean, ne syrový řetězec) u každé nové přijaté platby i u skutečné
  // vratky — čtena je PŘÍMO skutečná administrace, ne kopie/reimplementace
  // (stejný princip jako escapeHtml v xss.test.js).
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
    function extrahovatFunkci(nazev) {
      const regex = new RegExp('(?:async\\s+)?function\\s+' + nazev + '\\s*\\([^)]*\\)\\s*\\{');
      const m = regex.exec(html);
      assert.ok(m, `Funkce ${nazev} nebyla v admin.html nalezena — regrese!`);
      let i = m.index + m[0].length, hloubka = 1;
      while (hloubka > 0 && i < html.length) {
        if (html[i] === '{') hloubka++;
        else if (html[i] === '}') hloubka--;
        i++;
      }
      return html.slice(m.index, i);
    }

    // a) Zaznamenat platbu k rezervaci
    const fZaznamenat = extrahovatFunkci('zaznamenatPlatbu');
    assert.match(fZaznamenat, /kontaktni_platba\s*=\s*document\.getElementById\('platbaKontaktni'\)\.value\s*===\s*'ano'/, '9a) zaznamenatPlatbu musí převést volbu selectu na skutečný boolean (true/false), ne syrový řetězec');
    assert.match(fZaznamenat, /JSON\.stringify\(\{[^}]*kontaktni_platba[^}]*\}\)/, '9a) zaznamenatPlatbu musí kontaktni_platba skutečně poslat v těle požadavku');

    // b) Dokončit masáž (se zápisem platby)
    const fDokoncit = extrahovatFunkci('dokoncitMasazOdeslat');
    assert.match(fDokoncit, /kontaktni_platba\s*=\s*document\.getElementById\('dmKontaktni'\)\.value\s*===\s*'ano'/, '9b) dokoncitMasazOdeslat musí převést volbu selectu na skutečný boolean');
    assert.match(fDokoncit, /JSON\.stringify\(\{[^}]*kontaktni_platba[^}]*\}\)/, '9b) dokoncitMasazOdeslat musí kontaktni_platba skutečně poslat v těle požadavku');

    // c) Vydat poukaz (zaplaceno hned)
    const fVydat = extrahovatFunkci('vydatPoukaz');
    assert.match(fVydat, /kontaktni_platba\s*=\s*document\.getElementById\('npKontaktni'\)\.value\s*===\s*'ano'/, '9c) vydatPoukaz musí převést volbu selectu na skutečný boolean');
    assert.match(fVydat, /body\.kontaktni_platba/, '9c) vydatPoukaz musí kontaktni_platba skutečně přidat do těla požadavku');

    // d) Potvrdit platbu poukazu / doplnit historickou platbu (sdílený formulář)
    const fPotvrdit = extrahovatFunkci('potvrditPlatbuPoukazuOdeslat');
    assert.match(fPotvrdit, /kontaktni_platba\s*=\s*document\.getElementById\('ppKontaktni'\)\.value\s*===\s*'ano'/, '9d) potvrditPlatbuPoukazuOdeslat musí převést volbu selectu na skutečný boolean');
    assert.match(fPotvrdit, /const body\s*=\s*\{[^}]*kontaktni_platba[^}]*\}/, '9d) potvrditPlatbuPoukazuOdeslat musí kontaktni_platba skutečně poslat v těle požadavku');

    // e) Vrátit platbu klientce — skutečná vratka (ne "jako poukaz")
    const fVratit = extrahovatFunkci('vratitPlatbu');
    assert.match(fVratit, /kontaktni_platba\s*=\s*zpusob_platby\s*===\s*'poukaz'\s*\?\s*undefined\s*:\s*document\.getElementById\('vratkaKontaktni'\)\.value\s*===\s*'ano'/, "9e) vratitPlatbu musí u skutečné vratky převést volbu selectu na skutečný boolean, a u vratky „jako poukaz“ ho vůbec neposílat");
    assert.match(fVratit, /JSON\.stringify\(\{[^}]*kontaktni_platba[^}]*\}\)/, '9e) vratitPlatbu musí kontaktni_platba skutečně poslat v těle požadavku');

    console.log('OK — 9) staticky ověřeno: admin.html posílá kontaktni_platba jako skutečný boolean u platby, dokončení masáže, poukazu (vydání/potvrzení/historická platba) i u skutečné vratky; u vratky „jako poukaz“ se neposílá vůbec');
  }

  console.log('\n✅ VŠECHNY TESTY KROKU 2 (EET — rozlišení způsobu a charakteru platby) PROŠLY');
}

main()
  .catch(e => { console.error('❌ CHYBA TESTU:', e.message); process.exitCode = 1; })
  .finally(async () => {
    for (const id of uklidRezervace) {
      await uklidRezervaciSFallbackem(adminFetch, id).catch(e => console.error('Úklid rezervace selhal:', id, e.message));
    }
    for (const id of uklidKlientky) {
      await adminFetch(`/admin/klientky/${id}`, { method: 'DELETE' }).catch(() => null);
    }
    if (uklidProdejny.length || uklidPoukazy.length) {
      const { Client } = require('pg');
      const c = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
      await c.connect();
      try {
        if (uklidProdejny.length) await c.query('DELETE FROM prodeje WHERE id = ANY($1)', [uklidProdejny]);
        if (uklidPoukazy.length) await c.query('DELETE FROM poukazy WHERE id = ANY($1)', [uklidPoukazy]);
      } catch (e) {
        console.error('Přímý SQL úklid prodejů/poukazů selhal:', e.message);
      } finally {
        await c.end();
      }
    }
  });
