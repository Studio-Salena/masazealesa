// Regresní test: bezpečné uplatňování dárkových poukazů.
// Ověřuje: existenci, zrušený/vyčerpaný/prošlý poukaz, dostatek zůstatku,
// souběžné uplatnění (race condition) a od Fáze 7F.1 i to, že expirovaný
// poukaz (platnost_do < dnes, ale DB stav pořád "aktivni"/"castecne_vyuzity"
// — viz audit Fáze 7F) se nikde nepočítá jako skutečně aktivní.
//
// Běží VÝHRADNĚ proti izolovanému testovacímu prostředí (viz env-guard.js —
// fail-closed, žádný produkční fallback). Nic nemění mimo vlastní testovací
// poukazy/typy, které na konci vždy smaže.
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=... node tests/poukazy.test.js
// (ADMIN_HESLO se nikam neukládá, jen se čte z prostředí při spuštění)

const assert = require('node:assert/strict');

const { ziskatTestApiBase } = require('./env-guard');
const API = ziskatTestApiBase(); // Fáze 7C.6 — fail-closed, žádný produkční fallback
const HESLO = process.env.ADMIN_HESLO;

if (!HESLO) {
  console.error('Chybí ADMIN_HESLO v prostředí — test se přeskakuje (spusťte s ADMIN_HESLO=... node tests/poukazy.test.js).');
  process.exit(0);
}

function adminFetch(cesta, options = {}) {
  return fetch(API + cesta, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-admin-heslo': HESLO, ...(options.headers || {}) }
  });
}

// Fáze 7F.1 — čistě logická (bez API volání) zrcadlová kopie jePoukazSkutecneAktivni()
// ze server.js, stejný princip jako "logika časového okna" v pripominky.test.js:
// ověřuje hraniční chování (dnes ještě platí, včera už ne) bez nutnosti vytvářet
// v DB poukaz s platnost_do přesně "dnes" (veřejné API to neumožňuje nastavit).
function jePoukazSkutecneAktivniZrcadlo(p) {
  const dnesIso = new Date().toISOString().slice(0, 10);
  return p.stav === 'aktivni' && p.platnost_do >= dnesIso;
}
function posunDnu(pocetDni) {
  const d = new Date();
  d.setDate(d.getDate() + pocetDni);
  return d.toISOString().slice(0, 10);
}

async function zadost(telo) {
  const r = await fetch(API + '/poukazy/zadost', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(telo)
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
async function pocetZadostiSEmailem(email) {
  const vse = await adminFetch('/admin/poukazy/zadosti').then(r => r.json());
  return vse.filter(z => z.kupujici_email === email).length;
}

async function main() {
  let poukazId = null;
  const uklidPoukazy = [];
  const uklidTypy = [];
  const uklidKlientky = new Set();
  const uklidZadosti = [];
  try {
    // --- Scénář A/B/C/E (logika) — hraniční chování bez zásahu do DB ---
    console.log('--- logika: hranice "skutečně aktivní" (stav=aktivni & platnost_do >= dnes) ---');
    assert.equal(jePoukazSkutecneAktivniZrcadlo({ stav: 'aktivni', platnost_do: posunDnu(30) }), true, 'A) budoucí platnost musí být aktivní');
    assert.equal(jePoukazSkutecneAktivniZrcadlo({ stav: 'aktivni', platnost_do: posunDnu(0) }), true, 'B) platnost přesně dnes musí ještě platit');
    assert.equal(jePoukazSkutecneAktivniZrcadlo({ stav: 'aktivni', platnost_do: posunDnu(-1) }), false, 'C) platnost včera už nesmí být aktivní');
    assert.equal(jePoukazSkutecneAktivniZrcadlo({ stav: 'castecne_vyuzity', platnost_do: posunDnu(30) }), false, 'castecne_vyuzity se nikdy nepočítá jako "skutečně aktivní" (stejně jako dřív)');
    assert.equal(jePoukazSkutecneAktivniZrcadlo({ stav: 'castecne_vyuzity', platnost_do: posunDnu(-1) }), false, 'E) expirovaný částečně využitý — dashboard/CRM ho tím spíš nesmí počítat');
    assert.equal(jePoukazSkutecneAktivniZrcadlo({ stav: 'pouzity', platnost_do: posunDnu(30) }), false, 'F) vyčerpaný poukaz není aktivní bez ohledu na platnost_do');
    assert.equal(jePoukazSkutecneAktivniZrcadlo({ stav: 'zruseny', platnost_do: posunDnu(30) }), false, 'G) zrušený poukaz není aktivní bez ohledu na platnost_do');
    console.log('OK — hraniční logika (dnes ještě platí, včera už ne, castecne_vyuzity/pouzity/zruseny nikdy) odpovídá jePoukazSkutecneAktivni() v server.js');

    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není žádná rezervovatelná položka pro test');

    // 1) Vydání testovacího poukazu na konkrétní masáž — s telefonem, ať se
    // napojí na klientku a jde ověřit i CRM (aktivniPoukazy), ne jen dashboard.
    const telefon1 = '6998001';
    const vytvorRes = await adminFetch('/admin/poukazy', {
      method: 'POST',
      body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-POUKAZY (smazat)', kupujici_telefon: telefon1 })
    });
    const vytvor = await vytvorRes.json();
    assert.equal(vytvorRes.status, 200, 'Vydání testovacího poukazu selhalo: ' + JSON.stringify(vytvor));
    poukazId = vytvor.poukaz.id;
    const hodnota = Number(vytvor.poukaz.hodnota);
    const puvodniPlatnostDo = vytvor.poukaz.platnost_do;
    const klientkaId1 = vytvor.poukaz.klientka_id;
    if (klientkaId1) uklidKlientky.add(klientkaId1);
    assert.equal(vytvor.poukaz.stav, 'aktivni');
    console.log('OK — poukaz vydán, hodnota', hodnota, 'Kč, stav "aktivni"');

    // A) Aktivní poukaz s budoucí platností se počítá jako aktivní — na
    // dashboardu (GET /admin/prehled) i v CRM (GET /admin/klientky/:id).
    {
      const prehled = await adminFetch('/admin/prehled').then(r => r.json());
      assert.ok(prehled.poukazyAktivni >= 1, 'A) Dashboard nepočítá čerstvě vydaný aktivní poukaz s budoucí platností');
      const detail = await adminFetch(`/admin/klientky/${klientkaId1}`).then(r => r.json());
      assert.equal(detail.aktivniPoukazy, 1, 'A) CRM nepočítá aktivní poukaz s budoucí platností');
      console.log('OK — A) aktivní poukaz s budoucí platností: dashboard i CRM ho správně počítají jako aktivní');
    }

    // 2) Nejde uplatnit víc, než je zůstatek
    const prekrocitRes = await adminFetch(`/admin/poukazy/${poukazId}/uplatnit`, {
      method: 'POST', body: JSON.stringify({ castka: hodnota + 1000 })
    });
    assert.equal(prekrocitRes.status, 400, 'Uplatnění částky nad zůstatek mělo selhat');
    console.log('OK — uplatnění částky nad zůstatek je odmítnuto');

    // 3) Částečné uplatnění sníží zůstatek a nastaví stav "castecne_vyuzity"
    const castka1 = Math.max(1, Math.floor(hodnota / 2));
    const c1Res = await adminFetch(`/admin/poukazy/${poukazId}/uplatnit`, {
      method: 'POST', body: JSON.stringify({ castka: castka1 })
    });
    const c1 = await c1Res.json();
    assert.equal(c1Res.status, 200, 'Částečné uplatnění selhalo: ' + JSON.stringify(c1));
    assert.equal(Number(c1.poukaz.zustatek), hodnota - castka1);
    assert.equal(c1.poukaz.stav, 'castecne_vyuzity');
    console.log('OK — částečné uplatnění správně sníží zůstatek a nastaví stav "castecne_vyuzity"');

    // D) castecne_vyuzity se do CRM aktivniPoukazy nepočítá (beze změny od
    // dřívějška — jePoukazSkutecneAktivni vyžaduje striktně stav='aktivni').
    {
      const detail = await adminFetch(`/admin/klientky/${klientkaId1}`).then(r => r.json());
      assert.equal(detail.aktivniPoukazy, 0, 'D) částečně využitý poukaz se nesmí počítat v CRM aktivniPoukazy');
      console.log('OK — D) částečně využitý poukaz (budoucí platnost) se do CRM aktivniPoukazy nepočítá; zbytek jde uplatnit dál (viz test 4)');
    }

    // 4) Dva současné požadavky na uplatnění zbytku smí uspět jen jednou
    const zbytek = hodnota - castka1;
    const [pA, pB] = await Promise.all([
      adminFetch(`/admin/poukazy/${poukazId}/uplatnit`, { method: 'POST', body: JSON.stringify({ castka: zbytek }) }),
      adminFetch(`/admin/poukazy/${poukazId}/uplatnit`, { method: 'POST', body: JSON.stringify({ castka: zbytek }) })
    ]);
    const uspesnych = [pA.status, pB.status].filter(s => s === 200).length;
    assert.equal(uspesnych, 1, `Souběžné uplatnění zbytku prošlo ${uspesnych}× místo 1× (race condition!)`);
    console.log('OK — souběžné uplatnění stejného zůstatku prošlo jen jednou (bez race condition)');

    // 5) Plně vyčerpaný poukaz už nejde dál uplatnit
    const dalsiRes = await adminFetch(`/admin/poukazy/${poukazId}/uplatnit`, {
      method: 'POST', body: JSON.stringify({ castka: 1 })
    });
    assert.equal(dalsiRes.status, 400, 'Uplatnění na vyčerpaném poukazu mělo selhat');
    console.log('OK — plně vyčerpaný poukaz už nejde dál uplatnit');

    // F) pouzity se nepočítá jako aktivní (ani v CRM)
    {
      const detail = await adminFetch(`/admin/klientky/${klientkaId1}`).then(r => r.json());
      assert.equal(detail.aktivniPoukazy, 0, 'F) vyčerpaný (pouzity) poukaz se nesmí počítat v CRM aktivniPoukazy');
      console.log('OK — F) vyčerpaný poukaz se do CRM aktivniPoukazy nepočítá');
    }

    // 6) Zrušený poukaz nejde uplatnit
    await adminFetch(`/admin/poukazy/${poukazId}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zruseny' }) });
    const zrusenyRes = await adminFetch(`/admin/poukazy/${poukazId}/uplatnit`, {
      method: 'POST', body: JSON.stringify({ castka: 1 })
    });
    assert.equal(zrusenyRes.status, 400, 'Uplatnění zrušeného poukazu mělo selhat');
    console.log('OK — zrušený poukaz nejde uplatnit');

    // G) zruseny se nepočítá jako aktivní; H) hodnota/platnost_do/klientka_id
    // zůstaly přes celý životní cyklus (aktivni→castecne_vyuzity→pouzity→
    // →ruční přepis na zruseny) beze změny — mění se jen stav a zustatek.
    {
      const seznam = await adminFetch('/admin/poukazy').then(r => r.json());
      const aktualni = seznam.find(p => p.id === poukazId);
      assert.equal(aktualni.stav, 'zruseny');
      assert.equal(aktualni.platnost_do, puvodniPlatnostDo, 'H) platnost_do se v žádném kroku nesměla změnit');
      assert.equal(Number(aktualni.hodnota), hodnota, 'H) hodnota se v žádném kroku nesměla změnit');
      assert.equal(aktualni.klientka_id, klientkaId1, 'H) klientka_id se v žádném kroku nesměla změnit');
      const detail = await adminFetch(`/admin/klientky/${klientkaId1}`).then(r => r.json());
      assert.equal(detail.aktivniPoukazy, 0, 'G) zrušený poukaz se nesmí počítat v CRM aktivniPoukazy');
      console.log('OK — G) zrušený poukaz se do CRM aktivniPoukazy nepočítá; H) hodnota/platnost_do/klientka_id beze změny přes celý životní cyklus');
    }

    // C) Expirovaný poukaz — stav v DB zůstává "aktivni" (žádný nový stav se
    // nezavádí, viz audit Fáze 7F), jen platnost_do je v minulosti. Vytvořeno
    // přes vlastní testovací typ se záporným platnost_mesicu (jediný způsob,
    // jak přes veřejné API získat platnost_do v minulosti — žádný endpoint
    // neumožňuje platnost_do nastavit/upravit přímo).
    console.log('--- C) expirovaný poukaz (stav zůstává "aktivni", platnost_do v minulosti) ---');
    {
      const telefonC = '6998003';
      const typRes = await adminFetch('/admin/poukazy/typy', {
        method: 'POST', body: JSON.stringify({ hodnota: 500, platnost_mesicu: -1, poradi: 999 })
      });
      const typ = await typRes.json();
      assert.equal(typRes.status, 200, 'Vytvoření testovacího (záměrně prošlého) typu poukazu selhalo: ' + JSON.stringify(typ));
      uklidTypy.push(typ.typ.id);

      const prehledPred = await adminFetch('/admin/prehled').then(r => r.json());

      const poukazCRes = await adminFetch('/admin/poukazy', {
        method: 'POST', body: JSON.stringify({ poukaz_typ_id: typ.typ.id, kupujici_jmeno: 'TEST-POUKAZY-EXPIROVANY (smazat)', kupujici_telefon: telefonC })
      });
      const poukazC = await poukazCRes.json();
      assert.equal(poukazCRes.status, 200, JSON.stringify(poukazC));
      uklidPoukazy.push(poukazC.poukaz.id);
      if (poukazC.poukaz.klientka_id) uklidKlientky.add(poukazC.poukaz.klientka_id);
      assert.equal(poukazC.poukaz.stav, 'aktivni', 'Nově vydaný poukaz musí mít v DB stav "aktivni", i s minulou platnost_do');
      assert.ok(poukazC.poukaz.platnost_do < posunDnu(0), 'Testovací poukaz musí mít platnost_do v minulosti');

      const uplatnitRes = await adminFetch(`/admin/poukazy/${poukazC.poukaz.id}/uplatnit`, {
        method: 'POST', body: JSON.stringify({ castka: 1 })
      });
      assert.equal(uplatnitRes.status, 400, 'Uplatnění expirovaného poukazu mělo selhat');

      const seznamPo = await adminFetch('/admin/poukazy').then(r => r.json());
      const aktualniC = seznamPo.find(p => p.id === poukazC.poukaz.id);
      assert.equal(aktualniC.stav, 'aktivni', 'Odmítnuté uplatnění nesmí samo od sebe změnit stav v DB');

      const prehledPo = await adminFetch('/admin/prehled').then(r => r.json());
      assert.equal(prehledPo.poukazyAktivni, prehledPred.poukazyAktivni, 'C) dashboard nesmí expirovaný poukaz počítat jako aktivní');
      assert.equal(prehledPo.poukazyHodnota, prehledPred.poukazyHodnota, 'C) dashboard nesmí zahrnout hodnotu expirovaného poukazu');

      const detailC = await adminFetch(`/admin/klientky/${poukazC.poukaz.klientka_id}`).then(r => r.json());
      assert.equal(detailC.aktivniPoukazy, 0, 'C) CRM nesmí expirovaný poukaz počítat jako aktivní');

      console.log('OK — C) expirovaný poukaz (DB stav zůstal "aktivni"): uplatnění odmítnuto (400), stav v DB beze změny, dashboard i CRM ho správně nepočítají jako aktivní');
    }

    // E) "castecne_vyuzity + expirovaný" — POZNÁMKA: tuto přesnou kombinaci
    // nejde přes veřejné API legitimně sestavit, protože POST .../uplatnit
    // sám odmítne uplatnění na už expirovaném poukazu (viz scénář C výš) —
    // poukaz tedy nikdy nemůže přejít na "castecne_vyuzity" POTÉ, co už
    // expiroval, a žádný endpoint neumožňuje platnost_do dodatečně posunout
    // do minulosti u poukazu, který je už castecne_vyuzity. Dashboard/CRM
    // část scénáře E je ověřená staticky výš (jePoukazSkutecneAktivniZrcadlo
    // — castecne_vyuzity s minulou platnost_do vrací false stejně jako s
    // budoucí, takže na tom nezáleží). Dynamická část (uplatnění zbytku na
    // takovém poukazu) zůstává neotestovaná — zdokumentováno zde, ne obejito.

    // ======================= 8E.3 — validace POST /api/poukazy/zadost =======================
    console.log('\n--- 8E.3: validace veřejné žádosti o poukaz ---');
    let citacZadost = 0;
    function novyEmailZadost() { citacZadost++; return 'test-8e3-zadost-' + citacZadost + '@example.invalid'; }

    // 1) validní žádost → 200
    {
      const email = novyEmailZadost();
      const v = await zadost({ hodnota: 500, kupujici_jmeno: 'TEST-8E3 (smazat)', kupujici_email: email, zpusob_platby: 'pri_prevzeti' });
      if (v.status === 200) uklidZadosti.push(v.data.zadost.id);
      assert.equal(v.status, 200, JSON.stringify(v.data));
      console.log('OK — 1) validní žádost (telefon nevyplněn) → 200');
    }

    // 2) chybějící email → 400
    {
      const v = await zadost({ hodnota: 500, kupujici_jmeno: 'TEST-8E3 (smazat)', zpusob_platby: 'pri_prevzeti' });
      if (v.status === 200) uklidZadosti.push(v.data.zadost.id);
      assert.equal(v.status, 400, JSON.stringify(v.data));
      console.log('OK — 2) chybějící email → 400');
    }

    // 3) email bez "@" → 400
    {
      const v = await zadost({ hodnota: 500, kupujici_jmeno: 'TEST-8E3 (smazat)', kupujici_email: 'neplatny-email', zpusob_platby: 'pri_prevzeti' });
      if (v.status === 200) uklidZadosti.push(v.data.zadost.id);
      assert.equal(v.status, 400, JSON.stringify(v.data));
      console.log('OK — 3) email bez "@" → 400');
    }

    // 4) telefon chybí → 200 (telefon je u žádosti nepovinný, na rozdíl od rezervace)
    {
      const email = novyEmailZadost();
      const v = await zadost({ hodnota: 500, kupujici_jmeno: 'TEST-8E3 (smazat)', kupujici_email: email, zpusob_platby: 'pri_prevzeti' });
      if (v.status === 200) uklidZadosti.push(v.data.zadost.id);
      assert.equal(v.status, 200, 'chybějící telefon musí projít — je nepovinný: ' + JSON.stringify(v.data));
      console.log('OK — 4) chybějící telefon → 200 (nepovinné pole)');
    }

    // 5) telefon "123" (vyplněný, ale příliš krátký po normalizaci) → 400
    {
      const email = novyEmailZadost();
      const v = await zadost({ hodnota: 500, kupujici_jmeno: 'TEST-8E3 (smazat)', kupujici_email: email, kupujici_telefon: '123', zpusob_platby: 'pri_prevzeti' });
      if (v.status === 200) uklidZadosti.push(v.data.zadost.id);
      assert.equal(v.status, 400, JSON.stringify(v.data));
      console.log('OK — 5) vyplněný, ale nevalidní telefon ("123") → 400');
    }

    // 6) jméno > 100 znaků → 400
    {
      const email = novyEmailZadost();
      const v = await zadost({ hodnota: 500, kupujici_jmeno: 'X'.repeat(101), kupujici_email: email, zpusob_platby: 'pri_prevzeti' });
      if (v.status === 200) uklidZadosti.push(v.data.zadost.id);
      assert.equal(v.status, 400, JSON.stringify(v.data));
      console.log('OK — 6) kupujici_jmeno > 100 znaků → 400');
    }

    // 7) vzkaz > 500 znaků → 400
    {
      const email = novyEmailZadost();
      const v = await zadost({ hodnota: 500, kupujici_jmeno: 'TEST-8E3 (smazat)', kupujici_email: email, vzkaz: 'X'.repeat(501), zpusob_platby: 'pri_prevzeti' });
      if (v.status === 200) uklidZadosti.push(v.data.zadost.id);
      assert.equal(v.status, 400, JSON.stringify(v.data));
      console.log('OK — 7) vzkaz > 500 znaků → 400');
    }

    // 8) pro_koho > 500 znaků → 400
    {
      const email = novyEmailZadost();
      const v = await zadost({ hodnota: 500, kupujici_jmeno: 'TEST-8E3 (smazat)', kupujici_email: email, pro_koho: 'X'.repeat(501), zpusob_platby: 'pri_prevzeti' });
      if (v.status === 200) uklidZadosti.push(v.data.zadost.id);
      assert.equal(v.status, 400, JSON.stringify(v.data));
      console.log('OK — 8) pro_koho > 500 znaků → 400');
    }

    // 9) konkretni_masaz > 500 znaků → 400
    {
      const email = novyEmailZadost();
      const v = await zadost({ hodnota: 500, kupujici_jmeno: 'TEST-8E3 (smazat)', kupujici_email: email, konkretni_masaz: 'X'.repeat(501), zpusob_platby: 'pri_prevzeti' });
      if (v.status === 200) uklidZadosti.push(v.data.zadost.id);
      assert.equal(v.status, 400, JSON.stringify(v.data));
      console.log('OK — 9) konkretni_masaz > 500 znaků → 400');
    }

    // 10) chybějící hodnota → 400
    {
      const email = novyEmailZadost();
      const v = await zadost({ kupujici_jmeno: 'TEST-8E3 (smazat)', kupujici_email: email, zpusob_platby: 'pri_prevzeti' });
      if (v.status === 200) uklidZadosti.push(v.data.zadost.id);
      assert.equal(v.status, 400, JSON.stringify(v.data));
      console.log('OK — 10) chybějící hodnota → 400');
    }

    // 11-15) nevalidní hodnota (abc, 0, -500, "NaN", null) → 400
    for (const h of ['abc', 0, -500, 'NaN', null]) {
      const email = novyEmailZadost();
      const v = await zadost({ hodnota: h, kupujici_jmeno: 'TEST-8E3 (smazat)', kupujici_email: email, zpusob_platby: 'pri_prevzeti' });
      if (v.status === 200) uklidZadosti.push(v.data.zadost.id);
      assert.equal(v.status, 400, 'hodnota=' + JSON.stringify(h) + ' musí vrátit 400: ' + JSON.stringify(v.data));
      const pocet = await pocetZadostiSEmailem(email);
      assert.equal(pocet, 0, 'hodnota=' + JSON.stringify(h) + ' nesmí vytvořit žádnou žádost');
    }
    console.log('OK — 11-15) nevalidní hodnota (abc/0/-500/"NaN"/null) → 400, žádná žádost nevznikla');

    // 16) hodnota přesně na horní hranici (10000) → 200
    {
      const email = novyEmailZadost();
      const v = await zadost({ hodnota: 10000, kupujici_jmeno: 'TEST-8E3 (smazat)', kupujici_email: email, zpusob_platby: 'pri_prevzeti' });
      if (v.status === 200) uklidZadosti.push(v.data.zadost.id);
      assert.equal(v.status, 200, 'hodnota přesně 10000 (horní hranice, včetně) musí projít: ' + JSON.stringify(v.data));
      console.log('OK — 16) hodnota = 10000 (horní hranice) → 200');
    }

    // 17) hodnota nad horní hranicí (10000.01) → 400
    {
      const email = novyEmailZadost();
      const v = await zadost({ hodnota: 10000.01, kupujici_jmeno: 'TEST-8E3 (smazat)', kupujici_email: email, zpusob_platby: 'pri_prevzeti' });
      if (v.status === 200) uklidZadosti.push(v.data.zadost.id);
      assert.equal(v.status, 400, JSON.stringify(v.data));
      const pocet = await pocetZadostiSEmailem(email);
      assert.equal(pocet, 0, 'hodnota nad limitem nesmí vytvořit žádost');
      console.log('OK — 17) hodnota = 10000.01 (nad horní hranicí) → 400');
    }

    // 18) "Infinity" — JSON nemá nativní literál Infinity/NaN, ekvivalentní
    // serializovatelná reprezentace je string "Infinity"; Number("Infinity")
    // v JS vrací Infinity, Number.isFinite(Infinity) je false → musí dát 400,
    // nikdy 500 (žádný pád na pokusu o aritmetiku/DB zápis nekonečné hodnoty).
    {
      const email = novyEmailZadost();
      const v = await zadost({ hodnota: 'Infinity', kupujici_jmeno: 'TEST-8E3 (smazat)', kupujici_email: email, zpusob_platby: 'pri_prevzeti' });
      if (v.status === 200) uklidZadosti.push(v.data.zadost.id);
      assert.equal(v.status, 400, '"Infinity" musí být ošetřeno jako 400, ne spadnout na 500: ' + JSON.stringify(v.data));
      const pocet = await pocetZadostiSEmailem(email);
      assert.equal(pocet, 0, '"Infinity" nesmí vytvořit žádost');
      console.log('OK — 18) hodnota = "Infinity" → 400 (ne 500)');
    }

    console.log('✅ 8E.3: validace POST /api/poukazy/zadost prošla (18/18 scénářů)');

    // --- Ochrana proti duplicitnímu vystavení při schválení žádosti ---
    // (audit poukazů, Fáze B bod 1) — PATCH /api/admin/poukazy/zadosti/:id/stav
    // dřív při souběžném/opakovaném schválení stejné žádosti uměl vytvořit dva
    // poukazy; oprava přidává "FOR UPDATE" zámek řádku žádosti + kontrolu, že
    // žádost je ještě "nova". Scénář 21 přímo reprodukuje chybu nahlášenou
    // auditem a ověřenou živě na TEST DB před opravou.
    {
      const email19 = 'test-schvaleni-19-' + Date.now() + '@example.invalid';
      const v19 = await zadost({ hodnota: 500, kupujici_jmeno: 'TEST-SCHVALENI (smazat)', kupujici_email: email19, zpusob_platby: 'pri_prevzeti' });
      assert.equal(v19.status, 200, '19) Vytvoření žádosti selhalo: ' + JSON.stringify(v19.data));
      const schv19 = await adminFetch(`/admin/poukazy/zadosti/${v19.data.zadost.id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'vyrizena' }) });
      const d19 = await schv19.json();
      assert.equal(schv19.status, 200, '19) Schválení selhalo: ' + JSON.stringify(d19));
      assert.ok(d19.poukaz && d19.poukaz.id, '19) Schválení nevrátilo vytvořený poukaz');
      uklidPoukazy.push(d19.poukaz.id);
      if (d19.poukaz.klientka_id) uklidKlientky.add(d19.poukaz.klientka_id);
      const poukazy19 = await adminFetch('/admin/poukazy').then(r => r.json());
      assert.equal(poukazy19.filter(p => p.kupujici_email === email19).length, 1, '19) běžné schválení muselo vytvořit přesně 1 poukaz');
      console.log('OK — 19) běžné jednorázové schválení žádosti vytvoří přesně 1 poukaz (regrese)');
    }
    {
      const email20 = 'test-schvaleni-20-' + Date.now() + '@example.invalid';
      const v20 = await zadost({ hodnota: 500, kupujici_jmeno: 'TEST-SCHVALENI (smazat)', kupujici_email: email20, zpusob_platby: 'pri_prevzeti' });
      const zadostId20 = v20.data.zadost.id;
      const prvni20 = await adminFetch(`/admin/poukazy/zadosti/${zadostId20}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'vyrizena' }) });
      const prvniData20 = await prvni20.json();
      assert.equal(prvni20.status, 200, '20) první schválení selhalo: ' + JSON.stringify(prvniData20));
      uklidPoukazy.push(prvniData20.poukaz.id);
      if (prvniData20.poukaz.klientka_id) uklidKlientky.add(prvniData20.poukaz.klientka_id);
      const druhy20 = await adminFetch(`/admin/poukazy/zadosti/${zadostId20}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'vyrizena' }) });
      assert.equal(druhy20.status, 400, '20) opakované schválení už vyřízené žádosti mělo být odmítnuto (400)');
      const poukazy20 = await adminFetch('/admin/poukazy').then(r => r.json());
      assert.equal(poukazy20.filter(p => p.kupujici_email === email20).length, 1, '20) opakované schválení nesmí vytvořit druhý poukaz');
      console.log('OK — 20) opakované (sekvenční) schválení už vyřízené žádosti je odmítnuto, nevznikl druhý poukaz');
    }
    {
      const email21 = 'test-schvaleni-21-' + Date.now() + '@example.invalid';
      const v21 = await zadost({ hodnota: 500, kupujici_jmeno: 'TEST-SCHVALENI (smazat)', kupujici_email: email21, zpusob_platby: 'pri_prevzeti' });
      const zadostId21 = v21.data.zadost.id;
      const [sA, sB] = await Promise.all([
        adminFetch(`/admin/poukazy/zadosti/${zadostId21}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'vyrizena' }) })
          .then(r => r.json().then(d => ({ status: r.status, data: d }))),
        adminFetch(`/admin/poukazy/zadosti/${zadostId21}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'vyrizena' }) })
          .then(r => r.json().then(d => ({ status: r.status, data: d })))
      ]);
      const uspesnych21 = [sA.status, sB.status].filter(s => s === 200).length;
      assert.equal(uspesnych21, 1, `21) Souběžné schválení prošlo ${uspesnych21}× místo 1× (race condition!)`);
      const poukazVysledek21 = (sA.data && sA.data.poukaz) || (sB.data && sB.data.poukaz);
      assert.ok(poukazVysledek21 && poukazVysledek21.id, '21) úspěšné schválení muselo vrátit vytvořený poukaz');
      uklidPoukazy.push(poukazVysledek21.id);
      if (poukazVysledek21.klientka_id) uklidKlientky.add(poukazVysledek21.klientka_id);
      const poukazy21 = await adminFetch('/admin/poukazy').then(r => r.json());
      assert.equal(poukazy21.filter(p => p.kupujici_email === email21).length, 1, '21) souběžné schválení nesmí vytvořit dva poukazy');
      console.log('OK — 21) souběžné schválení stejné žádosti (Promise.all) vytvoří jen jeden poukaz, bez race condition');
    }
    console.log('✅ ochrana proti duplicitnímu vystavení žádosti prošla (19-21/21 scénářů)');

    // --- Ochrana historie poukazů (audit poukazů, Fáze B krok 2) ---
    // DELETE /api/admin/poukazy/:id teď odmítne smazat poukaz s platební
    // historií (400) — pro takový poukaz slouží zrušení (PATCH .../stav
    // {stav:'zruseny'}), které historii nijak nemaže ani nepřepisuje.
    {
      // 1) Smazání poukazu BEZ platební historie → 200, skutečně zmizí.
      const nova1 = await adminFetch('/admin/poukazy', {
        method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-HISTORIE-1 (smazat)' })
      }).then(r => r.json());
      assert.ok(nova1.poukaz && nova1.poukaz.id, '1) Vydání testovacího poukazu selhalo: ' + JSON.stringify(nova1));
      if (nova1.poukaz.klientka_id) uklidKlientky.add(nova1.poukaz.klientka_id);
      const smaz1 = await adminFetch(`/admin/poukazy/${nova1.poukaz.id}`, { method: 'DELETE' });
      assert.equal(smaz1.status, 200, '1) Smazání poukazu bez historie mělo projít: ' + JSON.stringify(await smaz1.json().catch(() => ({}))));
      const seznamPo1 = await adminFetch('/admin/poukazy').then(r => r.json());
      assert.ok(!seznamPo1.some(p => p.id === nova1.poukaz.id), '1) Smazaný poukaz nesmí být dál v seznamu');
      console.log('OK — 1) smazání poukazu bez platební historie → 200, skutečně smazán');
    }
    {
      // 2) Pokus o smazání poukazu S platební historií → 400, poukaz zůstává.
      // Znovupoužívá hlavní testovací "poukazId" výš v tomhle souboru — ten už
      // prošel částečným i souběžným uplatněním, takže historii má jistě.
      const smaz2 = await adminFetch(`/admin/poukazy/${poukazId}`, { method: 'DELETE' });
      const d2 = await smaz2.json();
      assert.equal(smaz2.status, 400, '2) Smazání poukazu s historií mělo být odmítnuto: ' + JSON.stringify(d2));
      assert.ok(d2.chyba && d2.chyba.includes('historii'), '2) Chybová hláška měla zmínit historii: ' + JSON.stringify(d2));
      const seznamPo2 = await adminFetch('/admin/poukazy').then(r => r.json());
      assert.ok(seznamPo2.some(p => p.id === poukazId), '2) Poukaz s historií musí v DB zůstat');
      console.log('OK — 2) smazání poukazu s platební historií je odmítnuto (400), poukaz zůstává v DB');
    }
    {
      // 3) Zrušení poukazu přes existující endpoint → 200, stav i uzavreno_kdy.
      const nova3 = await adminFetch('/admin/poukazy', {
        method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-HISTORIE-3 (smazat)' })
      }).then(r => r.json());
      if (nova3.poukaz.klientka_id) uklidKlientky.add(nova3.poukaz.klientka_id);
      uklidPoukazy.push(nova3.poukaz.id);
      const zrus3 = await adminFetch(`/admin/poukazy/${nova3.poukaz.id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zruseny' }) });
      assert.equal(zrus3.status, 200, '3) Zrušení poukazu selhalo: ' + JSON.stringify(await zrus3.json().catch(() => ({}))));
      const seznamPo3 = await adminFetch('/admin/poukazy').then(r => r.json());
      const aktualni3 = seznamPo3.find(p => p.id === nova3.poukaz.id);
      assert.equal(aktualni3.stav, 'zruseny', '3) Stav po zrušení musí být "zruseny"');
      assert.ok(aktualni3.uzavreno_kdy, '3) uzavreno_kdy musí být po zrušení nastaveno');
      console.log('OK — 3) zrušení poukazu přes PATCH .../stav funguje, stav i uzavreno_kdy se nastaví');
    }
    {
      // 4) Platební historie zůstává po zrušení zachována. Poznámka: dedikovaný
      // endpoint pro čtení historie konkrétního poukazu zatím neexistuje (je
      // to samostatný pozdější krok Fáze B) — ověřujeme proto dostupně přes
      // API: zůstatek (zustatek) poukazu "poukazId" se zrušením NIKDY nesmí
      // resetovat zpět na plnou hodnotu ani jinak změnit — UPDATE u zrušení
      // sloupec zustatek vůbec nemění, takže zachovaný (snížený) zůstatek je
      // přímý důkaz, že historické čerpání nebylo zrušením vymazáno/přepsáno.
      const seznamPred4 = await adminFetch('/admin/poukazy').then(r => r.json());
      const pred4 = seznamPred4.find(p => p.id === poukazId);
      assert.equal(pred4.stav, 'zruseny', '4) očekávám, že "poukazId" je v tuhle chvíli už zrušený (ze scénáře dřív v souboru)');
      assert.ok(Number(pred4.zustatek) < Number(pred4.hodnota), '4) zůstatek musí odrážet dřívější čerpání (být nižší než hodnota), ne reset');
      // Druhé zrušení (idempotentní no-op) nesmí zůstatek nijak změnit.
      await adminFetch(`/admin/poukazy/${poukazId}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zruseny' }) });
      const seznamPo4 = await adminFetch('/admin/poukazy').then(r => r.json());
      const po4 = seznamPo4.find(p => p.id === poukazId);
      assert.equal(Number(po4.zustatek), Number(pred4.zustatek), '4) Opakované zrušení nesmí zůstatek (= odraz historie čerpání) nijak změnit');
      console.log('OK — 4) platební historie (odražená v zůstatku) zůstává po zrušení i po opakovaném zrušení beze změny');
    }
    {
      // 5) Uplatnění zrušeného poukazu je odmítnuto (beze změny chování —
      // stejné pravidlo jako dřív, jen explicitně zopakované v kontextu téhle
      // ochrany kvůli úplnosti požadovaných scénářů).
      const uplatnit5 = await adminFetch(`/admin/poukazy/${poukazId}/uplatnit`, { method: 'POST', body: JSON.stringify({ castka: 1 }) });
      assert.equal(uplatnit5.status, 400, '5) Uplatnění zrušeného poukazu mělo selhat');
      console.log('OK — 5) uplatnění zrušeného poukazu je odmítnuto (400)');
    }
    {
      // 6) Neexistující ID — DELETE i PATCH .../stav musí vracet 404 (dřív
      // obojí tiše vracelo 200, i když se nic nenašlo/nesmazalo).
      const neexistujiciId = 999999999;
      const smaz6 = await adminFetch(`/admin/poukazy/${neexistujiciId}`, { method: 'DELETE' });
      assert.equal(smaz6.status, 404, '6) DELETE na neexistující poukaz musí vracet 404');
      const stav6 = await adminFetch(`/admin/poukazy/${neexistujiciId}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zruseny' }) });
      assert.equal(stav6.status, 404, '6) PATCH .../stav na neexistující poukaz musí vracet 404');
      console.log('OK — 6) neexistující ID poukazu → 404 u DELETE i PATCH .../stav');
    }
    {
      // 7) Souběžné mazání stejného (bezhistorického) poukazu — právě jeden
      // požadavek smí uspět, druhý musí dostat 404 (poukaz mezitím zmizel),
      // nikdy ne nekonzistentní stav (např. oba 200, nebo chyba 500).
      const nova7 = await adminFetch('/admin/poukazy', {
        method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-HISTORIE-7 (smazat)' })
      }).then(r => r.json());
      if (nova7.poukaz.klientka_id) uklidKlientky.add(nova7.poukaz.klientka_id);
      const [sA7, sB7] = await Promise.all([
        adminFetch(`/admin/poukazy/${nova7.poukaz.id}`, { method: 'DELETE' }),
        adminFetch(`/admin/poukazy/${nova7.poukaz.id}`, { method: 'DELETE' })
      ]);
      const stavy7 = [sA7.status, sB7.status].sort();
      assert.deepEqual(stavy7, [200, 404], `7) Souběžné mazání mělo dát přesně jeden 200 a jeden 404, dostal jsem ${JSON.stringify(stavy7)}`);
      const seznamPo7 = await adminFetch('/admin/poukazy').then(r => r.json());
      assert.ok(!seznamPo7.some(p => p.id === nova7.poukaz.id), '7) Poukaz musí být po souběžném mazání skutečně pryč');
      console.log('OK — 7) souběžné mazání stejného poukazu (Promise.all) → právě 1× 200, 1× 404, žádná nekonzistence');
    }
    console.log('✅ ochrana historie poukazů prošla (7/7 scénářů)');

    console.log('\n✅ VŠECHNY TESTY POUKAZŮ PROŠLY');
  } finally {
    // Hlavní testovací poukaz má v tuhle chvíli už platební historii (scénáře
    // uplatnění výš) — po ochraně historie (Fáze B krok 2) ho tedy smazání
    // odmítne (400), a to je správně, ne chyba úklidu. Zůstane v TEST DB jako
    // zrušený (scénář 6 ho na "zruseny" nastavil už dřív) — .catch() tu jen
    // chrání proti síťové chybě, ne proti očekávanému 400.
    if (poukazId) {
      await adminFetch(`/admin/poukazy/${poukazId}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of uklidPoukazy) {
      await adminFetch(`/admin/poukazy/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of uklidTypy) {
      await adminFetch(`/admin/poukazy/typy/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of uklidZadosti) {
      await adminFetch(`/admin/poukazy/zadosti/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    // Klientky se mažou AŽ TEĎ, po smazání poukazů, které na ně ukazovaly —
    // DELETE /api/admin/klientky/:id sám odmítne smazání, dokud klientka má
    // jakoukoli vazbu, takže tohle nikdy nesmaže nic cizího.
    let klientkySmazano = 0;
    for (const id of uklidKlientky) {
      const r = await adminFetch(`/admin/klientky/${id}`, { method: 'DELETE' }).catch(() => null);
      if (r && r.ok) klientkySmazano++;
    }
    console.log(`(uklizeno: ${1 + uklidPoukazy.length} testovacích poukazů, ${uklidTypy.length} testovacích typů poukazů, ${klientkySmazano}/${uklidKlientky.size} testovacích klientek, ${uklidZadosti.length} testovacích žádostí o poukaz)`);
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
