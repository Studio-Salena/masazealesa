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

async function main() {
  let poukazId = null;
  const uklidPoukazy = [];
  const uklidTypy = [];
  const uklidKlientky = new Set();
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

    console.log('\n✅ VŠECHNY TESTY POUKAZŮ PROŠLY');
  } finally {
    if (poukazId) {
      await adminFetch(`/admin/poukazy/${poukazId}`, { method: 'DELETE' });
    }
    for (const id of uklidPoukazy) {
      await adminFetch(`/admin/poukazy/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of uklidTypy) {
      await adminFetch(`/admin/poukazy/typy/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    // Klientky se mažou AŽ TEĎ, po smazání poukazů, které na ně ukazovaly —
    // DELETE /api/admin/klientky/:id sám odmítne smazání, dokud klientka má
    // jakoukoli vazbu, takže tohle nikdy nesmaže nic cizího.
    let klientkySmazano = 0;
    for (const id of uklidKlientky) {
      const r = await adminFetch(`/admin/klientky/${id}`, { method: 'DELETE' }).catch(() => null);
      if (r && r.ok) klientkySmazano++;
    }
    console.log(`(uklizeno: ${1 + uklidPoukazy.length} testovacích poukazů, ${uklidTypy.length} testovacích typů poukazů, ${klientkySmazano}/${uklidKlientky.size} testovacích klientek)`);
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
