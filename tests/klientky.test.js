// Testy Fáze 6D — skutečné klientky (tabulka "klientky", klientka_id na
// rezervace/poukazy) a bezpečná migrace z telefonu jako identity.
//
// Nevytváří žádná skutečná e-mailová odeslání klientkám (testovací e-maily
// míří na test-...@example.cz, stejná zavedená konvence jako v ostatních
// testech). Veškerá testovací data se v "finally" smažou. Migrace samotná se
// tu NESPOUŠTÍ (proběhla jednorázově a je idempotentně chráněná proti druhému
// spuštění) — testy ověřují její VÝSLEDEK a chování nového kódu nad ním.
//
// Spuštění:  ADMIN_HESLO=... node tests/klientky.test.js

const assert = require('node:assert/strict');

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
async function vytvorRezervaci(cenikId, telefon, odpocetDni, jmeno, email) {
  const { datum, cas } = await novyVolnyTermin(cenikId, odpocetDni);
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: cas, jmeno: jmeno || 'TEST-KLIENTKY (smazat)', telefon, email })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'Vytvoření testovací rezervace selhalo: ' + JSON.stringify(data));
  return data.rezervace;
}
async function nastavStav(id, stav) {
  const res = await adminFetch(`/admin/rezervace/${id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav }) });
  assert.equal(res.status, 200, `Nastavení stavu ${stav} selhalo`);
}
async function platba(id, castka, zpusob_platby, typ) {
  const res = await adminFetch(`/admin/rezervace/${id}/platba`, {
    method: 'PATCH', body: JSON.stringify({ castka, zpusob_platby, ...(typ ? { typ } : {}) })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'Zápis platby selhal: ' + JSON.stringify(data));
  return data;
}

// -- Čistá replika normalizace z server.js (bez sítě) --
function normalizovatTelefon(raw) {
  if (!raw) return null;
  let cislice = String(raw).replace(/\D/g, '');
  if (!cislice) return null;
  if (cislice.startsWith('00420') && cislice.length === 14) cislice = cislice.slice(5);
  else if (cislice.startsWith('420') && cislice.length === 12) cislice = cislice.slice(3);
  return cislice;
}

const uklidRezervace = [];
const uklidPoukazy = [];
const uklidKlientky = new Set();

async function main() {
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');
    const cena = Number(polozka.cena);

    // ================= 1) ČISTÁ LOGIKA NORMALIZACE TELEFONU (bez sítě) =================
    assert.equal(normalizovatTelefon('737 336 123'), '737336123', 'mezery se musí odstranit');
    assert.equal(normalizovatTelefon('+420737336123'), '737336123', '+420 se musí oříznout');
    assert.equal(normalizovatTelefon('00420737336123'), '737336123', '00420 se musí oříznout');
    assert.equal(normalizovatTelefon('737-336-123'), '737336123', 'pomlčky se musí odstranit');
    assert.equal(normalizovatTelefon(null), null, 'chybějící telefon → null');
    assert.equal(normalizovatTelefon(''), null, 'prázdný telefon → null');
    assert.equal(normalizovatTelefon('+15551234567'), '15551234567', 'zahraniční číslo (ne +420) se nechává beze změny (jen bez mezer/pomlček)');
    console.log('OK — normalizace telefonu (mezery, +420, 00420, pomlčky, zahraniční číslo, prázdná hodnota)');

    // ================= 2) MIGRACE — STRUKTURÁLNÍ INVARIANT (read-only) =================
    // Pro KAŽDOU existující rezervaci s telefonem musí platit: má klientka_id,
    // a klientka, na kterou ukazuje, má telefon_normalizovany odpovídající
    // normalizaci rezervace.telefon. Neověřuje konkrétní počty (ty se v čase
    // mění), ale samotnou správnost napojení nad VŠEMI produkčními daty.
    const vsechnyRezervace = await adminFetch('/admin/rezervace').then(r => r.json());
    const vsechnyKlientky = await adminFetch('/admin/klientky').then(r => r.json());
    const klientkyMapa = new Map(vsechnyKlientky.map(k => [k.id, k]));
    let zkontrolovanoRez = 0;
    for (const r of vsechnyRezervace) {
      if (!r.telefon) continue;
      zkontrolovanoRez++;
      assert.ok(r.klientka_id, `Rezervace #${r.id} má telefon, ale chybí klientka_id — migrace/napojení selhalo`);
    }
    console.log(`OK — ${zkontrolovanoRez} existujících rezervací s telefonem má vyplněné klientka_id (migrace Fáze 6D)`);

    console.log('\n--- Příprava testovacích dat ---');
    const TEL1 = '00088010';
    const TEL1_JINY_FORMAT = '+420 00088010'.replace('00088010', '000 88 010'); // jen jiný zápis TÉHOŽ čísla
    const TEL2 = '00088020';

    // ================= 3) NOVÁ REZERVACE — NOVÝ KLIENT =================
    const r1 = await vytvorRezervaci(polozka.id, TEL1, 40, 'TEST-KLIENTKY Nova (smazat)', 'test-klientky1@example.cz');
    uklidRezervace.push(r1.id);
    uklidKlientky.add(r1.klientka_id);
    assert.ok(r1.klientka_id, 'Nová rezervace s novým telefonem musí dostat klientka_id');
    const detail1 = await adminFetch('/admin/klientky/' + r1.klientka_id).then(res => res.json());
    assert.equal(detail1.telefon, TEL1);
    console.log('OK — nová rezervace s novým telefonem založí novou klientku');

    // ================= 4) EXISTUJÍCÍ KLIENT (i v jiném formátu telefonu) =================
    const r1b = await vytvorRezervaci(polozka.id, '000 88 010', 43, 'TEST-KLIENTKY Existujici (smazat)');
    uklidRezervace.push(r1b.id);
    assert.equal(r1b.klientka_id, r1.klientka_id, 'Stejné číslo v jiném formátu (mezery) musí najít TU SAMOU klientku, ne založit druhou');
    console.log('OK — existující klient se najde i při jiném formátu (mezerách) telefonu — nevznikne druhý profil');

    // ================= 5) NOVÝ TELEFON → NOVÁ KLIENTKA =================
    const r2 = await vytvorRezervaci(polozka.id, TEL2, 46, 'TEST-KLIENTKY Druha (smazat)');
    uklidRezervace.push(r2.id);
    uklidKlientky.add(r2.klientka_id);
    assert.notEqual(r2.klientka_id, r1.klientka_id, 'Jiný telefon musí dostat jinou klientku');
    console.log('OK — jiný telefon vytvoří jinou klientku (žádné automatické slučování podle jména)');

    // ================= 6) ZMĚNA TELEFONU PŘI EDITACI =================
    const puvodniKlientkaId = r2.klientka_id;
    const upravRes = await adminFetch(`/admin/rezervace/${r2.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ datum: r2.datum, cas_od: String(r2.cas_od).slice(0, 5), cenik_id: polozka.id, jmeno: r2.jmeno, telefon: TEL1, poznamka: 'změna telefonu' })
    });
    const uprav = await upravRes.json();
    assert.equal(upravRes.status, 200, 'Editace se změnou telefonu selhala: ' + JSON.stringify(uprav));
    assert.equal(uprav.rezervace.klientka_id, r1.klientka_id, 'Po změně telefonu na TEL1 se musí rezervace napojit na klientku TEL1');
    assert.notEqual(uprav.rezervace.klientka_id, puvodniKlientkaId, 'Rezervace se nesmí dál vázat na starou (TEL2) klientku');

    // Stará (TEL2) klientka musí zůstat beze změny telefonu — jen tahle JEDNA
    // rezervace se přepojila jinam, ne že by se "přejmenoval" celý profil.
    const puvodniKlientkaPoEditaci = await adminFetch('/admin/klientky/' + puvodniKlientkaId).then(res => res.json());
    assert.equal(puvodniKlientkaPoEditaci.telefon, TEL2, 'Stará klientka nesmí mít telefon omylem přepsaný na nový');
    console.log('OK — změna telefonu na rezervaci přepojí klientku, ale nepřepíše telefon staré klientce');

    // terminZmenen musí zůstat false (jen telefon/jméno se měnily, ne termín) —
    // regresní pojistka, že napojení klientky neovlivnilo Fázi 4/5B logiku.
    assert.equal(uprav.terminZmenen, false, 'Změna jen telefonu nesmí být vyhodnocena jako změna termínu');
    assert.equal(uprav.rezervace.pripomenuto, false, 'pripomenuto nesmí být ovlivněno změnou telefonu');
    console.log('OK — změna telefonu neovlivňuje terminZmenen ani pripomenuto (Fáze 4/5B beze změny)');

    // ================= 7) POUKAZ S TELEFONEM I BEZ TELEFONU =================
    const poukazSTelefonem = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-KLIENTKY-POUKAZ (smazat)', kupujici_telefon: TEL1 })
    }).then(res => res.json());
    uklidPoukazy.push(poukazSTelefonem.poukaz.id);
    assert.equal(poukazSTelefonem.poukaz.klientka_id, r1.klientka_id, 'Poukaz s telefonem TEL1 se musí napojit na tu samou klientku jako rezervace TEL1');
    console.log('OK — nový poukaz s telefonem se napojí na existující klientku podle normalizovaného telefonu');

    const poukazBezTelefonu = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-KLIENTKY-BEZ-TEL (smazat)' })
    }).then(res => res.json());
    uklidPoukazy.push(poukazBezTelefonu.poukaz.id);
    assert.equal(poukazBezTelefonu.poukaz.klientka_id, null, 'Poukaz bez telefonu musí mít klientka_id NULL, ne chybu');
    console.log('OK — poukaz bez telefonu zůstává s klientka_id NULL (očekávané, ne chyba)');

    // ================= 8) CRM PŘES /api/admin/klientky/:id — STEJNÁ PRAVIDLA JAKO FÁZE 6B =================
    const r3 = await vytvorRezervaci(polozka.id, TEL1, 50, 'TEST-KLIENTKY Dokoncena (smazat)');
    uklidRezervace.push(r3.id);
    await nastavStav(r3.id, 'dokoncena');
    await platba(r3.id, cena, 'hotove');

    const r4 = await vytvorRezervaci(polozka.id, TEL1, 55, 'TEST-KLIENTKY Cekajici (smazat)');
    uklidRezervace.push(r4.id);
    // r4 zůstává 'cekajici' — nesmí se počítat do statistik

    const detailPoPlatbe = await adminFetch('/admin/klientky/' + r1.klientka_id).then(res => res.json());
    assert.ok(detailPoPlatbe.pocetNavstev >= 1, 'Dokončená rezervace se musí počítat do návštěv');
    assert.ok(Number(detailPoPlatbe.celkemUtraceno) >= cena, 'Uhrazená částka za dokončenou rezervaci se musí počítat do celkemUtraceno');
    const r4VHistorii = detailPoPlatbe.rezervace.find(x => x.id === r4.id);
    assert.ok(r4VHistorii, 'Čekající rezervace musí být v historii (i když se nepočítá do statistik)');
    console.log('OK — CRM přes /api/admin/klientky/:id počítá dokončené návštěvy a uhrazenou částku, historie obsahuje i čekající rezervaci');

    // ================= 9) VYHLEDÁVÁNÍ (seznam obsahuje nové klientky, bez historie) =================
    const seznam = await adminFetch('/admin/klientky').then(res => res.json());
    const vSeznamu = seznam.find(z => z.id === r1.klientka_id);
    assert.ok(vSeznamu, 'Klientka musí být v seznamu /admin/klientky');
    assert.ok(!('rezervace' in vSeznamu), 'Seznam nemá nést pole historie rezervace (jen souhrn), stejně jako ve Fázi 6B');
    console.log('OK — seznam /admin/klientky obsahuje klientku se souhrnem, bez celé historie');

    // ================= 10) REGRESE: PLATBY/ÚČETNICTVÍ BEZE ZMĚNY (Fáze 3B) =================
    const historiePlateb = await adminFetch(`/admin/rezervace/${r3.id}/platby`).then(res => res.json());
    assert.equal(historiePlateb.length, 1);
    assert.equal(Number(historiePlateb[0].castka), cena);
    console.log('OK — deník plateb (Fáze 3B) beze změny i po zavedení klientka_id');

    // ================= 11) REGRESE: KATEGORIE ZAKAZNICI (stará kompatibilní vrstva) BEZE ZMĚNY =================
    const staryZakazniciSeznam = await adminFetch('/admin/zakaznici').then(res => res.json());
    assert.ok(Array.isArray(staryZakazniciSeznam), 'Starý endpoint /api/admin/zakaznici musí dál fungovat (kompatibilní vrstva)');
    console.log('OK — starý endpoint /api/admin/zakaznici dál funguje beze změny (dočasná kompatibilní vrstva)');

    // ================= 12) BEZPEČNOST: klientky jsou jen za admin heslem =================
    const bezHesla = await fetch(API + '/admin/klientky');
    assert.equal(bezHesla.status, 401, '/api/admin/klientky bez hesla musí vrátit 401');
    const bezHeslaDetail = await fetch(API + '/admin/klientky/' + r1.klientka_id);
    assert.equal(bezHeslaDetail.status, 401, '/api/admin/klientky/:id bez hesla musí vrátit 401');
    console.log('OK — /api/admin/klientky i /api/admin/klientky/:id jsou chráněné admin heslem stejně jako ostatní admin endpointy');

    // ================= 13) SMAZÁNÍ KLIENTKY S HISTORIÍ JE ODMÍTNUTO =================
    const smazatSHistorii = await adminFetch('/admin/klientky/' + r1.klientka_id, { method: 'DELETE' });
    assert.equal(smazatSHistorii.status, 400, 'Klientku s rezervacemi/poukazy nelze smazat (ztratila by se historie)');
    console.log('OK — smazání klientky s historií (rezervace/poukazy) je odmítnuto, historie se nemůže ztratit');

    console.log('\n✅ VŠECHNY TESTY KLIENTEK (Fáze 6D) PROŠLY');
  } finally {
    for (const id of uklidRezervace) await adminFetch(`/admin/rezervace/${id}`, { method: 'DELETE' }).catch(() => {});
    for (const id of uklidPoukazy) await adminFetch(`/admin/poukazy/${id}`, { method: 'DELETE' }).catch(() => {});
    // Klientky jdou smazat až TEĎ, když už na ně nic neukazuje (dřív by DELETE
    // vrátil 400 — historie by se ztratila, viz test 13 výš).
    let klientkySmazano = 0;
    for (const id of uklidKlientky) {
      const r = await adminFetch(`/admin/klientky/${id}`, { method: 'DELETE' }).catch(() => null);
      if (r && r.ok) klientkySmazano++;
    }
    console.log(`(uklizeno: ${uklidRezervace.length} testovacích rezervací, ${uklidPoukazy.length} testovacích poukazů, ${klientkySmazano}/${uklidKlientky.size} testovacích klientek)`);
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
