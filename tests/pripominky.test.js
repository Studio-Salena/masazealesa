// Testy Fáze 5B — robustní automatické připomínky rezervací.
//
// DŮLEŽITÉ OMEZENÍ (bezpečnost): tenhle soubor NIKDY nevolá
// GET /api/cron/denni se správným CRON_KLIC. Ten klíč tenhle test ani nemá
// (nesdílí se do testovacího prostředí schválně) a i kdyby ho měl, spuštění
// endpointu s platným klíčem proti produkci by mohlo skutečné klientce s
// termínem v okně poslat opravdový e-mail — přesně to zadání zakazuje ("Testy
// musí být provedeny bezpečně tak, aby nedošlo k odeslání skutečných e-mailů
// klientkám"). Proto se tu:
//   - ověřuje jen ODMÍTNUTÍ bez/se špatným klíčem (bezpečné — endpoint vrátí
//     401 dřív, než se cokoliv začne posílat),
//   - logika časového okna a fallback nastavení ověřuje jako čistá JS logika
//     (stejný výpočet jako v server.js, žádná síť/DB),
//   - reset pripomenuto při změně termínu ověřuje přes DB-pozorovatelný stav
//     (odpověď PATCH endpointu) + statickou kontrolou zdrojového kódu, že SQL
//     UPDATE opravdu podmíněně resetuje pripomenuto jen při terminSeMeni.
// Plné end-to-end ověření "úspěšné odeslání nastaví pripomenuto=true" a
// "neúspěšné odeslání ho nechá false a jde to zkusit znovu" proto NENÍ
// otestováno živě proti produkci — je to vědomé bezpečnostní rozhodnutí, viz
// finální report. Testovací e-maily (kde editace posílá zmenaEmailHtml) míří
// na test-...@example.cz stejně jako v tests/uprava-zruseni.test.js.
//
// Spuštění:  ADMIN_HESLO=... node tests/pripominky.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API = process.env.TEST_API_BASE || 'https://masazealesa.onrender.com/api';
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
  for (let i = odpocetDni; i < odpocetDni + 90; i += 3) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const cas = await najitVolnyTermin(iso, cenikId);
    if (cas) return { datum: iso, cas };
  }
  throw new Error('Nenalezen volný termín pro test');
}

// -- Čistá logika okna připomínky, zrcadlí přesně to, co dělá server.js v
//    /api/cron/denni — bez sítě, bez DB, jen kontrola hraničních případů. --
function vOkne(terminIso, predstihHodin, tedIso) {
  const ted = new Date(tedIso);
  const oknoKonec = new Date(ted.getTime() + predstihHodin * 60 * 60 * 1000);
  const terminCas = new Date(terminIso);
  return terminCas > ted && terminCas <= oknoKonec;
}

// -- Čistá logika fallbacku nastavení, zrcadlí ziskatNastaveniPripominek --
function vyhodnotNastaveni(mapa) {
  const zapnuto = mapa.pripominky_zapnuto !== 'false';
  const predstihRaw = parseInt(mapa.pripominka_predstih_hodin, 10);
  const predstihHodin = Number.isFinite(predstihRaw) && predstihRaw >= 1 && predstihRaw <= 168 ? predstihRaw : 24;
  return { zapnuto, predstihHodin };
}

async function main() {
  let rezervaceId = null;
  let klientkaId = null;
  const puvodniNastaveni = {};

  try {
    // ================= 1) ČISTÁ LOGIKA OKNA (bez sítě) =================
    const ted = '2026-10-10T12:00:00';
    assert.equal(vOkne('2026-10-11T11:00:00', 24, ted), true, 'termín za 23h při předstihu 24h musí být v okně');
    assert.equal(vOkne('2026-10-11T12:00:00', 24, ted), true, 'termín přesně na hranici (za 24h) musí být v okně (<=)');
    assert.equal(vOkne('2026-10-11T13:00:00', 24, ted), false, 'termín za 25h při předstihu 24h nesmí být v okně (moc brzo)');
    assert.equal(vOkne('2026-10-10T11:00:00', 24, ted), false, 'termín v minulosti nesmí být v okně');
    assert.equal(vOkne('2026-10-10T12:30:00', 24, ted), true, 'pozdě vytvořená rezervace (za 30 min) musí být v okně, dokud neproběhla');
    assert.equal(vOkne('2026-10-20T12:00:00', 24, ted), false, 'rezervace daleko v budoucnu (10 dní) se nesmí připomenout předčasně ani po výpadku');
    assert.equal(vOkne('2026-10-12T00:00:00', 48, ted), true, 'širší předstih (48h) musí zahrnout i vzdálenější termín');
    console.log('OK — logika časového okna (hranice, pozdní rezervace, vzdálená budoucnost) odpovídá očekávání');

    // ================= 2) FALLBACK NASTAVENÍ (bez sítě) =================
    assert.deepEqual(vyhodnotNastaveni({}), { zapnuto: true, predstihHodin: 24 }, 'chybějící nastavení = výchozí ON, 24h');
    assert.deepEqual(vyhodnotNastaveni({ pripominky_zapnuto: 'false' }), { zapnuto: false, predstihHodin: 24 }, "'false' vypíná připomínky");
    assert.deepEqual(vyhodnotNastaveni({ pripominky_zapnuto: 'true' }), { zapnuto: true, predstihHodin: 24 }, "'true' nechává zapnuto");
    assert.deepEqual(vyhodnotNastaveni({ pripominka_predstih_hodin: '48' }), { zapnuto: true, predstihHodin: 48 }, 'platná hodnota se použije');
    assert.deepEqual(vyhodnotNastaveni({ pripominka_predstih_hodin: '0' }), { zapnuto: true, predstihHodin: 24 }, 'hodnota mimo rozsah (0) spadne na výchozí 24, ne na vypnutí');
    assert.deepEqual(vyhodnotNastaveni({ pripominka_predstih_hodin: '999' }), { zapnuto: true, predstihHodin: 24 }, 'hodnota mimo rozsah (999 > 168) spadne na výchozí 24');
    assert.deepEqual(vyhodnotNastaveni({ pripominka_predstih_hodin: 'abc' }), { zapnuto: true, predstihHodin: 24 }, 'nečíselná hodnota spadne na výchozí 24');
    console.log('OK — fallback nastavení (chybějící/neplatná hodnota nikdy nerozbije připomínky)');

    // ================= 3) STATICKÁ KONTROLA ZDROJOVÉHO KÓDU =================
    const zdroj = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(
      zdroj,
      /terminSeMeni \? ', pripomenuto=false, pripomenuto_pokus_kdy=NULL' : ''/,
      'edit endpoint musí podmíněně resetovat pripomenuto jen při skutečné změně termínu'
    );
    assert.match(
      zdroj,
      /WHERE id = \$1 AND pripomenuto = false\s+AND \(pripomenuto_pokus_kdy IS NULL OR pripomenuto_pokus_kdy < now\(\) - interval '10 minutes'\)/,
      'cron endpoint musí mít atomickou claim podmínku (ne-odeslané NEBO zaseklé > 10 min)'
    );
    assert.match(zdroj, /pripominky\.selhalo\+\+/, 'cron endpoint musí počítat selhání odeslání');
    console.log('OK — zdrojový kód obsahuje očekávaný atomický claim a podmíněný reset (regresní pojistka)');

    // ================= 4) NASTAVENÍ PŘES API (bezpečné, žádný e-mail) =================
    const predNastaveni = await adminFetch('/admin/nastaveni').then(r => r.json());
    puvodniNastaveni.zapnuto = predNastaveni.find(n => n.klic === 'pripominky_zapnuto');
    puvodniNastaveni.predstih = predNastaveni.find(n => n.klic === 'pripominka_predstih_hodin');

    let odp = await adminFetch('/admin/nastaveni/pripominky_zapnuto', { method: 'PUT', body: JSON.stringify({ hodnota: 'false' }) });
    assert.equal(odp.status, 200, 'uložení pripominky_zapnuto=false selhalo');
    let ctecte = await adminFetch('/admin/nastaveni').then(r => r.json());
    assert.equal(ctecte.find(n => n.klic === 'pripominky_zapnuto').hodnota, 'false', 'hodnota se po uložení nenačetla zpět jako false');

    odp = await adminFetch('/admin/nastaveni/pripominka_predstih_hodin', { method: 'PUT', body: JSON.stringify({ hodnota: '48' }) });
    assert.equal(odp.status, 200, 'uložení předstihu selhalo');
    ctecte = await adminFetch('/admin/nastaveni').then(r => r.json());
    assert.equal(ctecte.find(n => n.klic === 'pripominka_predstih_hodin').hodnota, '48', 'předstih se po uložení nenačetl zpět jako 48');
    console.log('OK — ON/OFF a předstih se ukládají a čtou přes /api/admin/nastaveni');

    // Vrátit na výchozí ON / 24h, ať test nenechá produkci ve vypnutém stavu
    await adminFetch('/admin/nastaveni/pripominky_zapnuto', { method: 'PUT', body: JSON.stringify({ hodnota: puvodniNastaveni.zapnuto ? puvodniNastaveni.zapnuto.hodnota : 'true' }) });
    await adminFetch('/admin/nastaveni/pripominka_predstih_hodin', { method: 'PUT', body: JSON.stringify({ hodnota: puvodniNastaveni.predstih ? puvodniNastaveni.predstih.hodnota : '24' }) });
    console.log('OK — nastavení vráceno na původní hodnotu');

    // ================= 5) CRON ENDPOINT — ZABEZPEČENÍ (bezpečné, 401 dřív než cokoliv jiného) =================
    let cronOdp = await fetch(API + '/cron/denni');
    assert.equal(cronOdp.status, 401, 'chybějící klíč musí vrátit 401');
    let cronTelo = await cronOdp.text();
    assert.ok(!/CRON_KLIC|RESEND/i.test(cronTelo), 'odpověď nesmí prozradit jméno proměnné s tajným klíčem');

    cronOdp = await fetch(API + '/cron/denni?klic=spatny-klic-test-12345');
    assert.equal(cronOdp.status, 401, 'špatný klíč musí vrátit 401');
    console.log('OK — /api/cron/denni odmítá chybějící i špatný klíč (401), tělo neprozrazuje klíč');

    // ================= 6) RESET pripomenuto PŘI ZMĚNĚ TERMÍNU (bez cronu) =================
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');

    const prvni = await novyVolnyTermin(polozka.id, 100);
    const vytvorRes = await adminFetch('/admin/rezervace', {
      method: 'POST',
      body: JSON.stringify({ cenik_id: polozka.id, datum: prvni.datum, cas_od: prvni.cas, jmeno: 'TEST-PRIPOMINKY (smazat)', telefon: '0000099', email: 'test-pripominky@example.cz' })
    });
    const vytvor = await vytvorRes.json();
    assert.equal(vytvorRes.status, 200, 'Vytvoření testovací rezervace selhalo: ' + JSON.stringify(vytvor));
    rezervaceId = vytvor.rezervace.id;
    // Od Fáze 6D vytvoření rezervace s telefonem vždy najde/založí klientku —
    // sledujeme klientka_id, ať ji "finally" uklidí stejně jako rezervaci.
    klientkaId = vytvor.rezervace.klientka_id;
    assert.equal(vytvor.rezervace.pripomenuto, false, 'nová rezervace musí mít pripomenuto=false');
    console.log('OK — testovací rezervace vytvořena, pripomenuto=false');

    // 6a) Editace BEZ změny termínu (jen poznámka) — pripomenuto zůstává false (nedotčeno)
    let upravRes = await adminFetch(`/admin/rezervace/${rezervaceId}`, {
      method: 'PATCH',
      body: JSON.stringify({ datum: prvni.datum, cas_od: prvni.cas, cenik_id: polozka.id, jmeno: 'TEST-PRIPOMINKY (smazat)', telefon: '0000099', email: 'test-pripominky@example.cz', poznamka: 'jen poznámka' })
    });
    let uprav = await upravRes.json();
    assert.equal(upravRes.status, 200, 'Editace bez změny termínu selhala: ' + JSON.stringify(uprav));
    assert.equal(uprav.terminZmenen, false, 'terminZmenen musí být false, když se termín nemění');
    assert.equal(uprav.rezervace.pripomenuto, false, 'pripomenuto musí zůstat false po editaci bez změny termínu');
    console.log('OK — editace bez změny termínu nechává pripomenuto beze změny');

    // 6b) Editace SE změnou termínu — terminZmenen=true, pripomenuto zůstává/je false
    const druhy = await novyVolnyTermin(polozka.id, 130);
    upravRes = await adminFetch(`/admin/rezervace/${rezervaceId}`, {
      method: 'PATCH',
      body: JSON.stringify({ datum: druhy.datum, cas_od: druhy.cas, cenik_id: polozka.id, jmeno: 'TEST-PRIPOMINKY (smazat)', telefon: '0000099', email: 'test-pripominky@example.cz', poznamka: 'změna termínu' })
    });
    uprav = await upravRes.json();
    assert.equal(upravRes.status, 200, 'Editace se změnou termínu selhala: ' + JSON.stringify(uprav));
    assert.equal(uprav.terminZmenen, true, 'terminZmenen musí být true, když se termín mění');
    assert.equal(uprav.rezervace.pripomenuto, false, 'pripomenuto musí být (zůstat) false po změně termínu');
    console.log('OK — editace se změnou termínu resetuje/nechává pripomenuto=false (terminZmenen=true potvrzen)');

    console.log('\n✅ VŠECHNY TESTY PŘIPOMÍNEK (Fáze 5B) PROŠLY');
    console.log('ℹ️  Živé odeslání připomínky (úspěch→pripomenuto=true, chyba→zůstává false a jde zkusit znovu,');
    console.log('    souběžné volání→jen jedno odešle) NENÍ ověřeno voláním produkčního cron endpointu se');
    console.log('    správným klíčem — viz komentář v hlavičce souboru a finální report.');
  } finally {
    if (rezervaceId) {
      await adminFetch(`/admin/rezervace/${rezervaceId}`, { method: 'DELETE' });
      console.log('(testovací rezervace smazána)');
    }
    // Klientka se maže AŽ TEĎ, po smazání rezervace — DELETE
    // /api/admin/klientky/:id sám odmítne smazání, dokud má jakoukoli vazbu.
    if (klientkaId) {
      const r = await adminFetch(`/admin/klientky/${klientkaId}`, { method: 'DELETE' }).catch(() => null);
      console.log(r && r.ok ? '(testovací klientka smazána)' : '(testovací klientku se nepodařilo smazat — možná má ještě jinou vazbu)');
    }
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
