// Regresní test: veřejný rezervační flow (Fáze 8B.1/8B.2/8B.3, opraveno 8C.3).
// Na rozdíl od ostatních testů v tomto adresáři, které rezervace vytvářejí
// přes POST /api/admin/rezervace (jiný, jednodušší kód), tento soubor
// testuje VEŘEJNÝ POST /api/rezervace a oba GET /api/rezervace/* endpointy —
// jedinou cestu, kterou skutečně používá web (otevírací doba, provozní
// výjimky, rezervace_od, GDPR souhlas, informativní ověření poukazu,
// advisory zámek proti souběžným požadavkům, newsletter opt-in).
//
// Fáze 8C.3 doplnila: ochranu proti rezervaci do minulosti (P0.10), validaci
// formátu e-mailu a minimální délky telefonu po normalizaci, maximální délky
// vstupních polí a logování (ne tiché pohlcení) chyby newsletter/e-mail
// side-effectu — viz audit 8C.1 a návrh 8C.2.
//
// Běží VÝHRADNĚ proti izolovanému testovacímu prostředí (env-guard.js —
// fail-closed, žádný produkční fallback). Testovací server musí běžet bez
// RESEND_API_KEY (odeslatEmail() se tím stává bezpečným no-opem, žádný
// skutečný e-mail se neodešle — ověřeno v 8B.2 sekce H).
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=... node tests/rezervace.test.js

const assert = require('node:assert/strict');

const { ziskatTestApiBase } = require('./env-guard');
const API = ziskatTestApiBase();
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
function dnyDopredu(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function dnyZpet(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function dnVTydnu(datumIso) { return new Date(datumIso + 'T12:00:00').getDay(); }
function ponedeliTydne(d) { const den = d.getDay(); const posun = den === 0 ? -6 : 1 - den; const p = new Date(d); p.setDate(p.getDate() + posun); return p; }

// ── Úklid ────────────────────────────────────────────────────────────────
const uklidRezervace = [];
const uklidPoukazy = [];
const uklidNewsletter = [];
const uklidKlientky = new Set();
const uklidVyjimky = [];
const uklidCeniky = [];
const nastaveneKlice = new Map(); // klic -> puvodni hodnota (nebo null = nebyl nastaven)
const pracovniDobaPuvodni = new Map(); // den_v_tydnu -> puvodni radek

async function nastav(klic, hodnota) {
  if (!nastaveneKlice.has(klic)) {
    const r = await adminFetch('/admin/nastaveni').then(x => x.json());
    const existujici = r.find(n => n.klic === klic);
    nastaveneKlice.set(klic, existujici ? existujici.hodnota : null);
  }
  await adminFetch(`/admin/nastaveni/${klic}`, { method: 'PUT', body: JSON.stringify({ hodnota: String(hodnota) }) });
}
async function obnovNastaveni() {
  for (const [klic, puvodni] of nastaveneKlice) {
    if (puvodni === null) await adminFetch(`/admin/nastaveni/${klic}`, { method: 'DELETE' }).catch(() => {});
    else await adminFetch(`/admin/nastaveni/${klic}`, { method: 'PUT', body: JSON.stringify({ hodnota: puvodni }) }).catch(() => {});
  }
}

async function zajistitPuvodniPracovniDobu(den) {
  if (!pracovniDobaPuvodni.has(den)) {
    const vse = await adminFetch('/admin/pracovni-doba').then(r => r.json());
    pracovniDobaPuvodni.set(den, vse.find(r => r.den_v_tydnu === den) || null);
  }
}
async function nastavitPracovniDobu(den, otevrenoOd, otevrenoDo, pauzaOd = null, pauzaDo = null, aktivni = true) {
  await zajistitPuvodniPracovniDobu(den);
  const r = await adminFetch(`/admin/pracovni-doba/${den}`, {
    method: 'PUT',
    body: JSON.stringify({ otevreno_od: otevrenoOd, otevreno_do: otevrenoDo, pauza_od: pauzaOd, pauza_do: pauzaDo, aktivni })
  });
  assert.equal(r.status, 200, `nastavení pracovní doby pro den ${den} selhalo`);
}
async function obnovPracovniDobu() {
  for (const [den, radek] of pracovniDobaPuvodni) {
    if (!radek) continue;
    await adminFetch(`/admin/pracovni-doba/${den}`, {
      method: 'PUT',
      body: JSON.stringify({
        otevreno_od: radek.otevreno_od, otevreno_do: radek.otevreno_do,
        pauza_od: radek.pauza_od, pauza_do: radek.pauza_do, aktivni: radek.aktivni
      })
    }).catch(() => {});
  }
}
// Zajistí, že den v týdnu pro dané datum má širokou otevírací dobu bez pauzy
// (pro testy, které potřebují "uvnitř otevírací doby", ale samy netestují
// otevírací dobu jako takovou).
async function zajistitSirokouDobu(datumIso) {
  await nastavitPracovniDobu(dnVTydnu(datumIso), '07:00', '20:00', null, null, true);
}

let cenikCitac = 0;
async function vytvoritTestovaciCenik(delkaMin = 60, rezervovatelna = true, nazev = 'TEST-8B-REZERVACE-CENIK') {
  // UNIQUE(skupina, varianta, delka_min) v schema.sql — čítač zajistí, že víc
  // volání (jeden test soubor volá tuto funkci mnohokrát) nekoliduje.
  cenikCitac++;
  const r = await adminFetch('/admin/cenik', {
    method: 'POST',
    body: JSON.stringify({ skupina: nazev, varianta: String(delkaMin) + 'min-' + cenikCitac, delka_min: delkaMin, cena: 777, rezervovatelna })
  });
  const data = await r.json();
  assert.equal(r.status, 200, 'vytvoření testovacího ceníku selhalo: ' + JSON.stringify(data));
  uklidCeniky.push(data.polozka.id);
  return data.polozka;
}
async function vytvoritVyjimku(datumOd, datumDo, otevrenoOd = null, otevrenoDo = null) {
  const r = await adminFetch('/admin/vyjimky', {
    method: 'POST',
    body: JSON.stringify({ datum_od: datumOd, datum_do: datumDo, popis: 'TEST-8B-REZERVACE (smazat)', otevreno_od: otevrenoOd, otevreno_do: otevrenoDo })
  });
  const data = await r.json();
  assert.equal(r.status, 200, 'vytvoření testovací výjimky selhalo: ' + JSON.stringify(data));
  uklidVyjimky.push(data.vyjimka.id);
  return data.vyjimka;
}
async function vytvoritPoukaz(cenikId) {
  const r = await adminFetch('/admin/poukazy', { method: 'POST', body: JSON.stringify({ cenik_id: cenikId }) });
  const data = await r.json();
  assert.equal(r.status, 200, 'vytvoření testovacího poukazu selhalo: ' + JSON.stringify(data));
  uklidPoukazy.push(data.poukaz.id);
  return data.poukaz;
}
async function verejnaRezervace(telo) {
  const r = await fetch(API + '/rezervace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(telo) });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
async function volneTerminy(datum, cenikId) {
  const r = await fetch(API + '/rezervace/volne-terminy?datum=' + encodeURIComponent(datum) + '&cenik_id=' + encodeURIComponent(cenikId));
  return { status: r.status, data: await r.json() };
}
async function kalendar(zacatek, cenikId) {
  const r = await fetch(API + '/rezervace/kalendar?zacatek=' + encodeURIComponent(zacatek) + '&cenik_id=' + encodeURIComponent(cenikId));
  return { status: r.status, data: await r.json() };
}
function zaznamenejVysledekRezervace(vysledek) {
  if (vysledek.status === 200 && vysledek.data && vysledek.data.rezervace) {
    uklidRezervace.push(vysledek.data.rezervace.id);
    if (vysledek.data.rezervace.klientka_id) uklidKlientky.add(vysledek.data.rezervace.klientka_id);
  }
}
async function pocetRezervaciNaSlot(datum, casOd) {
  const vse = await adminFetch('/admin/rezervace').then(r => r.json());
  return vse.filter(r => r.datum === datum && r.cas_od.slice(0, 5) === casOd).length;
}
// Newsletter upsert v POST /api/rezervace je fire-and-forget (db.query(...)
// bez await, server.js:1165-1173) — response může dorazit dřív, než zápis
// doběhne. Krátký poll (ne oprava produkčního kódu) místo okamžité kontroly.
async function pockejNaOdberatele(email, pokusy = 10, pauzaMs = 100) {
  for (let i = 0; i < pokusy; i++) {
    const vse = await adminFetch('/admin/newsletter').then(x => x.json());
    const nalezen = vse.find(n => n.email === email);
    if (nalezen) return nalezen;
    await new Promise(r => setTimeout(r, pauzaMs));
  }
  return null;
}
async function pocetKlientekSTelefonem(telefon) {
  const vse = await adminFetch('/admin/klientky').then(r => r.json());
  // /admin/klientky vrací souhrn — hledáme podle telefonu v souhrnu, pokud je tam k dispozici;
  // bezpečnější je dotáhnout detail jen těch kandidátů, co mají shodný telefon v poli "telefon".
  return vse.filter(k => k.telefon === telefon).length;
}

const vysledky = [];
function ok(popis) { vysledky.push({ popis, stav: 'PASS' }); console.log('PASS — ' + popis); }
function bug(popis) { vysledky.push({ popis, stav: 'KNOWN BUG / DOCUMENTED GAP' }); console.log('KNOWN BUG / DOCUMENTED GAP — ' + popis); }

let telefonCitac = 0;
function novyTelefon() { telefonCitac++; return '73000' + String(1000 + telefonCitac); }

async function main() {
  console.log('=== Fáze 8B.3 — veřejný rezervační flow (POST /api/rezervace) ===');

  // ======================= P0.1 — základní veřejná rezervace =======================
  console.log('--- P0.1 ---');
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(14);
    await zajistitSirokouDobu(datum);
    const telefon = novyTelefon();
    const vysledek = await verejnaRezervace({
      datum, cas_od: '10:00', jmeno: 'TEST-8B-REZERVACE (smazat)', telefon, email: 'test-8b-p01@example.invalid',
      cenik_id: cenik.id, souhlas_gdpr: true,
      // podvržené pole, které API nečte — ověřujeme, že se ignorují
      cena: 1, delka_min: 5
    });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 200, JSON.stringify(vysledek.data));
    assert.equal(vysledek.data.ok, true);
    const r = vysledek.data.rezervace;
    assert.equal(r.stav, 'cekajici');
    assert.equal(r.datum, datum);
    assert.equal(r.cas_od.slice(0, 5), '10:00');
    assert.equal(r.cenik_id, cenik.id);
    assert.equal(Number(r.cena), Number(cenik.cena), 'cena musí odpovídat ceníku, ne podvrženému "cena:1"');
    assert.equal(r.cas_do.slice(0, 5), '11:00', 'cas_do musí odpovídat skutečné délce (60 min), ne podvrženému "delka_min:5"');
    assert.ok(r.klientka_id, 'rezervace musí mít klientka_id');
    const klientka = await adminFetch('/admin/klientky/' + r.klientka_id).then(x => x.json());
    assert.equal(klientka.telefon, telefon);
    ok('P0.1) základní veřejná rezervace vznikne správně, podvržená cena/délka jsou ignorovány, klientka vznikla a je napojená');
  }

  // ======================= P0.2 — skutečný concurrent double booking =======================
  console.log('--- P0.2 ---');
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(15);
    await zajistitSirokouDobu(datum);
    const telefonA = novyTelefon(), telefonB = novyTelefon();
    const teloA = { datum, cas_od: '11:00', jmeno: 'TEST-8B-P02-A (smazat)', telefon: telefonA, email: 'test-8b-p02a@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true };
    const teloB = { datum, cas_od: '11:00', jmeno: 'TEST-8B-P02-B (smazat)', telefon: telefonB, email: 'test-8b-p02b@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true };

    const [a, b] = await Promise.all([verejnaRezervace(teloA), verejnaRezervace(teloB)]);
    // Zaznamenat OBA výsledky PŘED assertem — pokud by regrese způsobila
    // 200+200, musí být obě vzniklé rezervace/klientky zachyceny pro cleanup
    // dřív, než níže případně vyhodí AssertionError (8B.4 review).
    zaznamenejVysledekRezervace(a);
    zaznamenejVysledekRezervace(b);
    const staty = [a.status, b.status].sort();
    assert.deepEqual(staty, [200, 409], 'z dvou souběžných požadavků na stejný slot musí být přesně jeden 200 a jeden 409 — skutečný výsledek: ' + JSON.stringify([a.status, b.status]));

    const uspesny = a.status === 200 ? a : b;
    zaznamenejVysledekRezervace(uspesny);
    const pocet = await pocetRezervaciNaSlot(datum, '11:00');
    assert.equal(pocet, 1, 'na daném slotu musí být přesně 1 rezervace, ne 2 (double booking)');

    // Ověření, že neúspěšný požadavek NEVYTVOŘIL klientku (ROLLBACK proběhl
    // před najitNeboVytvoritKlientku, protože ta je součástí téže transakce).
    const neuspesnyTelefon = a.status === 200 ? telefonB : telefonA;
    const pocetKlientekNeuspesnych = await pocetKlientekSTelefonem(neuspesnyTelefon);
    assert.equal(pocetKlientekNeuspesnych, 0, 'neúspěšný souběžný požadavek nesmí vytvořit klientku (celá transakce včetně najitNeboVytvoritKlientku se vrátí zpět)');

    ok('P0.2) skutečný concurrent double booking: Promise.all → přesně 1×200 + 1×409, přesně 1 rezervace v DB, neúspěšná strana nevytvořila klientku (potvrzeno, že advisory zámek + transakce chrání i vznik klientky)');
  }

  // ======================= P0.3 — kolize s bufferem =======================
  console.log('--- P0.3 ---');
  {
    await nastav('buffer_minut', 30);
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(16);
    await zajistitSirokouDobu(datum);
    const telefon1 = novyTelefon();
    const prvni = await verejnaRezervace({ datum, cas_od: '10:00', jmeno: 'TEST-8B-P03-1 (smazat)', telefon: telefon1, email: 'test-8b-p03-1@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(prvni);
    assert.equal(prvni.status, 200, JSON.stringify(prvni.data));

    const telefon2 = novyTelefon();
    const druha = await verejnaRezervace({ datum, cas_od: '10:50', jmeno: 'TEST-8B-P03-2 (smazat)', telefon: telefon2, email: 'test-8b-p03-2@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(druha);
    assert.equal(druha.status, 409, 'rezervace 10:50 (uvnitř 60min+30min bufferu od 10:00-11:00) musí kolidovat: ' + JSON.stringify(druha.data));

    const pocet = await pocetRezervaciNaSlot(datum, '10:50');
    assert.equal(pocet, 0, 'kolidující rezervace nesmí vzniknout');
    const pocetKlientek2 = await pocetKlientekSTelefonem(telefon2);
    assert.equal(pocetKlientek2, 0, 'kolidující požadavek nesmí vytvořit klientku');
    ok('P0.3) kolize s bufferem (30 min): druhá rezervace 50 min po konci první je odmítnuta 409, nevzniká ani rezervace, ani klientka');
  }

  // ======================= P0.4 — mimo pracovní dobu =======================
  console.log('--- P0.4 ---');
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(17);
    await nastavitPracovniDobu(dnVTydnu(datum), '09:00', '17:00', null, null, true);

    const telefonPred = novyTelefon();
    const pred = await verejnaRezervace({ datum, cas_od: '08:00', jmeno: 'TEST-8B-P04-A (smazat)', telefon: telefonPred, email: 'test-8b-p04a@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(pred);
    assert.equal(pred.status, 400, 'rezervace před otevřením (08:00, otevřeno od 09:00) musí být 400: ' + JSON.stringify(pred.data));

    const telefonPo = novyTelefon();
    const po = await verejnaRezervace({ datum, cas_od: '17:00', jmeno: 'TEST-8B-P04-B (smazat)', telefon: telefonPo, email: 'test-8b-p04b@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(po);
    assert.equal(po.status, 400, 'rezervace 17:00 (60 min, konec 18:00, zavřeno 17:00) musí být 400: ' + JSON.stringify(po.data));

    const pocetA = await pocetRezervaciNaSlot(datum, '08:00');
    const pocetB = await pocetRezervaciNaSlot(datum, '17:00');
    assert.equal(pocetA + pocetB, 0, 'žádná rezervace mimo pracovní dobu nesmí vzniknout');
    const pocetKlPred = await pocetKlientekSTelefonem(telefonPred);
    const pocetKlPo = await pocetKlientekSTelefonem(telefonPo);
    assert.equal(pocetKlPred + pocetKlPo, 0, 'žádná klientka nesmí vzniknout (konzistentní s P0.3/P0.7/P0.8/P0.9)');
    ok('P0.4) mimo pracovní dobu (před otevřením i po zavření) → 400, žádný zápis (rezervace i klientka)');
  }

  // ======================= P0.5 — polední pauza =======================
  console.log('--- P0.5 ---');
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(18);
    await nastavitPracovniDobu(dnVTydnu(datum), '09:00', '18:00', '12:00', '13:00', true);

    const telefon = novyTelefon();
    const vysledek = await verejnaRezervace({ datum, cas_od: '12:15', jmeno: 'TEST-8B-P05 (smazat)', telefon, email: 'test-8b-p05@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 400, 'rezervace 12:15 (60 min, zasahuje do pauzy 12:00-13:00) musí být 400: ' + JSON.stringify(vysledek.data));

    const pocet = await pocetRezervaciNaSlot(datum, '12:15');
    assert.equal(pocet, 0, 'rezervace zasahující do pauzy nesmí vzniknout');
    const pocetKl = await pocetKlientekSTelefonem(telefon);
    assert.equal(pocetKl, 0, 'žádná klientka nesmí vzniknout (konzistentní s P0.3/P0.7/P0.8/P0.9)');
    ok('P0.5) rezervace zasahující do polední pauzy → 400, žádný zápis (rezervace i klientka)');
  }

  // ======================= P0.6 — provozní výjimka (celodenní zavření) =======================
  console.log('--- P0.6 ---');
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(21);
    await vytvoritVyjimku(datum, datum); // bez otevreno_od/do = celý den zavřeno

    const telefon = novyTelefon();
    const vysledek = await verejnaRezervace({ datum, cas_od: '10:00', jmeno: 'TEST-8B-P06 (smazat)', telefon, email: 'test-8b-p06@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 400, 'rezervace v den s celodenní provozní výjimkou musí být 400: ' + JSON.stringify(vysledek.data));

    const pocet = await pocetRezervaciNaSlot(datum, '10:00');
    assert.equal(pocet, 0, 'rezervace v den výjimky nesmí vzniknout');
    const pocetKl = await pocetKlientekSTelefonem(telefon);
    assert.equal(pocetKl, 0, 'žádná klientka nesmí vzniknout (konzistentní s P0.3/P0.7/P0.8/P0.9)');
    ok('P0.6) celodenní provozní výjimka (zavřeno) → 400, žádný zápis (rezervace i klientka)');
  }

  // ======================= P0.7 — neexistující služba =======================
  console.log('--- P0.7 ---');
  {
    const datum = dnyDopredu(22);
    const telefon = novyTelefon();
    const vysledek = await verejnaRezervace({ datum, cas_od: '10:00', jmeno: 'TEST-8B-P07 (smazat)', telefon, email: 'test-8b-p07@example.invalid', cenik_id: 999999, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 404, 'neexistující cenik_id musí vrátit 404: ' + JSON.stringify(vysledek.data));
    const pocet = await pocetRezervaciNaSlot(datum, '10:00');
    assert.equal(pocet, 0, 'žádná rezervace nesmí vzniknout');
    const pocetKl = await pocetKlientekSTelefonem(telefon);
    assert.equal(pocetKl, 0, 'žádná klientka nesmí vzniknout');
    ok('P0.7) neexistující cenik_id → 404, žádný zápis');
  }

  // ======================= P0.8 — rezervovatelna=false =======================
  console.log('--- P0.8 ---');
  {
    const cenik = await vytvoritTestovaciCenik(60, false);
    const datum = dnyDopredu(23);
    const telefon = novyTelefon();
    const vysledek = await verejnaRezervace({ datum, cas_od: '10:00', jmeno: 'TEST-8B-P08 (smazat)', telefon, email: 'test-8b-p08@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 400, 'položka s rezervovatelna=false musí vrátit 400: ' + JSON.stringify(vysledek.data));
    const pocet = await pocetRezervaciNaSlot(datum, '10:00');
    assert.equal(pocet, 0);
    const pocetKl = await pocetKlientekSTelefonem(telefon);
    assert.equal(pocetKl, 0);
    ok('P0.8) služba rezervovatelna=false → 400, žádný zápis');
  }

  // ======================= P0.9 — chybějící GDPR souhlas =======================
  console.log('--- P0.9 ---');
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(26);
    await zajistitSirokouDobu(datum);

    const telefonA = novyTelefon();
    const a = await verejnaRezervace({ datum, cas_od: '09:00', jmeno: 'TEST-8B-P09-A (smazat)', telefon: telefonA, email: 'test-8b-p09a@example.invalid', cenik_id: cenik.id, souhlas_gdpr: false });
    zaznamenejVysledekRezervace(a);
    assert.equal(a.status, 400, 'souhlas_gdpr: false musí vrátit 400: ' + JSON.stringify(a.data));

    const telefonB = novyTelefon();
    const telo = { datum, cas_od: '09:00', jmeno: 'TEST-8B-P09-B (smazat)', telefon: telefonB, email: 'test-8b-p09b@example.invalid', cenik_id: cenik.id };
    const b = await verejnaRezervace(telo); // souhlas_gdpr úplně chybí
    zaznamenejVysledekRezervace(b);
    assert.equal(b.status, 400, 'chybějící souhlas_gdpr musí vrátit 400: ' + JSON.stringify(b.data));

    const pocetRez = await pocetRezervaciNaSlot(datum, '09:00');
    assert.equal(pocetRez, 0, 'bez GDPR souhlasu nesmí vzniknout žádná rezervace');
    const pocetKlA = await pocetKlientekSTelefonem(telefonA);
    const pocetKlB = await pocetKlientekSTelefonem(telefonB);
    assert.equal(pocetKlA + pocetKlB, 0, 'bez GDPR souhlasu nesmí vzniknout žádná klientka — potvrzuje, že validace proběhne PŘED najitNeboVytvoritKlientku');

    const vse = await adminFetch('/admin/newsletter').then(x => x.json());
    assert.equal(vse.some(n => n.email === 'test-8b-p09a@example.invalid' || n.email === 'test-8b-p09b@example.invalid'), false, 'bez úspěšné rezervace nesmí vzniknout ani newsletter záznam');

    ok('P0.9) chybějící GDPR souhlas (false i úplně chybějící pole) → 400, žádná rezervace, žádná klientka, žádný newsletter záznam');
  }

  // ======================= P1 — vybrané testy =======================
  console.log('--- P1 ---');

  // P1.1 — reprezentativní chybějící povinné pole
  {
    const datum = dnyDopredu(27);
    const vysledek = await verejnaRezervace({ /* cas_od chybí */ datum, jmeno: 'TEST-8B-P1-1 (smazat)', telefon: novyTelefon(), email: 'test-8b-p11@example.invalid', cenik_id: 1, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 400, JSON.stringify(vysledek.data));
    ok('P1.1) chybějící povinné pole (cas_od) → 400');
  }

  // P1.2 — reprezentativní prázdné povinné pole
  {
    const datum = dnyDopredu(27);
    const vysledek = await verejnaRezervace({ datum, cas_od: '10:00', jmeno: '', telefon: novyTelefon(), email: 'test-8b-p12@example.invalid', cenik_id: 1, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 400, JSON.stringify(vysledek.data));
    ok('P1.2) prázdné povinné pole (jmeno:"") → 400 (JS truthy kontrola zachytí i prázdný string)');
  }

  // P1.3 — neplatný e-mail (OPRAVENO 8C.3 — dřív KNOWN BUG, teď 400)
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(28);
    await zajistitSirokouDobu(datum);
    const telefon = novyTelefon();
    const vysledek = await verejnaRezervace({ datum, cas_od: '10:00', jmeno: 'TEST-8B-P13 (smazat)', telefon, email: 'tohle-neni-platny-email', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 400, 'neplatný e-mail (bez "@") musí po opravě 8C.3 vrátit 400: ' + JSON.stringify(vysledek.data));
    const pocet = await pocetRezervaciNaSlot(datum, '10:00');
    assert.equal(pocet, 0, 'neplatný e-mail nesmí vytvořit rezervaci');
    const pocetKl = await pocetKlientekSTelefonem(telefon);
    assert.equal(pocetKl, 0, 'neplatný e-mail nesmí vytvořit klientku');
    ok('P1.3) neplatný e-mail (bez "@") → 400, žádná rezervace, žádná klientka');
  }

  // P1.4 — extrémně dlouhé jméno (OPRAVENO 8C.3 — dřív KNOWN BUG, teď 400)
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(29);
    await zajistitSirokouDobu(datum);
    const dlouheJmeno = 'TEST-8B-DLOUHE-' + 'X'.repeat(90) + ' (smazat)'; // > 100 znaků (limit z 8C.2/8C.3)
    const telefon = novyTelefon();
    const vysledek = await verejnaRezervace({ datum, cas_od: '10:00', jmeno: dlouheJmeno, telefon, email: 'test-8b-p14@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 400, 'jméno nad limitem 100 znaků musí po opravě 8C.3 vrátit 400: ' + JSON.stringify(vysledek.data));
    const pocet = await pocetRezervaciNaSlot(datum, '10:00');
    assert.equal(pocet, 0, 'příliš dlouhé jméno nesmí vytvořit rezervaci');
    const pocetKl = await pocetKlientekSTelefonem(telefon);
    assert.equal(pocetKl, 0, 'příliš dlouhé jméno nesmí vytvořit klientku');
    ok('P1.4) extrémně dlouhé jméno (>100 znaků) → 400, žádná rezervace, žádná klientka');
  }

  // P0.10 — rezervace do minulosti (OPRAVENO 8C.3 — dřív vědomě vynecháno, teď 400)
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyZpet(1); // včera
    const telefon = novyTelefon();
    const vysledek = await verejnaRezervace({ datum, cas_od: '10:00', jmeno: 'TEST-8B-P010 (smazat)', telefon, email: 'test-8b-p010@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 400, 'rezervace na včerejší datum musí po opravě 8C.3 vrátit 400: ' + JSON.stringify(vysledek.data));
    const pocet = await pocetRezervaciNaSlot(datum, '10:00');
    assert.equal(pocet, 0, 'rezervace do minulosti nesmí vzniknout');
    const pocetKl = await pocetKlientekSTelefonem(telefon);
    assert.equal(pocetKl, 0, 'rezervace do minulosti nesmí vytvořit klientku');
    ok('P0.10) rezervace do minulosti (včera) → 400, žádná rezervace, žádná klientka');
  }

  // C.1 — neplatný telefon (příliš krátký po normalizaci)
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(36);
    await zajistitSirokouDobu(datum);
    const vysledek = await verejnaRezervace({ datum, cas_od: '10:00', jmeno: 'TEST-8B-C1 (smazat)', telefon: '123', email: 'test-8b-c1@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 400, 'telefon "123" (míň než 9 číslic po normalizaci) musí vrátit 400: ' + JSON.stringify(vysledek.data));
    const pocet = await pocetRezervaciNaSlot(datum, '10:00');
    assert.equal(pocet, 0, 'nevalidní telefon nesmí vytvořit rezervaci');
    ok('C.1) nevalidní telefon ("123", < 9 číslic) → 400, žádná rezervace');
  }

  // C.2 — legitimní zahraniční telefon (musí projít, hranice 9 číslic nesmí zablokovat mezinárodní formát)
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(37);
    await zajistitSirokouDobu(datum);
    const vysledek = await verejnaRezervace({ datum, cas_od: '10:00', jmeno: 'TEST-8B-C2 (smazat)', telefon: '+49 170 1234567', email: 'test-8b-c2@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 200, 'legitimní zahraniční telefon musí projít: ' + JSON.stringify(vysledek.data));
    assert.ok(vysledek.data.rezervace.klientka_id, 'zahraniční telefon musí vytvořit klientku jako jakýkoli jiný validní telefon');
    ok('C.2) legitimní zahraniční telefon (+49 170 1234567) → 200, rezervace i klientka vznikly');
  }

  // P1.5 — platný voucher (jen informativní ověření, zůstatek beze změny)
  {
    const cenik = await vytvoritTestovaciCenik(60, true, 'TEST-8B-P15-CENIK');
    const poukaz = await vytvoritPoukaz(cenik.id); // konkretni_masaz bude přesně odpovídat nazevMasaze téhle rezervace
    const datum = dnyDopredu(30);
    await zajistitSirokouDobu(datum);
    const telefon = novyTelefon();
    const vysledek = await verejnaRezervace({ datum, cas_od: '10:00', jmeno: 'TEST-8B-P15 (smazat)', telefon, email: 'test-8b-p15@example.invalid', cenik_id: cenik.id, poukaz_kod: poukaz.kod, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 200, JSON.stringify(vysledek.data));
    assert.match(vysledek.data.rezervace.poznamka || '', /ověřen/, 'poznámka musí obsahovat informaci o ověřeném poukazu');
    const poukazPo = await adminFetch('/admin/poukazy').then(x => x.json()).then(s => s.find(p => p.id === poukaz.id));
    assert.equal(Number(poukazPo.zustatek), Number(poukaz.zustatek), 'zůstatek poukazu se veřejnou rezervací nesmí změnit (jen informativní ověření, skutečné uplatnění dělá admin ručně)');
    ok('P1.5) platný voucher: rezervace vznikne, poznámka obsahuje "ověřen", zůstatek poukazu beze změny');
  }

  // P1.6 — neplatný (neexistující) voucher kód
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(31);
    await zajistitSirokouDobu(datum);
    const telefon = novyTelefon();
    const vysledek = await verejnaRezervace({ datum, cas_od: '10:00', jmeno: 'TEST-8B-P16 (smazat)', telefon, email: 'test-8b-p16@example.invalid', cenik_id: cenik.id, poukaz_kod: 'NEEXISTUJICI-KOD-XYZ', souhlas_gdpr: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 200, 'neplatný/neexistující poukaz kód NESMÍ zablokovat rezervaci: ' + JSON.stringify(vysledek.data));
    assert.match(vysledek.data.rezervace.poznamka || '', /nebyl nalezen/, 'poznámka musí upozornit, že poukaz nebyl nalezen (ověřit ručně)');
    ok('P1.6) neplatný/neexistující voucher kód: rezervace i tak vznikne (200), poznámka obsahuje upozornění "nebyl nalezen"');
  }

  // P1.7 — existující klientka podle telefonu (i přes jiný formát)
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum1 = dnyDopredu(32), datum2 = dnyDopredu(33);
    await zajistitSirokouDobu(datum1); await zajistitSirokouDobu(datum2);
    const telefon = novyTelefon();
    const prvni = await verejnaRezervace({ datum: datum1, cas_od: '10:00', jmeno: 'TEST-8B-P17-A (smazat)', telefon, email: 'test-8b-p17a@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(prvni);
    assert.equal(prvni.status, 200, JSON.stringify(prvni.data));
    const klientkaId1 = prvni.data.rezervace.klientka_id;

    // stejný telefon, ale s mezerami — normalizace musí poznat shodu
    const telefonSMezerami = telefon.slice(0, 3) + ' ' + telefon.slice(3, 6) + ' ' + telefon.slice(6);
    const druha = await verejnaRezervace({ datum: datum2, cas_od: '10:00', jmeno: 'TEST-8B-P17-B (smazat)', telefon: telefonSMezerami, email: 'test-8b-p17b@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(druha);
    assert.equal(druha.status, 200, JSON.stringify(druha.data));
    assert.equal(druha.data.rezervace.klientka_id, klientkaId1, 'druhá rezervace se stejným (jinak formátovaným) telefonem musí napojit na STEJNOU klientku, ne vytvořit druhou');
    ok('P1.7) existující klientka se pozná i přes jiný formát telefonu (mezery) — nevzniká duplicitní profil');
  }

  // P1.8 — nová klientka
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(34);
    await zajistitSirokouDobu(datum);
    const telefon = novyTelefon();
    const vysledek = await verejnaRezervace({ datum, cas_od: '10:00', jmeno: 'TEST-8B-P18 (smazat)', telefon, email: 'test-8b-p18@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 200, JSON.stringify(vysledek.data));
    assert.ok(vysledek.data.rezervace.klientka_id, 'nový unikátní telefon musí vytvořit novou klientku');
    ok('P1.8) nový unikátní telefon vytvoří novou klientku, rezervace je na ni napojena');
  }

  // P1.9 — newsletter opt-in
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(35);
    await zajistitSirokouDobu(datum);
    const email = 'test-8b-p19@example.invalid';
    const vysledek = await verejnaRezervace({ datum, cas_od: '10:00', jmeno: 'TEST-8B-P19 (smazat)', telefon: novyTelefon(), email, cenik_id: cenik.id, souhlas_gdpr: true, souhlas_newsletter: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 200, JSON.stringify(vysledek.data));
    const odberatel = await pockejNaOdberatele(email);
    assert.ok(odberatel, 'souhlas_newsletter:true musí vytvořit záznam v newsletter_odberatele');
    assert.equal(odberatel.aktivni, true);
    uklidNewsletter.push(odberatel.id);
    ok('P1.9) souhlas_newsletter:true vytvoří aktivního odběratele newsletteru');
  }

  // P1.10 — rezervace_od: pokus PŘED cutoffem
  // P1.11 — rezervace_od: pokus PO cutoffu
  {
    await nastav('rezervace_od', dnyDopredu(30));
    const cenik = await vytvoritTestovaciCenik(60, true);

    const datumPred = dnyDopredu(10);
    const pred = await verejnaRezervace({ datum: datumPred, cas_od: '10:00', jmeno: 'TEST-8B-P1-10 (smazat)', telefon: novyTelefon(), email: 'test-8b-p110@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(pred);
    assert.equal(pred.status, 400, 'rezervace před rezervace_od (10 dní dopředu < cutoff 30 dní dopředu) musí být 400: ' + JSON.stringify(pred.data));
    ok('P1.10) rezervace před nastaveným rezervace_od cutoffem → 400');

    const datumPo = dnyDopredu(40);
    await zajistitSirokouDobu(datumPo);
    const po = await verejnaRezervace({ datum: datumPo, cas_od: '10:00', jmeno: 'TEST-8B-P1-11 (smazat)', telefon: novyTelefon(), email: 'test-8b-p111@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(po);
    assert.equal(po.status, 200, 'rezervace po rezervace_od cutoffu musí projít: ' + JSON.stringify(po.data));
    ok('P1.11) rezervace po nastaveném rezervace_od cutoffu → 200');
  }

  // ======================= 8D.3 — GET availability: past-date fix + validace =======================
  console.log('--- F/G/H/I (8D.3) ---');

  // P1.10/P1.11 výš nastavily rezervace_od na dnyDopredu(30) a obnoví se až
  // v globálním finally — bez resetu by blokoval i "dnešek" v testech
  // F2/G2 níž (rezervace_od by byl v budoucnosti vůči testovanému datu).
  // Tyto testy netestují rezervace_od, proto ho posuneme bezpečně do minulosti.
  await nastav('rezervace_od', dnyZpet(365));

  // F1 — včerejší datum: GET volne-terminy nesmí vrátit žádný volno:true
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const vcera = dnyZpet(1);
    const vysledek = await volneTerminy(vcera, cenik.id);
    assert.equal(vysledek.status, 200, JSON.stringify(vysledek.data));
    assert.deepEqual(vysledek.data, [], 'minulé datum musí vrátit prázdný seznam termínů (žádný rezervovatelný slot)');
    ok('F1) GET volne-terminy pro včerejší datum → 200, [] (žádný volno:true)');
  }

  // F2 — minulá část aktuálního týdne: GET kalendar nesmí u dnů před dneškem nabízet volné termíny
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    for (let den = 0; den < 7; den++) await nastavitPracovniDobu(den, '07:00', '20:00', null, null, true);
    const zacatekIso = ponedeliTydne(new Date()).toISOString().slice(0, 10);
    const dnesIso = new Date().toISOString().slice(0, 10);
    const vysledek = await kalendar(zacatekIso, cenik.id);
    assert.equal(vysledek.status, 200, JSON.stringify(vysledek.data));
    assert.equal(vysledek.data.length, 7, 'kalendar musí vrátit přesně 7 dní');
    vysledek.data.forEach(den => {
      if (den.datum < dnesIso) {
        assert.deepEqual(den.terminy, [], 'den ' + den.datum + ' je v minulosti (aktuální týden) — musí mít prázdné terminy, ne nabízet volné sloty: ' + JSON.stringify(den.terminy));
      } else {
        assert.ok(den.terminy.some(t => t.volno === true), 'den ' + den.datum + ' (dnešek/budoucí, otevřeno 07:00-20:00) musí nabízet aspoň 1 volný termín');
      }
    });
    ok('F2) GET kalendar pro aktuální týden: dny před dneškem mají prázdné terminy, dnešek a budoucí dny beze změny (test je robustní vůči dni, kdy běží)');
  }

  // G1 — regrese: budoucí den musí nadále nabízet dostupné termíny
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(42);
    await zajistitSirokouDobu(datum);
    const vysledek = await volneTerminy(datum, cenik.id);
    assert.equal(vysledek.status, 200, JSON.stringify(vysledek.data));
    assert.ok(vysledek.data.some(t => t.volno === true), 'budoucí den s otevřenou pracovní dobou musí nabízet aspoň 1 volný termín (regrese past-date fixu)');
    ok('G1) budoucí den nadále nabízí dostupné termíny (regrese past-date fixu nerozbila budoucnost)');
  }

  // G2 — dnešek nesmí být omylem zahrnut do past-date filtru (datum < dnesIso, ne <=)
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const dnesIso = new Date().toISOString().slice(0, 10);
    await zajistitSirokouDobu(dnesIso);
    const vysledek = await volneTerminy(dnesIso, cenik.id);
    assert.equal(vysledek.status, 200, JSON.stringify(vysledek.data));
    assert.ok(vysledek.data.some(t => t.volno === true), 'dnešek (datum === dnesIso) nesmí být omylem filtrován jako minulost');
    ok('G2) dnešek zůstává dostupný — past-date filtr používá striktně "<", ne "<="');
  }

  // H — GET -> POST invariant: termín oznámený GET jako volno:true musí POST skutečně přijmout
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(43);
    await zajistitSirokouDobu(datum);
    const ziskane = await volneTerminy(datum, cenik.id);
    assert.equal(ziskane.status, 200, JSON.stringify(ziskane.data));
    const volnyCas = ziskane.data.find(t => t.volno === true);
    assert.ok(volnyCas, 'GET musí pro čistý budoucí den nabídnout aspoň jeden volný termín, aby šel invariant ověřit');
    const telefon = novyTelefon();
    const vysledek = await verejnaRezervace({ datum, cas_od: volnyCas.cas, jmeno: 'TEST-8B-H (smazat)', telefon, email: 'test-8b-h@example.invalid', cenik_id: cenik.id, souhlas_gdpr: true });
    zaznamenejVysledekRezervace(vysledek);
    assert.equal(vysledek.status, 200, 'termín oznámený GET jako volno:true musí POST přijmout (GET<->POST invariant, bez zásahu třetí strany): ' + JSON.stringify(vysledek.data));
    ok('H) GET↔POST invariant: termín oznámený GET jako volno:true je POSTem skutečně akceptován (200)');
  }

  // I — P2 validace vstupů obou GET endpointů
  {
    const cenik = await vytvoritTestovaciCenik(60, true);
    const datum = dnyDopredu(44);

    for (const cid of ['abc', '1.5', '-1', '0']) {
      const r1 = await volneTerminy(datum, cid);
      assert.equal(r1.status, 400, 'volne-terminy cenik_id="' + cid + '" musí vrátit 400: ' + JSON.stringify(r1.data));
      const r2 = await kalendar(datum, cid);
      assert.equal(r2.status, 400, 'kalendar cenik_id="' + cid + '" musí vrátit 400: ' + JSON.stringify(r2.data));
    }
    ok('I-cenik_id) neplatné cenik_id (abc/1.5/-1/0) → 400 na obou GET endpointech');

    for (const d of ['abc', '2026-1-1', '2026-13-45']) {
      const r1 = await volneTerminy(d, cenik.id);
      assert.equal(r1.status, 400, 'volne-terminy datum="' + d + '" musí vrátit 400: ' + JSON.stringify(r1.data));
      const r2 = await kalendar(d, cenik.id);
      assert.equal(r2.status, 400, 'kalendar zacatek="' + d + '" musí vrátit 400: ' + JSON.stringify(r2.data));
    }
    ok('I-datum) neplatné datum/zacatek (abc/2026-1-1/2026-13-45) → 400 na obou GET endpointech');
  }

  console.log(`\n${vysledky.filter(v => v.stav === 'PASS').length}/${vysledky.length} scénářů (zbytek jsou vědomě dokumentované bugy, ne selhání testu).`);
}

main()
  .catch(e => { console.error('CHYBA:', e); process.exitCode = 1; })
  .finally(async () => {
    console.log('\n--- úklid ---');
    for (const id of uklidRezervace) await adminFetch('/admin/rezervace/' + id, { method: 'DELETE' }).catch(() => {});
    for (const id of uklidPoukazy) await adminFetch('/admin/poukazy/' + id, { method: 'DELETE' }).catch(() => {});
    for (const id of uklidNewsletter) await adminFetch('/admin/newsletter/' + id, { method: 'DELETE' }).catch(() => {});
    for (const id of uklidKlientky) await adminFetch('/admin/klientky/' + id, { method: 'DELETE' }).catch(() => {});
    for (const id of uklidVyjimky) await adminFetch('/admin/vyjimky/' + id, { method: 'DELETE' }).catch(() => {});
    for (const id of uklidCeniky) await adminFetch('/admin/cenik/' + id, { method: 'DELETE' }).catch(() => {});
    await obnovNastaveni();
    await obnovPracovniDobu();
    console.log(`(uklizeno: ${uklidRezervace.length} rezervací, ${uklidPoukazy.length} poukazů, ${uklidNewsletter.length} newsletter záznamů, ${uklidKlientky.size} klientek, ${uklidVyjimky.length} výjimek, ${uklidCeniky.length} ceníkových položek, ${nastaveneKlice.size} nastavení obnoveno, ${pracovniDobaPuvodni.size} dnů pracovní doby obnoveno)`);
    console.log('\n=== VÝSLEDKY ===');
    vysledky.forEach(v => console.log(`[${v.stav}] ${v.popis}`));
  });
