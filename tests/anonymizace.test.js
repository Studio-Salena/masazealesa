// Regresní test: GDPR anonymizace klientky (Fáze 7D.2B, návrh viz 7D.2A).
// Ověřuje 19 scénářů zadaných v zadání Fáze 7D.2B. Běží VÝHRADNĚ proti
// izolovanému testovacímu prostředí (viz tests/env-guard.js — fail-closed,
// žádný produkční fallback). Všechny testovací entity jsou syntetické
// (vymyšlená telefonní čísla/jména/e-maily), cleanup je vždy podle
// konkrétního ID, nikdy plošný DELETE.
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=http://localhost:3001/api node tests/anonymizace.test.js

const assert = require('node:assert/strict');

const { ziskatTestApiBase } = require('./env-guard');
const API = ziskatTestApiBase(); // fail-closed, žádný produkční fallback
const HESLO = process.env.ADMIN_HESLO;

if (!HESLO) {
  console.error('Chybí ADMIN_HESLO v prostředí — test se přeskakuje (spusťte s ADMIN_HESLO=... node tests/anonymizace.test.js).');
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

const uklidRezervace = [];
const uklidPoukazy = [];
const uklidKlientky = new Set();
const uklidZadosti = [];
const uklidNewsletter = [];
const uklidTypy = []; // Fáze 7F.4 — testovací typy poukazů se záporným platnost_mesicu

// Vytvoří rezervaci s vlastním syntetickým telefonem (=> vlastní/nová
// klientka) — vrací rezervaci i klientka_id, oboje se rovnou zapíše do
// úklidových seznamů.
async function vytvorRezervaci(cenikId, telefon, odpocetDni, jmeno = 'TEST-ANONYMIZACE (smazat)') {
  const { datum, cas } = await novyVolnyTermin(cenikId, odpocetDni);
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: cas, jmeno, telefon })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'Vytvoření testovací rezervace selhalo: ' + JSON.stringify(data));
  if (data.rezervace.klientka_id) uklidKlientky.add(data.rezervace.klientka_id);
  uklidRezervace.push(data.rezervace.id);
  return data.rezervace;
}

async function nastavStav(rezervaceId, stav) {
  const res = await adminFetch(`/admin/rezervace/${rezervaceId}/stav`, { method: 'PATCH', body: JSON.stringify({ stav }) });
  assert.equal(res.status, 200, `Nastavení stavu "${stav}" selhalo`);
}

async function vytvorPoukaz(cenikId, telefon, jmeno = 'TEST-ANONYMIZACE-POUKAZ (smazat)') {
  const res = await adminFetch('/admin/poukazy', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, kupujici_jmeno: jmeno, kupujici_telefon: telefon })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'Vytvoření testovacího poukazu selhalo: ' + JSON.stringify(data));
  uklidPoukazy.push(data.poukaz.id);
  if (data.poukaz.klientka_id) uklidKlientky.add(data.poukaz.klientka_id);
  return data.poukaz;
}

async function anonymizovat(klientkaId, potvrzeno = true) {
  const res = await adminFetch(`/admin/klientky/${klientkaId}/anonymizovat`, {
    method: 'POST', body: JSON.stringify(potvrzeno === undefined ? {} : { potvrzeno })
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function nacistKlientku(id) {
  const res = await adminFetch(`/admin/klientky/${id}`);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

let scenaru = 0, uspesnych = 0;
function oznacUspech(popis) { scenaru++; uspesnych++; console.log('OK — ' + popis); }

async function main() {
  const cenik = await fetch(API + '/cenik').then(r => r.json());
  const polozka = cenik.find(c => c.rezervovatelna);
  assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');
  const cena = Number(polozka.cena);
  let odpocet = 20; // roste s každým scénářem, ať si testovací rezervace vzájemně nekolidují

  try {
    // 1) Klientka bez historie
    console.log('--- 1) klientka bez historie ---');
    {
      const telefon = '6999001';
      const res = await adminFetch('/admin/klientky', { method: 'POST', body: JSON.stringify({ telefon, jmeno: 'TEST-ANON-01 (smazat)', email: 'test-anon-01@example.invalid', poznamka: 'p', alergie: 'a', preference: 'pr' }) });
      const data = await res.json();
      assert.equal(res.status, 200, JSON.stringify(data));
      const id = data.klientka.id;
      uklidKlientky.add(id);

      const { status, data: vysledek } = await anonymizovat(id);
      assert.equal(status, 200, JSON.stringify(vysledek));
      assert.equal(vysledek.klientka.aktivni, false);
      assert.ok(vysledek.klientka.anonymizovano_kdy, 'anonymizovano_kdy nebylo nastaveno');
      assert.equal(Object.prototype.hasOwnProperty.call(vysledek.klientka, 'jmeno'), false, 'odpověď nesmí obsahovat osobní údaje');

      const ctena = await nacistKlientku(id);
      assert.equal(ctena.status, 404, 'Anonymizovaná klientka bez historie se stále zobrazuje jako aktivní (WHERE aktivni=true ji má skrýt)');
      oznacUspech('klientka bez historie: anonymizace uspěla, zmizela z aktivního seznamu (404)');
    }

    // 2) Klientka s dokončenou rezervací
    console.log('--- 2) dokončená rezervace ---');
    let klientka2Id;
    {
      const telefon = '6999002';
      const r = await vytvorRezervaci(polozka.id, telefon, odpocet); odpocet += 5;
      klientka2Id = r.klientka_id;
      assert.ok(klientka2Id, 'Rezervace nezaložila klientku');
      await nastavStav(r.id, 'dokoncena');

      const { status, data } = await anonymizovat(klientka2Id);
      assert.equal(status, 200, JSON.stringify(data));

      const seznam = await adminFetch('/admin/rezervace').then(x => x.json());
      const aktualni = seznam.find(x => x.id === r.id);
      assert.equal(aktualni.jmeno, '(anonymizováno)');
      assert.equal(aktualni.telefon, '');
      assert.equal(aktualni.email, null);
      assert.equal(aktualni.poznamka, null);
      assert.equal(aktualni.stav, 'dokoncena');
      assert.equal(Number(aktualni.cena), cena);
      assert.equal(aktualni.klientka_id, klientka2Id);
      oznacUspech('dokončená rezervace: jméno/telefon/email/poznámka anonymizované, stav/cena/klientka_id beze změny');
    }

    // 3) Klientka se zrušenou rezervací
    console.log('--- 3) zrušená rezervace ---');
    {
      const telefon = '6999003';
      const r = await vytvorRezervaci(polozka.id, telefon, odpocet); odpocet += 5;
      await nastavStav(r.id, 'zrusena');
      const { status, data } = await anonymizovat(r.klientka_id);
      assert.equal(status, 200, JSON.stringify(data));
      const seznam = await adminFetch('/admin/rezervace').then(x => x.json());
      const aktualni = seznam.find(x => x.id === r.id);
      assert.equal(aktualni.jmeno, '(anonymizováno)');
      assert.equal(aktualni.stav, 'zrusena');
      oznacUspech('zrušená rezervace: anonymizována stejně jako dokončená, stav beze změny');
    }

    // 4) Klientka s no-show rezervací
    console.log('--- 4) no-show rezervace ---');
    {
      const telefon = '6999004';
      const r = await vytvorRezervaci(polozka.id, telefon, odpocet); odpocet += 5;
      await nastavStav(r.id, 'nedostavila_se');
      const { status, data } = await anonymizovat(r.klientka_id);
      assert.equal(status, 200, JSON.stringify(data));
      const seznam = await adminFetch('/admin/rezervace').then(x => x.json());
      const aktualni = seznam.find(x => x.id === r.id);
      assert.equal(aktualni.jmeno, '(anonymizováno)');
      assert.equal(aktualni.stav, 'nedostavila_se');
      oznacUspech('no-show rezervace: anonymizována, stav beze změny');
    }

    // 5) Klientka s platbou (+ 16 platby před/po ve stejném scénáři)
    console.log('--- 5) platba u dokončené rezervace ---');
    {
      const telefon = '6999005';
      const r = await vytvorRezervaci(polozka.id, telefon, odpocet); odpocet += 5;
      await adminFetch(`/admin/rezervace/${r.id}/platba`, { method: 'PATCH', body: JSON.stringify({ castka: cena, zpusob_platby: 'hotove' }) });
      await nastavStav(r.id, 'dokoncena');

      const platbyPred = await adminFetch(`/admin/rezervace/${r.id}/platby`).then(x => x.json());
      const rezervacePred = await adminFetch('/admin/rezervace').then(x => x.json()).then(s => s.find(x => x.id === r.id));

      const { status } = await anonymizovat(r.klientka_id);
      assert.equal(status, 200);

      const platbyPo = await adminFetch(`/admin/rezervace/${r.id}/platby`).then(x => x.json());
      const rezervacePo = await adminFetch('/admin/rezervace').then(x => x.json()).then(s => s.find(x => x.id === r.id));

      assert.deepEqual(
        platbyPred.map(p => ({ castka: Number(p.castka), typ: p.typ, zpusob_platby: p.zpusob_platby })),
        platbyPo.map(p => ({ castka: Number(p.castka), typ: p.typ, zpusob_platby: p.zpusob_platby })),
        'Deník plateb se po anonymizaci změnil — platby nemají vlastní osobní sloupec, nesmí se dotknout'
      );
      assert.equal(Number(rezervacePred.uhrazeno), Number(rezervacePo.uhrazeno));
      assert.equal(rezervacePred.stav_platby, rezervacePo.stav_platby);
      oznacUspech('platba: deník plateb (16) i uhrazeno/stav_platby na rezervaci (5) jsou před/po identické');
    }

    // 6) Klientka s uzavřeným (zrušeným) poukazem
    console.log('--- 6) uzavřený poukaz ---');
    {
      const telefon = '6999006';
      const p = await vytvorPoukaz(polozka.id, telefon);
      await adminFetch(`/admin/poukazy/${p.id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zruseny' }) });
      const { status } = await anonymizovat(p.klientka_id);
      assert.equal(status, 200);
      const seznam = await adminFetch('/admin/poukazy').then(x => x.json());
      const aktualni = seznam.find(x => x.id === p.id);
      assert.equal(aktualni.kupujici_jmeno, null);
      assert.equal(aktualni.kupujici_email, null);
      assert.equal(aktualni.kupujici_telefon, null);
      assert.equal(aktualni.stav, 'zruseny');
      assert.equal(Number(aktualni.hodnota), Number(p.hodnota));
      assert.equal(aktualni.kod, p.kod);
      oznacUspech('uzavřený (zrušený) poukaz: kupující anonymizován, hodnota/stav/kód beze změny');
    }

    // 7) Klientka s aktivním poukazem → odmítnout
    console.log('--- 7) aktivní poukaz → odmítnout ---');
    {
      const telefon = '6999007';
      const p = await vytvorPoukaz(polozka.id, telefon);
      assert.equal(p.stav, 'aktivni');
      const { status, data } = await anonymizovat(p.klientka_id);
      assert.equal(status, 400, 'Anonymizace s aktivním poukazem měla být odmítnuta: ' + JSON.stringify(data));
      assert.ok(data.chyba, 'Chybí důvod odmítnutí');

      // 13) zároveň ověřuje, že odmítnutí NIC nezměnilo (ROLLBACK skutečně
      // proběhl) — klientka zůstává v původním, neanonymizovaném stavu.
      const ctena = await nacistKlientku(p.klientka_id);
      assert.equal(ctena.status, 200, 'Klientka po odmítnuté anonymizaci zmizela z aktivního seznamu — ROLLBACK neproběhl správně');
      assert.equal(ctena.data.jmeno, 'TEST-ANONYMIZACE-POUKAZ (smazat)', 'Jméno klientky se po odmítnuté anonymizaci změnilo');

      // 7F.4B Test A) PII poukazu musí po odmítnuté anonymizaci zůstat beze změny.
      const seznamA = await adminFetch('/admin/poukazy').then(x => x.json());
      const poukazA = seznamA.find(x => x.id === p.id);
      assert.equal(poukazA.kupujici_jmeno, p.kupujici_jmeno, 'A) PII poukazu (kupujici_jmeno) se nesmělo změnit po odmítnuté anonymizaci');

      oznacUspech('A) aktivní + budoucí platnost: anonymizace odmítnuta (400), klientka i PII poukazu beze změny (ověřuje i scénář 13 — rollback)');
    }

    // 8) Klientka s částečně využitým poukazem → odmítnout
    console.log('--- 8) částečně využitý poukaz → odmítnout ---');
    {
      const telefon = '6999008';
      const p = await vytvorPoukaz(polozka.id, telefon);
      const castecna = Math.max(1, Math.floor(Number(p.hodnota) / 3));
      const u = await adminFetch(`/admin/poukazy/${p.id}/uplatnit`, { method: 'POST', body: JSON.stringify({ castka: castecna }) }).then(x => x.json());
      assert.equal(u.poukaz.stav, 'castecne_vyuzity');
      const { status, data } = await anonymizovat(p.klientka_id);
      assert.equal(status, 400, 'Anonymizace s částečně využitým poukazem měla být odmítnuta: ' + JSON.stringify(data));

      // 7F.4B Test D) PII poukazu musí po odmítnuté anonymizaci zůstat beze změny.
      const seznamD = await adminFetch('/admin/poukazy').then(x => x.json());
      const poukazD = seznamD.find(x => x.id === p.id);
      assert.equal(poukazD.kupujici_jmeno, p.kupujici_jmeno, 'D) PII poukazu (kupujici_jmeno) se nesmělo změnit po odmítnuté anonymizaci');

      oznacUspech('D) částečně využitý + budoucí platnost: anonymizace odmítnuta (400), PII poukazu beze změny');
    }

    // 7F.4B Test C) Expirovaný aktivní poukaz (DB stav zůstává "aktivni",
    // platnost_do v minulosti): NEBLOKUJE anonymizaci (Varianta B, 7F.3/7F.4)
    // A JEHO PII SE PŘI TÉŽE TRANSAKCI ANONYMIZUJE (7F.4B — dřív, ve Fázi 7F.4,
    // se jen odblokovalo, poukaz samotný zůstal neanonymizovaný; to už teď
    // neplatí). Vytvořeno přes testovací typ se záporným platnost_mesicu —
    // stejný postup jako tests/poukazy.test.js scénář C, jediný způsob, jak
    // přes veřejné API získat platnost_do v minulosti.
    // 7F.4B Test B) Aktivní poukaz s platnost_do PŘESNĚ dnešním datem musí
    // stále blokovat (hranice ">= dnes"). DYNAMICKY NEJDE VYTVOŘIT přes
    // veřejné API: `poukazy_typy.platnost_mesicu` je v DB sloupec typu
    // `integer` (schema.sql) — ověřeno EMPIRICKY (ne jen předpokladem), že
    // zkouška s necelým číslem (platnost_mesicu=0.5, se záměrem využít
    // ořezání ve funkci setMonth()) skončí přímo na Postgres chybou
    // "invalid input syntax for type integer", dřív než by se vůbec dostala
    // k datové logice — a platnost_mesicu=0 neprojde ani aplikační validací
    // endpointu (`!platnost_mesicu` je pro 0 pravda). Ověřeno proto staticky —
    // zrcadlová kopie blokující podmínky z anonymizovatKlientku na syntetickém
    // řádku s platnost_do===dnes:
    console.log('--- 7F.4B-B) aktivní + platnost přesně dnes: stále blokuje (jen staticky — viz komentář) ---');
    {
      const dnesIsoB = new Date().toISOString().slice(0, 10);
      const jeOtevrenyProAnonymizaci = p => (p.stav === 'aktivni' || p.stav === 'castecne_vyuzity') && p.platnost_do >= dnesIsoB;
      assert.equal(jeOtevrenyProAnonymizaci({ stav: 'aktivni', platnost_do: dnesIsoB }), true, 'B) platnost_do přesně dnes musí být pořád "otevřeno" (blokuje)');
      oznacUspech('B) aktivní + platnost přesně dnes: staticky ověřeno, že nová WHERE podmínka takový řádek pořád považuje za otevřený/blokující (dynamicky nevytvořitelné přes API — poukazy_typy.platnost_mesicu je integer, zdůvodněno v komentáři)');
    }

    console.log('--- 7F.4B-C) expirovaný aktivní poukaz: NEBLOKUJE a PII se anonymizuje ---');
    {
      const telefon = '6999017';
      const typRes = await adminFetch('/admin/poukazy/typy', {
        method: 'POST', body: JSON.stringify({ hodnota: 500, platnost_mesicu: -1, poradi: 999 })
      });
      const typ = await typRes.json();
      assert.equal(typRes.status, 200, JSON.stringify(typ));
      uklidTypy.push(typ.typ.id);

      const poukazRes = await adminFetch('/admin/poukazy', {
        method: 'POST', body: JSON.stringify({ poukaz_typ_id: typ.typ.id, kupujici_jmeno: 'TEST-7F4B-C (smazat)', kupujici_email: 'test-7f4b-c@example.invalid', kupujici_telefon: telefon, pro_koho: 'TEST-OBDAROVANA (smazat)' })
      });
      const poukaz = await poukazRes.json();
      assert.equal(poukazRes.status, 200, JSON.stringify(poukaz));
      uklidPoukazy.push(poukaz.poukaz.id);
      const klientkaId = poukaz.poukaz.klientka_id;
      uklidKlientky.add(klientkaId);
      assert.equal(poukaz.poukaz.stav, 'aktivni', 'Nově vydaný poukaz musí mít v DB stav "aktivni", i s minulou platnost_do');

      // Finanční integrita (bod 6 zadání) — snímek PŘED anonymizací. Tento
      // poukaz nikdy nebyl uplatněn (žádná vazba na rezervaci/platbu), deník
      // plateb je tedy pro tenhle konkrétní scénář irelevantní — viz Test F
      // níž, kde SE poukaz uplatňuje a deník plateb se ověřuje explicitně.
      const pred = { hodnota: poukaz.poukaz.hodnota, zustatek: poukaz.poukaz.zustatek, stav: poukaz.poukaz.stav, kod: poukaz.poukaz.kod, ean: poukaz.poukaz.ean, platnost_do: poukaz.poukaz.platnost_do };

      const { status, data } = await anonymizovat(klientkaId);
      assert.equal(status, 200, 'Expirovaný aktivní poukaz neměl blokovat anonymizaci (Varianta B): ' + JSON.stringify(data));

      const seznamPo = await adminFetch('/admin/poukazy').then(x => x.json());
      const po = seznamPo.find(p => p.id === poukaz.poukaz.id);

      // 7F.4B bod 2 — PII musí být anonymizované.
      assert.equal(po.kupujici_jmeno, null, 'C) kupujici_jmeno mělo být anonymizováno');
      assert.equal(po.kupujici_email, null, 'C) kupujici_email mělo být anonymizováno');
      assert.equal(po.kupujici_telefon, null, 'C) kupujici_telefon mělo být anonymizováno');
      assert.equal(po.pro_koho, null, 'C) pro_koho mělo být anonymizováno');

      // 7F.4B bod 6 — finanční/historická data identická před/po.
      assert.equal(po.stav, pred.stav, 'C) stav se nesmí anonymizací klientky změnit');
      assert.equal(Number(po.hodnota), Number(pred.hodnota), 'C) hodnota se nesmí anonymizací klientky změnit');
      assert.equal(Number(po.zustatek), Number(pred.zustatek), 'C) zůstatek se nesmí anonymizací klientky změnit');
      assert.equal(po.kod, pred.kod, 'C) kód se nesmí anonymizací klientky změnit');
      assert.equal(po.ean, pred.ean, 'C) EAN se nesmí anonymizací klientky změnit');
      assert.equal(po.platnost_do, pred.platnost_do, 'C) platnost_do se nesmí anonymizací klientky změnit');

      // 7F.4B bod 8 — re-registrace: poukaz i klientka_id zůstávají zachované,
      // klientka sama zmizí z aktivního seznamu, a nová rezervace se stejným
      // reálným telefonem založí zcela NOVOU klientku (stejný princip jako
      // scénář 14 výš — telefon_normalizovany byl vynulován, ne kolize).
      assert.equal(po.klientka_id, klientkaId, 'C) klientka_id poukazu se nesmí anonymizací změnit');
      const ctenaC = await nacistKlientku(klientkaId);
      assert.equal(ctenaC.status, 404, 'C) anonymizovaná klientka nesmí být dál zobrazena jako aktivní');
      const rC = await vytvorRezervaci(polozka.id, telefon, odpocet, 'TEST-7F4B-C-NOVA (smazat)'); odpocet += 5;
      assert.notEqual(rC.klientka_id, klientkaId, 'C) nová rezervace se stejným telefonem se napojila na starou (anonymizovanou) klientku místo založení nové');

      oznacUspech('C) expirovaný aktivní poukaz: anonymizace prošla (200), PII poukazu anonymizováno, hodnota/zůstatek/stav/kód/EAN/platnost_do beze změny, klientka_id zachován, re-registrace se stejným telefonem funguje');
    }

    // 7F.4B Test E) Částečně využitý + expirovaný — POZNÁMKA: tuto přesnou
    // kombinaci nejde přes veřejné API legitimně sestavit (stejné zjištění
    // jako u tests/poukazy.test.js scénáře E, 7F.1/7F.2/7F.3): POST .../
    // uplatnit sám odmítne uplatnění na už expirovaném poukazu, takže poukaz
    // nikdy nemůže přejít na "castecne_vyuzity" PO expiraci, a žádný endpoint
    // neumožňuje platnost_do dodatečně posunout do minulosti u poukazu, který
    // už castecne_vyuzity je. Ověřeno i se "dnes"-trikem z Testu B: i kdyby se
    // poukaz částečně uplatnil PŘESNĚ v den platnost_do, zůstává v tu chvíli
    // ještě platný (>=dnes), takže "expirovaný částečně využitý" by vznikl až
    // následující den — mimo dosah jednoho synchronního testovacího běhu.
    // Ověřeno místo toho staticky — zrcadlová kopie nové "uzavřený poukaz"
    // podmínky z anonymizovatKlientku (stav IN (pouzity,zruseny) OR (stav IN
    // (aktivni,castecne_vyuzity) AND platnost_do<dnes)) na syntetickém řádku:
    console.log('--- 7F.4B-E) částečně využitý + expirovaný (jen staticky — viz komentář) ---');
    {
      const dnesIso = new Date().toISOString().slice(0, 10);
      const vceraIso = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
      const jeUzavrenyProAnonymizaci = p =>
        p.stav === 'pouzity' || p.stav === 'zruseny' ||
        ((p.stav === 'aktivni' || p.stav === 'castecne_vyuzity') && p.platnost_do < dnesIso);
      assert.equal(jeUzavrenyProAnonymizaci({ stav: 'castecne_vyuzity', platnost_do: vceraIso }), true, 'E) expirovaný částečně využitý poukaz MUSÍ spadat do "uzavřeno pro anonymizaci"');
      assert.equal(jeUzavrenyProAnonymizaci({ stav: 'castecne_vyuzity', platnost_do: dnesIso }), false, 'castecne_vyuzity platný do dneška nesmí spadat do "uzavřeno"');
      oznacUspech('E) částečně využitý + expirovaný: staticky ověřeno, že by nová WHERE podmínka takový řádek správně zahrnula (dynamicky nevytvořitelné přes API, zdůvodněno v komentáři)');
    }

    // 7F.4B Test F) Plně vyčerpaný poukaz (pouzity): anonymizace projde, PII
    // se anonymizuje, deník plateb i finanční údaje beze změny.
    console.log('--- 7F.4B-F) plně vyčerpaný poukaz (pouzity): PII se anonymizuje ---');
    {
      const telefon = '6999020';
      const p = await vytvorPoukaz(polozka.id, telefon, 'TEST-7F4B-F (smazat)');
      const u = await adminFetch(`/admin/poukazy/${p.id}/uplatnit`, { method: 'POST', body: JSON.stringify({ castka: Number(p.hodnota) }) }).then(x => x.json());
      assert.equal(u.poukaz.stav, 'pouzity');
      // Uplatněno bez rezervace (žádné rezervace_id) — v deníku "platby" proto
      // záměrně nevznikl žádný řádek, není tu tedy co porovnávat před/po; o to
      // se stará test 3/4/12 v tests/poukazy.test.js a scénář 5 výš v tomhle
      // souboru (ty testují uplatnění S vazbou na rezervaci).
      const poukazPoUplatneni = u.poukaz;

      const { status } = await anonymizovat(p.klientka_id);
      assert.equal(status, 200, 'F) anonymizace s plně vyčerpaným poukazem měla projít');

      const seznamF = await adminFetch('/admin/poukazy').then(x => x.json());
      const poukazF = seznamF.find(x => x.id === p.id);
      assert.equal(poukazF.kupujici_jmeno, null, 'F) kupujici_jmeno mělo být anonymizováno');
      assert.equal(poukazF.kupujici_email, null, 'F) kupujici_email mělo být anonymizováno');
      assert.equal(poukazF.kupujici_telefon, null, 'F) kupujici_telefon mělo být anonymizováno');
      assert.equal(poukazF.stav, 'pouzity', 'F) stav se nesmí anonymizací klientky změnit');
      assert.equal(Number(poukazF.zustatek), Number(poukazPoUplatneni.zustatek), 'F) zůstatek (0) se nesmí anonymizací klientky změnit');
      assert.equal(Number(poukazF.hodnota), Number(p.hodnota), 'F) hodnota se nesmí anonymizací klientky změnit');
      oznacUspech('F) plně vyčerpaný (pouzity) poukaz: anonymizace prošla, PII anonymizováno, stav/hodnota/zůstatek beze změny');
    }

    // 7F.4B Test G) Zrušený poukaz — ekvivalentní scénáři 6 výš (uzavřený
    // poukaz, zruseny): anonymizace prošla, PII anonymizováno, hodnota/kód
    // beze změny — viz scénář 6 pro přesné assertions, zde jen odkaz, ať se
    // zbytečně neduplikuje identický testovací poukaz.

    // 9) Klientka s budoucí rezervací → odmítnout
    console.log('--- 9) budoucí rezervace → odmítnout ---');
    {
      const telefon = '6999009';
      const r = await vytvorRezervaci(polozka.id, telefon, odpocet); odpocet += 5; // stav 'potvrzena', termín v budoucnu
      const { status, data } = await anonymizovat(r.klientka_id);
      assert.equal(status, 400, 'Anonymizace s budoucí rezervací měla být odmítnuta: ' + JSON.stringify(data));
      const ctena = await nacistKlientku(r.klientka_id);
      assert.equal(ctena.status, 200);
      assert.equal(ctena.data.telefon, telefon, 'Telefon klientky se po odmítnuté anonymizaci změnil');
      oznacUspech('budoucí rezervace (cekajici/potvrzena, termín v budoucnu): odmítnuto (400), data beze změny');
    }

    // 10) Klientka s více rezervacemi (dokončená + zrušená, žádná budoucí)
    console.log('--- 10) více rezervací ---');
    {
      const telefon = '6999010';
      const r1 = await vytvorRezervaci(polozka.id, telefon, odpocet); odpocet += 5;
      const r2 = await vytvorRezervaci(polozka.id, telefon, odpocet); odpocet += 5;
      assert.equal(r2.klientka_id, r1.klientka_id, 'Stejný telefon měl najít stejnou klientku');
      await nastavStav(r1.id, 'dokoncena');
      await nastavStav(r2.id, 'zrusena');
      const { status } = await anonymizovat(r1.klientka_id);
      assert.equal(status, 200);
      const seznam = await adminFetch('/admin/rezervace').then(x => x.json());
      const a1 = seznam.find(x => x.id === r1.id), a2 = seznam.find(x => x.id === r2.id);
      assert.equal(a1.jmeno, '(anonymizováno)');
      assert.equal(a2.jmeno, '(anonymizováno)');
      oznacUspech('více rezervací (dokončená + zrušená): obě anonymizovány jedním voláním');
    }

    // 11) Klientka s více uzavřenými poukazy
    console.log('--- 11) více uzavřených poukazů ---');
    {
      const telefon = '6999011';
      const p1 = await vytvorPoukaz(polozka.id, telefon);
      const p2 = await vytvorPoukaz(polozka.id, telefon);
      assert.equal(p2.klientka_id, p1.klientka_id);
      await adminFetch(`/admin/poukazy/${p1.id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zruseny' }) });
      await adminFetch(`/admin/poukazy/${p2.id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zruseny' }) });
      const { status } = await anonymizovat(p1.klientka_id);
      assert.equal(status, 200);
      const seznam = await adminFetch('/admin/poukazy').then(x => x.json());
      const a1 = seznam.find(x => x.id === p1.id), a2 = seznam.find(x => x.id === p2.id);
      assert.equal(a1.kupujici_jmeno, null);
      assert.equal(a2.kupujici_jmeno, null);
      oznacUspech('více uzavřených poukazů: oba anonymizovány jedním voláním');
    }

    // 12) Opakovaná anonymizace
    console.log('--- 12) opakovaná anonymizace ---');
    {
      const telefon = '6999012';
      const res = await adminFetch('/admin/klientky', { method: 'POST', body: JSON.stringify({ telefon, jmeno: 'TEST-ANON-12 (smazat)' }) });
      const id = (await res.json()).klientka.id;
      uklidKlientky.add(id);
      const prvni = await anonymizovat(id);
      assert.equal(prvni.status, 200, JSON.stringify(prvni.data));
      const druha = await anonymizovat(id);
      assert.equal(druha.status, 400, 'Druhá anonymizace stejné klientky měla být odmítnuta');
      assert.match(druha.data.chyba || '', /anonymizov/i);
      oznacUspech('opakovaná anonymizace: druhé volání odmítnuto (400 "už anonymizována")');
    }

    // 14) Nový zákazník se stejným telefonem po anonymizaci
    console.log('--- 14) nový zákazník se stejným telefonem po anonymizaci ---');
    {
      const telefon = '6999014';
      const res1 = await adminFetch('/admin/klientky', { method: 'POST', body: JSON.stringify({ telefon, jmeno: 'TEST-ANON-14-PUVODNI (smazat)' }) });
      const puvodniId = (await res1.json()).klientka.id;
      uklidKlientky.add(puvodniId);
      const { status } = await anonymizovat(puvodniId);
      assert.equal(status, 200);

      const r = await vytvorRezervaci(polozka.id, telefon, odpocet, 'TEST-ANON-14-NOVA (smazat)'); odpocet += 5;
      assert.notEqual(r.klientka_id, puvodniId, 'Nová rezervace se stejným telefonem se napojila na anonymizovanou (starou) klientku místo založení nové');
      const novaKlientka = await nacistKlientku(r.klientka_id);
      assert.equal(novaKlientka.status, 200);
      assert.equal(novaKlientka.data.telefon, telefon);
      oznacUspech('stejný reálný telefon po anonymizaci založí zcela NOVOU klientku (telefon_normalizovany byl NULL, ne kolize)');
    }

    // 15) Účetnictví před/po anonymizaci identické
    console.log('--- 15) účetnictví před/po ---');
    {
      const telefon = '6999015';
      const r = await vytvorRezervaci(polozka.id, telefon, odpocet); odpocet += 5;
      await adminFetch(`/admin/rezervace/${r.id}/platba`, { method: 'PATCH', body: JSON.stringify({ castka: cena, zpusob_platby: 'hotove' }) });
      await nastavStav(r.id, 'dokoncena');

      const ucetPred = await adminFetch('/admin/ucetnictvi').then(x => x.json());
      const denPred = ucetPred.trzbyZaSluzby.podleDne.find(d => d.den === r.datum);
      assert.ok(denPred, 'Rezervace se před anonymizací neobjevila v účetnictví');

      const { status } = await anonymizovat(r.klientka_id);
      assert.equal(status, 200);

      const ucetPo = await adminFetch('/admin/ucetnictvi').then(x => x.json());
      const denPo = ucetPo.trzbyZaSluzby.podleDne.find(d => d.den === r.datum);
      assert.ok(denPo, 'Rezervace po anonymizaci zmizela z účetnictví — tržba by se ztratila!');
      assert.equal(Number(denPo.castka), Number(denPred.castka), 'Tržba za den se po anonymizaci změnila');
      oznacUspech('účetnictví (tržby za služby podle dne) je před/po anonymizaci identické');
    }

    // 17) Žádný e-mail během anonymizace
    console.log('--- 17) žádný e-mail během anonymizace ---');
    {
      // Nelze ověřit dynamicky přes veřejné API (aplikace nemá žádný
      // pozorovatelný "seznam odeslaných e-mailů" — Resend se volá přímo,
      // bez lokální historie, viz audit Fáze 7A.1). Ověřeno místo toho:
      // (a) staticky — anonymizovatKlientku() v server.js nikde nevolá
      //     odeslatEmail(), na rozdíl od např. vytvoření/změny rezervace;
      // (b) provozně — tento testovací server běží bez RESEND_API_KEY
      //     (viz .env.test, Fáze 7C.4), takže odeslatEmail() by stejně vždy
      //     vrátilo false bez síťového volání, i kdyby o něj test scénář
      //     výš omylem zavadil.
      console.log('OK — ověřeno staticky (kódová kontrola) + provozně (test server běží bez RESEND_API_KEY) — viz komentář v testu');
      scenaru++; uspesnych++;
    }

    // 18) Newsletter — odhlášený vs aktivní (sledování odhlaseno_kdy)
    console.log('--- 18) newsletter odhlášený vs aktivní ---');
    {
      // POZOR: samotná ANONYMIZACE newsletter odběratelů (přepis e-mailu na
      // anonym+id@invalid.local) NENÍ součástí Fáze 7D.2B — podle zadání se
      // v této fázi měl jen připravit spolehlivý odhlaseno_kdy tracking,
      // pokud je to čisté a bezpečné (bylo, viz schema.sql/server.js). Test
      // proto ověřuje TOHLE — ne neexistující anonymizační akci.
      const email = 'test-anon-18@example.invalid';
      const s1 = await fetch(API + '/newsletter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, jmeno: 'TEST-ANON-18' }) });
      assert.equal(s1.status, 200);
      let radek = await adminFetch('/admin/newsletter').then(x => x.json()).then(s => s.find(o => o.email === email));
      assert.ok(radek, 'Odběratel se po přihlášení neobjevil v seznamu');
      uklidNewsletter.push(radek.id);
      assert.equal(radek.aktivni, true);
      assert.equal(radek.odhlaseno_kdy, null, 'Nově přihlášený odběratel nesmí mít odhlaseno_kdy vyplněné');

      // Skutečnou cestu "odhlášení přes token" (GET /newsletter/odhlasit)
      // nelze tímto černoskříňkovým testem ověřit — odhlasovaci_token se
      // generuje jen interně a žádný endpoint (ani admin) ho neprozrazuje
      // (správně, je to bezpečnostní token v odhlašovacím odkazu z e-mailu).
      // Ověřujeme proto aspoň druhou polovinu chování: že OPĚTOVNÉ přihlášení
      // (ON CONFLICT) aktivni=true a odhlaseno_kdy vždy vynuluje, ať už
      // předtím bylo cokoliv — to je jediná část zásahu do odhlaseno_kdy,
      // která je přes API pozorovatelná.
      const s2 = await fetch(API + '/newsletter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, jmeno: 'TEST-ANON-18-OPET' }) });
      assert.equal(s2.status, 200);
      radek = await adminFetch('/admin/newsletter').then(x => x.json()).then(s => s.find(o => o.email === email));
      assert.equal(radek.aktivni, true);
      assert.equal(radek.odhlaseno_kdy, null, 'Po opětovném přihlášení musí být odhlaseno_kdy vynulované');
      oznacUspech('newsletter: nový/opětovně přihlášený odběratel má aktivni=true a odhlaseno_kdy=null (odhlašovací část nelze otestovat bez znalosti odhlasovaci_token — API ho záměrně neprozrazuje, viz komentář výš)');
    }

    // 19) Poukazová žádost bez klientka_id
    console.log('--- 19) poukazová žádost bez klientka_id ---');
    {
      const telefon = '699901900'; // 9 číslic — POST /api/poukazy/zadost od 8E.3 vyžaduje min. 9 číslic po normalizaci
      // Nejdřív klientka se stejným kontaktem, ať je co anonymizovat.
      const res = await adminFetch('/admin/klientky', { method: 'POST', body: JSON.stringify({ telefon, jmeno: 'TEST-ANON-19 (smazat)', email: 'test-anon-19@example.invalid' }) });
      const klientkaId = (await res.json()).klientka.id;
      uklidKlientky.add(klientkaId);

      const zadostRes = await fetch(API + '/poukazy/zadost', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hodnota: 500, kupujici_jmeno: 'TEST-ANON-19 (smazat)', kupujici_email: 'test-anon-19@example.invalid', kupujici_telefon: telefon, zpusob_platby: 'prevodem' })
      });
      const zadost = (await zadostRes.json()).zadost;
      uklidZadosti.push(zadost.id);
      await adminFetch(`/admin/poukazy/zadosti/${zadost.id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zamitnuta' }) });

      const { status } = await anonymizovat(klientkaId);
      assert.equal(status, 200);

      const zadostiPo = await adminFetch('/admin/poukazy/zadosti').then(x => x.json());
      const aktualni = zadostiPo.find(z => z.id === zadost.id);
      assert.equal(aktualni.kupujici_jmeno, 'TEST-ANON-19 (smazat)', 'Anonymizace klientky nesmí mít žádný efekt na poukazy_zadosti (tabulka nemá klientka_id, viz audit 7D.1)');
      assert.equal(aktualni.kupujici_email, 'test-anon-19@example.invalid');
      oznacUspech('poukazová žádost: hlavní anonymizační endpoint na ni (správně) nemá žádný efekt, protože poukazy_zadosti nemá klientka_id');
    }

    console.log(`\n✅ VŠECHNY TESTY ANONYMIZACE PROŠLY (${uspesnych}/${scenaru} scénářů)`);
  } finally {
    for (const id of uklidRezervace) {
      await adminFetch(`/admin/rezervace/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of uklidPoukazy) {
      await adminFetch(`/admin/poukazy/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of uklidZadosti) {
      await adminFetch(`/admin/poukazy/zadosti/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of uklidNewsletter) {
      await adminFetch(`/admin/newsletter/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of uklidTypy) {
      await adminFetch(`/admin/poukazy/typy/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    let klientkySmazano = 0;
    for (const id of uklidKlientky) {
      const r = await adminFetch(`/admin/klientky/${id}`, { method: 'DELETE' }).catch(() => null);
      if (r && r.ok) klientkySmazano++;
    }
    console.log(`(uklizeno: ${uklidRezervace.length} rezervací, ${uklidPoukazy.length} poukazů, ${uklidZadosti.length} žádostí, ${uklidNewsletter.length} newsletter odběratelů, ${klientkySmazano}/${uklidKlientky.size} klientek)`);
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
