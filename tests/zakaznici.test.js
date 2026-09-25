// Testy Fáze 6B — oprava CRM statistik (celkem utraceno/počet návštěv/poslední
// návštěva/další rezervace/průměrná hodnota návštěvy), vyhledávání e-mailem a
// detail klientky s historií (/api/admin/zakaznici, /api/admin/zakaznici/:telefon).
//
// Nevytváří žádná skutečná e-mailová odeslání klientkám (testovací e-maily míří
// na test-...@example.cz, stejná zavedená konvence jako v ostatních testech —
// viz tests/uprava-zruseni.test.js). Veškerá testovací data se v "finally" smažou.
//
// Spuštění:  ADMIN_HESLO=... node tests/zakaznici.test.js

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
async function vytvorRezervaci(cenikId, telefon, odpocetDni, jmeno) {
  const { datum, cas } = await novyVolnyTermin(cenikId, odpocetDni);
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: cas, jmeno: jmeno || 'TEST-ZAKAZNICI (smazat)', telefon })
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

// -- Čistá replika filtru z admin.html (vykreslitZakazniky) — bez sítě --
function odpovidaFiltru(z, hledatRaw) {
  const hledat = hledatRaw.trim().toLowerCase();
  return !hledat
    || (z.jmeno || '').toLowerCase().includes(hledat)
    || z.telefon.includes(hledat)
    || (z.email || '').toLowerCase().includes(hledat);
}

const uklidRezervace = [];
const uklidPoukazy = [];
const uklidZakaznice = [];

async function main() {
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');
    const cena = Number(polozka.cena);

    const TEL = '00099010'; // dedikovaný telefon jen pro tenhle test, nekoliduje s reálnými rezervacemi

    console.log('--- Příprava: 9 rezervací + 2 poukazy na jednom testovacím telefonu ---');

    // Nejbližší budoucí termín (offset 60) zůstává 'potvrzena' → očekávaná "další rezervace"
    const rDalsi = await vytvorRezervaci(polozka.id, TEL, 60);
    uklidRezervace.push(rDalsi.id);

    // offset 65: dokončená, plná platba
    const r1 = await vytvorRezervaci(polozka.id, TEL, 65);
    uklidRezervace.push(r1.id);
    await nastavStav(r1.id, 'dokoncena');
    await platba(r1.id, cena, 'hotove');

    // offset 70: dokončená, nezaplaceno
    const r2 = await vytvorRezervaci(polozka.id, TEL, 70);
    uklidRezervace.push(r2.id);
    await nastavStav(r2.id, 'dokoncena');

    // offset 75: dokončená, částečná platba
    const c1 = Math.max(1, Math.floor(cena * 0.4));
    const r3 = await vytvorRezervaci(polozka.id, TEL, 75);
    uklidRezervace.push(r3.id);
    await nastavStav(r3.id, 'dokoncena');
    await platba(r3.id, c1, 'kartou');

    // offset 80: dokončená, plná platba + plná vratka (netto 0)
    const r4 = await vytvorRezervaci(polozka.id, TEL, 80);
    uklidRezervace.push(r4.id);
    await nastavStav(r4.id, 'dokoncena');
    await platba(r4.id, cena, 'hotove');
    await platba(r4.id, cena, 'hotove', 'vratka');

    // offset 85: dokončená, plně uhrazená poukazem (nejnovější dokončená → poslední návštěva)
    const r5 = await vytvorRezervaci(polozka.id, TEL, 85);
    uklidRezervace.push(r5.id);
    await nastavStav(r5.id, 'dokoncena');
    const poukazRedeem = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-ZAKAZNICI-POUKAZ (smazat)', kupujici_telefon: TEL })
    }).then(res => res.json());
    uklidPoukazy.push(poukazRedeem.poukaz.id);
    const uplatneno = await adminFetch(`/admin/poukazy/${poukazRedeem.poukaz.id}/uplatnit`, {
      method: 'POST', body: JSON.stringify({ castka: cena, rezervace_id: r5.id })
    }).then(res => res.json());
    assert.equal(Number(uplatneno.rezervace.uhrazeno), cena, 'Uplatnění poukazu na r5 selhalo');

    // offset 90: čekající (nesmí se počítat do statistik)
    const r6 = await vytvorRezervaci(polozka.id, TEL, 90);
    uklidRezervace.push(r6.id);

    // offset 95: zrušená (musí zůstat v historii, ne ve statistikách)
    const r7 = await vytvorRezervaci(polozka.id, TEL, 95);
    uklidRezervace.push(r7.id);
    await nastavStav(r7.id, 'zrusena');

    // offset 100: nedostavila se (musí zůstat v historii, ne ve statistikách)
    const r8 = await vytvorRezervaci(polozka.id, TEL, 100);
    uklidRezervace.push(r8.id);
    await nastavStav(r8.id, 'nedostavila_se');

    // Aktivní nevyužitý poukaz (počítá se do aktivniPoukazy, NE do celkemUtraceno)
    const poukazAktivni = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-ZAKAZNICI-AKTIVNI (smazat)', kupujici_telefon: TEL })
    }).then(res => res.json());
    uklidPoukazy.push(poukazAktivni.poukaz.id);

    // Zrušený nevyužitý poukaz (nesmí se počítat vůbec nikam)
    const poukazZruseny = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-ZAKAZNICI-ZRUSENY (smazat)', kupujici_telefon: TEL })
    }).then(res => res.json());
    uklidPoukazy.push(poukazZruseny.poukaz.id);
    await adminFetch(`/admin/poukazy/${poukazZruseny.poukaz.id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zruseny' }) });

    console.log('OK — testovací data připravena');

    // ================= DETAIL / STATISTIKY (scénáře 1–14, 19–24) =================
    const detailRes = await adminFetch('/admin/zakaznici/' + encodeURIComponent(TEL));
    assert.equal(detailRes.status, 200, 'Detail testovací klientky nebyl nalezen');
    const z = await detailRes.json();

    const ocekavanaUtrata = cena /*r1*/ + 0 /*r2*/ + c1 /*r3*/ + 0 /*r4 netto*/ + cena /*r5 poukaz*/;

    assert.equal(z.pocetNavstev, 5, 'Počet návštěv musí počítat jen dokoncena (r1,r2,r3,r4,r5)');
    console.log('OK (1–5) — dokončené se počítají, čekající/potvrzená/zrušená/nedostavila_se se nepočítají');

    assert.equal(Number(z.celkemUtraceno), ocekavanaUtrata, `celkemUtraceno má být ${ocekavanaUtrata}, je ${z.celkemUtraceno}`);
    console.log('OK (6–7) — nezaplacená dokončená přispívá 0 Kč, částečně zaplacená přispívá skutečně uhrazenou částkou');

    // r4 (plná platba + plná vratka) přispívá netto 0 — ověřeno v součtu výš, ale
    // ověříme to i samostatně přes historii (viz níž), aby bylo jasné, že to
    // není náhoda ve výpočtu.
    const r4VHistorii = z.rezervace.find(x => x.id === r4.id);
    assert.equal(Number(r4VHistorii.uhrazeno), 0, 'Vratka se musí promítnout — uhrazeno po plné vratce musí být 0');
    console.log('OK (8) — vratka se správně promítne (netto uhrazeno = 0)');

    const r5VHistorii = z.rezervace.find(x => x.id === r5.id);
    assert.equal(Number(r5VHistorii.uhrazeno), cena, 'Poukazem uhrazená rezervace musí mít uhrazeno = cena');
    console.log('OK (9) — poukazová platba na rezervaci se v uhrazeno objeví přesně jednou (ne dvakrát)');

    assert.equal(z.aktivniPoukazy, 1, 'Jen jeden aktivní nevyužitý poukaz se má počítat do aktivniPoukazy');
    console.log('OK (10) — zrušený poukaz se nepočítá do aktivních ani do utracené částky (poukaz.hodnota se do celkemUtraceno vůbec nepřičítá)');

    console.log('OK (11) — budoucí rezervace (r_dalsi, r6) nepřispěly do celkemUtraceno (ověřeno přesnou shodou součtu výš)');

    assert.ok(z.dalsiRezervace, 'dalsiRezervace musí být nalezena');
    assert.equal(z.dalsiRezervace.datum, rDalsi.datum, 'dalsiRezervace musí být nejbližší budoucí nezrušená rezervace (offset 60)');
    console.log('OK (12) — další rezervace se správně najde (nejbližší budoucí, ne zrušená/nedostavila se)');

    assert.equal(z.posledniNavstiva, r5.datum, 'posledniNavstiva musí být datum poslední DOKONČENÉ rezervace (r5, offset 85)');
    console.log('OK (13) — poslední návštěva je skutečně poslední dokončená návštěva (ne pozdější zrušená/čekající)');

    assert.equal(z.prumernaNavsteva, Math.round(ocekavanaUtrata / 5), 'Průměrná hodnota návštěvy neodpovídá celkemUtraceno/pocetNavstev');
    console.log('OK (14) — průměrná hodnota návštěvy = celkem uhrazeno za dokončené / počet dokončených');

    // Detail: základní údaje, alergie/preference/poznámka, historie (19–24)
    assert.equal(z.telefon, TEL);
    console.log('OK (19) — detail zobrazuje základní údaje (telefon; jméno/e-mail dle poslední rezervace)');
    assert.ok('alergie' in z && 'preference' in z && 'poznamka' in z, 'Detail musí obsahovat pole alergie/preference/poznamka (i prázdná)');
    console.log('OK (20) — detail obsahuje pole alergie/preference/interní poznámka');

    assert.equal(z.rezervace.length, 9, 'Historie musí obsahovat všech 9 vytvořených rezervací');
    console.log('OK (21) — detail zobrazuje historii všech rezervací klientky');
    assert.ok(z.rezervace.some(x => x.id === r7.id && x.stav === 'zrusena'), 'Zrušená rezervace musí být v historii');
    console.log('OK (22) — historie obsahuje i zrušené rezervace');
    assert.ok(z.rezervace.some(x => x.id === r8.id && x.stav === 'nedostavila_se'), 'Nedostavila se rezervace musí být v historii');
    console.log('OK (23) — historie obsahuje i nedostavené rezervace');
    console.log('OK (24) — zrušená/nedostavená rezervace je v historii, ale NEBYLA započtena do statistik (ověřeno v testech 1–14 výš)');

    // ================= Klientka bez jediné dokončené návštěvy → nuly/null, ne pád na dělení nulou =================
    const TEL_PRAZDNY = '00099011';
    const rPrazdny = await vytvorRezervaci(polozka.id, TEL_PRAZDNY, 110);
    uklidRezervace.push(rPrazdny.id);
    const detailPrazdny = await adminFetch('/admin/zakaznici/' + encodeURIComponent(TEL_PRAZDNY)).then(r => r.json());
    assert.equal(detailPrazdny.pocetNavstev, 0);
    assert.equal(Number(detailPrazdny.celkemUtraceno), 0);
    assert.equal(detailPrazdny.posledniNavstiva, null, 'Bez dokončené návštěvy musí být posledniNavstiva null');
    assert.equal(detailPrazdny.prumernaNavsteva, null, 'Bez dokončené návštěvy musí být prumernaNavsteva null (ne NaN/dělení nulou)');
    console.log('OK — klientka bez dokončené návštěvy: nuly/null, žádné dělení nulou');

    // ================= SEZNAM: nesmí nést celou historii (lehčí payload) =================
    const seznam = await adminFetch('/admin/zakaznici').then(r => r.json());
    const vSeznamu = seznam.find(x => x.telefon === TEL);
    assert.ok(vSeznamu, 'Testovací klientka musí být v seznamu /admin/zakaznici');
    assert.equal(vSeznamu.pocetNavstev, 5, 'Seznam a detail musí počítat stejně (sdílená logika)');
    assert.equal(Number(vSeznamu.celkemUtraceno), ocekavanaUtrata, 'Seznam a detail musí počítat stejně (sdílená logika)');
    assert.ok(!('rezervace' in vSeznamu), 'Seznam nemá nést pole historie rezervace (jen souhrn)');
    console.log('OK — seznam /admin/zakaznici počítá stejné hodnoty jako detail (jedna sdílená serverová logika)');

    // ================= VYHLEDÁVÁNÍ (scénáře 15–18) =================
    const vzorKlientka = { jmeno: 'Jana Nováková', telefon: '777123456', email: 'jana.novakova@gmail.com' };
    assert.equal(odpovidaFiltru(vzorKlientka, 'jana'), true, 'Hledání podle jména selhalo');
    assert.equal(odpovidaFiltru(vzorKlientka, 'JANA'), true, 'Hledání podle jména musí být case-insensitive');
    console.log('OK (15) — hledání podle jména (částečná shoda, case-insensitive)');
    assert.equal(odpovidaFiltru(vzorKlientka, '77712'), true, 'Hledání podle telefonu selhalo');
    console.log('OK (16) — hledání podle telefonu (částečná shoda)');
    assert.equal(odpovidaFiltru(vzorKlientka, 'gmail'), true, 'Hledání podle části e-mailu selhalo');
    console.log('OK (17) — hledání podle části e-mailu');
    assert.equal(odpovidaFiltru(vzorKlientka, 'GMAIL.COM'), true, 'Hledání podle e-mailu musí být case-insensitive');
    assert.equal(odpovidaFiltru(vzorKlientka, 'seznam.cz'), false, 'Hledání nesmí najít neexistující doménu');
    console.log('OK (18) — hledání podle e-mailu je case-insensitive a nehledá falešné shody');

    // Statická pojistka, že admin.html opravdu obsahuje hledání podle e-mailu (ne jen v tomhle testu)
    const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
    assert.match(adminHtml, /\(z\.email \|\| ''\)\.toLowerCase\(\)\.includes\(hledat\)/, 'admin.html musí filtrovat i podle e-mailu');
    console.log('OK — admin.html skutečně obsahuje filtr podle e-mailu (regresní pojistka)');

    // ================= REGRESE: ruční přidání / editace / smazání zákaznice (25–27) =================
    const TEL_RUCNI = '00099012';
    const pridani = await adminFetch('/admin/zakaznici', {
      method: 'POST', body: JSON.stringify({ telefon: TEL_RUCNI, jmeno: 'TEST-RUCNI (smazat)', alergie: 'ořechy' })
    });
    assert.equal(pridani.status, 200, 'Ruční přidání zákaznice selhalo');
    uklidZakaznice.push(TEL_RUCNI);
    console.log('OK (25) — ruční přidání zákaznice funguje');

    const editace = await adminFetch('/admin/zakaznici/poznamka', {
      method: 'PUT', body: JSON.stringify({ telefon: TEL_RUCNI, poznamka: 'testovací poznámka', alergie: 'ořechy', preference: 'jemný tlak' })
    });
    assert.equal(editace.status, 200, 'Editace zákaznice selhala');
    const poEditaci = await adminFetch('/admin/zakaznici/' + encodeURIComponent(TEL_RUCNI)).then(r => r.json());
    assert.equal(poEditaci.preference, 'jemný tlak', 'Editace se neprojevila');
    console.log('OK (26) — editace zákaznice (poznámka/alergie/preference) funguje');

    const smazani = await adminFetch('/admin/zakaznici/' + encodeURIComponent(TEL_RUCNI), { method: 'DELETE' });
    assert.equal(smazani.status, 200, 'Smazání zákaznice selhalo');
    const poSmazani = await adminFetch('/admin/zakaznici/' + encodeURIComponent(TEL_RUCNI));
    assert.equal(poSmazani.status, 404, 'Smazaná zákaznice bez rezervací/poukazů se už neměla najít');
    uklidZakaznice.length = 0; // smazáno ručně výš, není co v "finally" ještě mazat
    console.log('OK (27) — smazání zákaznice se chová jako dosud (řádek zmizí, pokud nemá rezervace/poukazy)');

    // ================= REGRESE: veřejná rezervace stále funguje (28) =================
    const verejnyTermin = await novyVolnyTermin(polozka.id, 120);
    const verejnaRes = await fetch(API + '/rezervace', {
      method: 'POST',
      body: JSON.stringify({
        datum: verejnyTermin.datum, cas_od: verejnyTermin.cas, cenik_id: polozka.id,
        jmeno: 'TEST-ZAKAZNICI-VEREJNA (smazat)', telefon: '00099013', email: 'test-zakaznici@example.cz',
        souhlas_gdpr: true
      }),
      headers: { 'Content-Type': 'application/json' }
    });
    const verejnaData = await verejnaRes.json();
    assert.equal(verejnaRes.status, 200, 'Veřejná rezervace selhala: ' + JSON.stringify(verejnaData));
    uklidRezervace.push(verejnaData.rezervace.id);
    console.log('OK (28) — veřejná rezervace stále funguje beze změny');

    console.log('\n✅ VŠECHNY TESTY ZÁKAZNIC/CRM (Fáze 6B) PROŠLY');
  } finally {
    for (const id of uklidRezervace) await adminFetch(`/admin/rezervace/${id}`, { method: 'DELETE' }).catch(() => {});
    for (const id of uklidPoukazy) await adminFetch(`/admin/poukazy/${id}`, { method: 'DELETE' }).catch(() => {});
    for (const tel of uklidZakaznice) await adminFetch(`/admin/zakaznici/${encodeURIComponent(tel)}`, { method: 'DELETE' }).catch(() => {});
    console.log(`(uklizeno: ${uklidRezervace.length} testovacích rezervací, ${uklidPoukazy.length} testovacích poukazů)`);
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
