// Test: vánoční akce „Stromeček 2026“ — veřejný slevový kód (stromecek_2026.sql).
// Ověřuje: stav akce (kód se ukáže až během akce), uplatnění v rezervaci
// i žádosti o poukaz, diakritiku/velikost písmen, zákaz kombinace s poukazem,
// strop (i při souběhu), storno = status 'vraceno' (nic se nemaže), obnovení
// zrušené rezervace, úpravu rezervace v adminu, ruční vrácení, účetnictví
// (prodej poukazu = hodnota − sleva) a CSV export.
//
// Testy NEMĚNÍ akci STROMECEK2026 — založí si vlastní testovací akci
// (TEST-STROMECEK-…) a na konci ji vypnou. Záznamy o využití se z principu
// nemažou (trigger), ale patří k testovací akci, takže nic neovlivní.
//
// Běží VÝHRADNĚ proti izolovanému testovacímu prostředí (env-guard.js).
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=http://localhost:3001/api node tests/stromecek.test.js

const assert = require('node:assert/strict');
const { ziskatTestApiBase } = require('./env-guard');
const API = ziskatTestApiBase();
const HESLO = process.env.ADMIN_HESLO;
if (!HESLO) { console.error('Chybí ADMIN_HESLO v prostředí — test se přeskakuje.'); process.exit(0); }

function adminFetch(cesta, options = {}) {
  return fetch(API + cesta, { ...options, headers: { 'Content-Type': 'application/json', 'x-admin-heslo': HESLO, ...(options.headers || {}) } });
}
async function adminJson(cesta, options) { const r = await adminFetch(cesta, options); return { status: r.status, data: await r.json() }; }
async function verejne(cesta, telo) {
  const r = await fetch(API + cesta, telo === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(telo) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
function dnyDopredu(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function dnVTydnu(datumIso) { return new Date(datumIso + 'T12:00:00').getDay(); }

// ── Úklid ──
const uklidRezervace = [];
const uklidZadosti = [];
const uklidPoukazy = [];
const uklidKlientky = new Set();
const uklidCeniky = [];
const uklidAkce = [];
const pracovniDobaPuvodni = new Map();

async function zajistitSirokouDobu(datumIso) {
  const den = dnVTydnu(datumIso);
  if (!pracovniDobaPuvodni.has(den)) {
    const vse = await adminFetch('/admin/pracovni-doba').then(r => r.json());
    pracovniDobaPuvodni.set(den, vse.find(r => r.den_v_tydnu === den) || null);
  }
  const r = await adminFetch(`/admin/pracovni-doba/${den}`, { method: 'PUT', body: JSON.stringify({ otevreno_od: '07:00', otevreno_do: '20:00', pauza_od: null, pauza_do: null, aktivni: true }) });
  assert.equal(r.status, 200, 'nastavení pracovní doby selhalo');
}
async function obnovPracovniDobu() {
  for (const [den, radek] of pracovniDobaPuvodni) {
    if (!radek) continue;
    await adminFetch(`/admin/pracovni-doba/${den}`, { method: 'PUT', body: JSON.stringify({ otevreno_od: radek.otevreno_od, otevreno_do: radek.otevreno_do, pauza_od: radek.pauza_od, pauza_do: radek.pauza_do, aktivni: radek.aktivni }) }).catch(() => {});
  }
}
let cenikCitac = 0;
async function vytvoritCenik(cena = 777) {
  cenikCitac++;
  const { status, data } = await adminJson('/admin/cenik', { method: 'POST', body: JSON.stringify({ skupina: 'TEST-STROMECEK-CENIK', varianta: 'v' + Date.now() + '-' + cenikCitac, delka_min: 60, cena, rezervovatelna: true }) });
  assert.equal(status, 200, 'vytvoření ceníku selhalo: ' + JSON.stringify(data));
  uklidCeniky.push(data.polozka.id);
  return data.polozka;
}
async function vytvoritAkci(nastaveni = {}) {
  const kod = 'TEST-STROMECEK-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const vcera = new Date(Date.now() - 86400000).toISOString();
  const zaMesic = new Date(Date.now() + 30 * 86400000).toISOString();
  const { status, data } = await adminJson('/admin/promo', { method: 'POST', body: JSON.stringify({ kod, nazev: 'test (smazat)', sleva_kc: 100, plati_od: vcera, plati_do: zaMesic, strop: 2, ...nastaveni }) });
  assert.equal(status, 200, 'vytvoření testovací akce selhalo: ' + JSON.stringify(data));
  uklidAkce.push(data.akce.kod);
  return data.akce;
}
let telefonCitac = 0;
let slotCitac = 0;
function novyTelefon() { telefonCitac++; return '73100' + String(1000 + telefonCitac); }
// každá rezervace dostane vlastní den (žádné kolize termínů mezi scénáři)
async function rezervovat(cenik, promoKod, extra = {}) {
  slotCitac++;
  const datum = dnyDopredu(20 + slotCitac);
  await zajistitSirokouDobu(datum);
  const vysledek = await verejne('/rezervace', {
    datum, cas_od: '10:00', jmeno: 'TEST-STROMECEK (smazat)', telefon: novyTelefon(), email: 'test-stromecek@example.invalid',
    cenik_id: cenik.id, souhlas_gdpr: true, promo_kod: promoKod, ...extra
  });
  if (vysledek.status === 200) {
    uklidRezervace.push(vysledek.data.rezervace.id);
    if (vysledek.data.rezervace.klientka_id) uklidKlientky.add(vysledek.data.rezervace.klientka_id);
  }
  return vysledek;
}
async function zadostOPoukaz(hodnota, promoKod) {
  const vysledek = await verejne('/poukazy/zadost', {
    hodnota, kupujici_jmeno: 'TEST-STROMECEK (smazat)', kupujici_email: 'test-stromecek@example.invalid', zpusob_platby: 'pri_prevzeti', promo_kod: promoKod
  });
  if (vysledek.status === 200) uklidZadosti.push(vysledek.data.zadost.id);
  return vysledek;
}
async function prehledAkce(kod) {
  const { data } = await adminJson('/admin/promo');
  return { akce: data.akce.find(a => a.kod === kod), vyuziti: data.vyuziti.filter(v => v.kod === kod) };
}
async function pocetRezervaci() { return (await adminFetch('/admin/rezervace').then(r => r.json())).length; }

const vysledky = [];
function ok(popis) { vysledky.push(popis); console.log('PASS — ' + popis); }

async function main() {
  console.log('=== Vánoční akce „Stromeček“ ===');

  // S1 — STROMECEK2026: kód je vidět jen během akce
  {
    const { status, data } = await verejne('/promo/stav');
    assert.equal(status, 200);
    assert.ok(['brzy', 'aktivni', 'vycerpano', 'skoncila', 'pozastaveno'].includes(data.stav), JSON.stringify(data));
    assert.equal(Boolean(data.kod), data.stav === 'aktivni', 'kód se smí vrátit jen ve stavu "aktivni"');
    if (data.stav === 'brzy') {
      const o = await verejne('/promo/overit', { kod: 'STROMECEK2026' });
      assert.equal(o.data.promoChyba, 'JESTE_NEPLATI');
    }
    ok(`S1) STROMECEK2026 ve stavu "${data.stav}" — kód ${data.kod ? 'vrácen' : 'skrytý'} správně`);
  }

  const akce = await vytvoritAkci();
  const cenik = await vytvoritCenik(777);

  // S2 — rezervace se slevou (kód s diakritikou a malými písmeny)
  let prvniRezervace;
  {
    const varianta = akce.kod.toLowerCase().replace('test', 'tést').replace('-s', ' - s');
    const pred = await verejne('/promo/stav?kod=' + encodeURIComponent(akce.kod));
    assert.equal(pred.data.stav, 'aktivni'); assert.equal(pred.data.kod, akce.kod); assert.equal(pred.data.zbyva, 2);
    const r = await rezervovat(cenik, varianta.replace(/ - /g, '-'));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    prvniRezervace = r.data.rezervace;
    assert.equal(Number(prvniRezervace.cena), 677); assert.equal(Number(prvniRezervace.sleva_kc), 100); assert.equal(prvniRezervace.promo_kod, akce.kod);
    const { vyuziti } = await prehledAkce(akce.kod);
    assert.equal(vyuziti.length, 1); assert.equal(vyuziti[0].status, 'pouzito'); assert.equal(vyuziti[0].typ, 'rezervace'); assert.equal(vyuziti[0].objednavka_id, prvniRezervace.id);
    assert.equal(vyuziti[0].rez_jmeno, 'TEST-STROMECEK (smazat)');
    ok('S2) rezervace s kódem (malá písmena, diakritika): 777 → 677 Kč, využití "pouzito" navázané na rezervaci');
  }

  // S3 — nejde kombinovat s dárkovým poukazem; neplatný kód nic neuloží
  {
    const pred = await pocetRezervaci();
    const a = await rezervovat(cenik, akce.kod, { poukaz_kod: 'ALESA-NECO' });
    assert.equal(a.status, 400); assert.match(a.data.chyba, /dárkovým poukazem/);
    const b = await rezervovat(cenik, 'NEEXISTUJE2026');
    assert.equal(b.status, 400); assert.equal(b.data.promoChyba, 'NEPLATNY');
    assert.equal(await pocetRezervaci(), pred, 'neplatný kód nesmí vytvořit rezervaci');
    ok('S3) kód + dárkový poukaz → 400; neplatný kód → 400 a rezervace nevznikne');
  }

  // S4 — bez kódu beze změny
  {
    const r = await rezervovat(cenik, '');
    assert.equal(r.status, 200); assert.equal(Number(r.data.rezervace.cena), 777); assert.equal(Number(r.data.rezervace.sleva_kc), 0);
    ok('S4) rezervace bez kódu: plná cena, žádná sleva');
  }

  // S5 — žádost o poukaz se slevou → schválení → poukaz s plnou hodnotou, účetnictví hodnota − sleva
  let druhaZadost;
  {
    const z = await zadostOPoukaz(1000, akce.kod);
    assert.equal(z.status, 200, JSON.stringify(z.data));
    assert.equal(Number(z.data.zadost.sleva_kc), 100); assert.equal(z.data.zadost.promo_kod, akce.kod);
    const pred = await adminJson('/admin/ucetnictvi');
    const s = await adminJson('/admin/poukazy/zadosti/' + z.data.zadost.id + '/stav', { method: 'PATCH', body: JSON.stringify({ stav: 'vyrizena' }) });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    uklidPoukazy.push(s.data.poukaz.id);
    assert.equal(Number(s.data.poukaz.hodnota), 1000); assert.equal(Number(s.data.poukaz.zustatek), 1000); assert.equal(Number(s.data.poukaz.sleva_kc), 100);
    const po = await adminJson('/admin/ucetnictvi');
    assert.equal(po.data.prodejPoukazu.celkem - pred.data.prodejPoukazu.celkem, 900, 'prodej poukazu se má počítat jako hodnota − sleva');
    druhaZadost = z.data.zadost;
    ok('S5) poukaz se slevou: zůstatek 1000 Kč, v účetnictví prodej 900 Kč');
  }

  // S6 — strop 2 je vyčerpaný (rezervace + poukaz) → další VYCERPANO, stav "vycerpano"
  {
    const r = await rezervovat(cenik, akce.kod);
    assert.equal(r.status, 400); assert.equal(r.data.promoChyba, 'VYCERPANO');
    const st = await verejne('/promo/stav?kod=' + encodeURIComponent(akce.kod));
    assert.equal(st.data.stav, 'vycerpano'); assert.equal(st.data.kod, undefined); assert.equal(st.data.zbyva, 0);
    ok('S6) po vyčerpání stropu: VYCERPANO, stav "vycerpano", kód se už nevrací');
  }

  // S7 — zrušení rezervace vrací slevu (UPDATE na "vraceno"), obnovení ji znovu uplatní
  {
    const z = await adminJson('/admin/rezervace/' + prvniRezervace.id + '/stav', { method: 'PATCH', body: JSON.stringify({ stav: 'zrusena' }) });
    assert.equal(z.status, 200);
    let p = await prehledAkce(akce.kod);
    assert.equal(p.akce.pouzito, 1); assert.equal(p.akce.vraceno, 1); assert.equal(p.akce.zbyva, 1);
    const v = p.vyuziti.find(x => x.typ === 'rezervace' && x.objednavka_id === prvniRezervace.id);
    assert.equal(v.status, 'vraceno'); assert.ok(v.vraceno_kdy); assert.equal(v.poznamka, 'Rezervace zrušena');
    const o = await adminJson('/admin/rezervace/' + prvniRezervace.id + '/stav', { method: 'PATCH', body: JSON.stringify({ stav: 'cekajici' }) });
    assert.equal(o.status, 200); assert.equal(o.data.promoZprava, undefined);
    p = await prehledAkce(akce.kod);
    assert.equal(p.akce.pouzito, 2); assert.equal(p.vyuziti.filter(x => x.typ === 'rezervace' && x.objednavka_id === prvniRezervace.id).length, 2, 'starý záznam zůstane (vraceno) + nový (pouzito)');
    ok('S7) zrušení → "vraceno" (záznam zůstane), obnovení → sleva znovu uplatněna');
  }

  // S8 — obnovení zrušené rezervace při plném stropu → plná cena + zpráva
  {
    await adminJson('/admin/rezervace/' + prvniRezervace.id + '/stav', { method: 'PATCH', body: JSON.stringify({ stav: 'zrusena' }) });
    const nova = await rezervovat(cenik, akce.kod);   // obsadí uvolněné místo
    assert.equal(nova.status, 200, JSON.stringify(nova.data));
    const o = await adminJson('/admin/rezervace/' + prvniRezervace.id + '/stav', { method: 'PATCH', body: JSON.stringify({ stav: 'potvrzena' }) });
    assert.equal(o.status, 200); assert.match(o.data.promoZprava, /plnou cenu 777 Kč/);
    const r = (await adminFetch('/admin/rezervace').then(x => x.json())).find(x => x.id === prvniRezervace.id);
    assert.equal(Number(r.cena), 777); assert.equal(Number(r.sleva_kc), 0); assert.equal(r.promo_kod, null);
    ok('S8) obnovení při vyčerpaném stropu: rezervace na plnou cenu, admin dostane vysvětlení');
  }

  // S9 — úprava rezervace v adminu (jiná masáž) slevu zachová
  {
    const p = await prehledAkce(akce.kod);
    const sp = p.vyuziti.find(x => x.typ === 'rezervace' && x.status === 'pouzito');
    const rez = (await adminFetch('/admin/rezervace').then(x => x.json())).find(x => x.id === sp.objednavka_id);
    const drazsi = await vytvoritCenik(1000);
    const u = await adminJson('/admin/rezervace/' + rez.id, { method: 'PATCH', body: JSON.stringify({ datum: rez.datum, cas_od: '12:00', cenik_id: drazsi.id, jmeno: rez.jmeno, telefon: rez.telefon, email: rez.email }) });
    assert.equal(u.status, 200, JSON.stringify(u.data));
    assert.equal(Number(u.data.rezervace.cena), 900); assert.equal(Number(u.data.rezervace.sleva_kc), 100);
    ok('S9) změna masáže v adminu: nová cena 1000 − sleva 100 = 900 Kč');

    // S10 — ruční „Vrátit (storno)“ v adminu: záznam → vraceno, rezervace zpět na plnou cenu
    const v = await adminJson('/admin/promo/vyuziti/' + sp.id + '/vratit', { method: 'POST' });
    assert.equal(v.status, 200); assert.equal(v.data.upraveno, 'rezervace');
    const po = (await adminFetch('/admin/rezervace').then(x => x.json())).find(x => x.id === rez.id);
    assert.equal(Number(po.cena), 1000); assert.equal(Number(po.sleva_kc), 0);
    const znovu = await adminJson('/admin/promo/vyuziti/' + sp.id + '/vratit', { method: 'POST' });
    assert.equal(znovu.status, 400);
    ok('S10) ruční vrácení v adminu: status "vraceno", rezervace zpět na 1000 Kč, druhé vrácení odmítnuto');
  }

  // S11 — smazání rezervace i zamítnutí/smazání žádosti vrací slevu; záznamy zůstávají
  {
    const r = await rezervovat(cenik, akce.kod);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await adminFetch('/admin/rezervace/' + r.data.rezervace.id, { method: 'DELETE' });
    let p = await prehledAkce(akce.kod);
    const vs = p.vyuziti.find(x => x.typ === 'rezervace' && x.objednavka_id === r.data.rezervace.id);
    assert.equal(vs.status, 'vraceno'); assert.equal(vs.poznamka, 'Rezervace smazána'); assert.equal(vs.rez_jmeno, null);

    const z = await zadostOPoukaz(500, akce.kod);
    assert.equal(z.status, 200, JSON.stringify(z.data));
    await adminJson('/admin/poukazy/zadosti/' + z.data.zadost.id + '/stav', { method: 'PATCH', body: JSON.stringify({ stav: 'zamitnuta' }) });
    p = await prehledAkce(akce.kod);
    assert.equal(p.vyuziti.find(x => x.typ === 'poukaz' && x.objednavka_id === z.data.zadost.id).status, 'vraceno');

    const z2 = await zadostOPoukaz(500, akce.kod);
    assert.equal(z2.status, 200, JSON.stringify(z2.data));
    await adminFetch('/admin/poukazy/zadosti/' + z2.data.zadost.id, { method: 'DELETE' });
    uklidZadosti.splice(uklidZadosti.indexOf(z2.data.zadost.id), 1);
    p = await prehledAkce(akce.kod);
    assert.equal(p.vyuziti.find(x => x.typ === 'poukaz' && x.objednavka_id === z2.data.zadost.id).status, 'vraceno');
    // smazání VYŘÍZENÉ žádosti slevu nevrací (poukaz už existuje)
    await adminFetch('/admin/poukazy/zadosti/' + druhaZadost.id, { method: 'DELETE' });
    uklidZadosti.splice(uklidZadosti.indexOf(druhaZadost.id), 1);
    p = await prehledAkce(akce.kod);
    assert.equal(p.vyuziti.find(x => x.typ === 'poukaz' && x.objednavka_id === druhaZadost.id).status, 'pouzito');
    ok('S11) smazaná rezervace / zamítnutá i smazaná nová žádost → "vraceno"; smazaná vyřízená žádost slevu drží');
  }

  // S12 — souběh: 4 rezervace najednou na 1 volné místo → přesně 1 se slevou
  {
    const souhra = await vytvoritAkci({ strop: 1 });
    const dny = [];
    for (let i = 0; i < 4; i++) { slotCitac++; const d = dnyDopredu(20 + slotCitac); await zajistitSirokouDobu(d); dny.push(d); }
    const vysledkyRez = await Promise.all(dny.map(datum => verejne('/rezervace', {
      datum, cas_od: '09:00', jmeno: 'TEST-STROMECEK (smazat)', telefon: novyTelefon(), email: 'test-stromecek@example.invalid',
      cenik_id: cenik.id, souhlas_gdpr: true, promo_kod: souhra.kod
    })));
    vysledkyRez.filter(v => v.status === 200).forEach(v => { uklidRezervace.push(v.data.rezervace.id); if (v.data.rezervace.klientka_id) uklidKlientky.add(v.data.rezervace.klientka_id); });
    assert.equal(vysledkyRez.filter(v => v.status === 200).length, 1, JSON.stringify(vysledkyRez.map(v => v.status)));
    assert.equal(vysledkyRez.filter(v => v.data && v.data.promoChyba === 'VYCERPANO').length, 3);
    const p = await prehledAkce(souhra.kod);
    assert.equal(p.akce.pouzito, 1);
    ok('S12) 4 souběžné rezervace na 1 místo → přesně 1 se slevou, 3× VYCERPANO');
  }

  // S13 — pozastavení a konec platnosti
  {
    const a = await vytvoritAkci();
    await adminJson('/admin/promo/' + a.kod, { method: 'PATCH', body: JSON.stringify({ aktivni: false }) });
    assert.equal((await rezervovat(cenik, a.kod)).data.promoChyba, 'NEAKTIVNI');
    assert.equal((await verejne('/promo/stav?kod=' + a.kod)).data.stav, 'pozastaveno');
    await adminJson('/admin/promo/' + a.kod, { method: 'PATCH', body: JSON.stringify({ aktivni: true, plati_do: new Date(Date.now() - 60000).toISOString() }) });
    assert.equal((await rezervovat(cenik, a.kod)).data.promoChyba, 'VYPRSEL');
    assert.equal((await verejne('/promo/stav?kod=' + a.kod)).data.stav, 'skoncila');
    const zitra = await vytvoritAkci({ plati_od: new Date(Date.now() + 86400000).toISOString() });
    assert.equal((await rezervovat(cenik, zitra.kod)).data.promoChyba, 'JESTE_NEPLATI');
    const st = (await verejne('/promo/stav?kod=' + zitra.kod)).data;
    assert.equal(st.stav, 'brzy'); assert.equal(st.kod, undefined);
    ok('S13) pozastaveno → NEAKTIVNI, po konci → VYPRSEL, před začátkem → JESTE_NEPLATI a kód skrytý');
  }

  // S14 — ověření kódu ve formuláři nic neukládá; CSV export
  {
    const a = await vytvoritAkci();
    const o = await verejne('/promo/overit', { kod: a.kod, typ: 'rezervace', cena: 777 });
    assert.equal(o.status, 200); assert.equal(o.data.sleva_kc, 100);
    assert.equal((await prehledAkce(a.kod)).akce.pouzito, 0);
    const buf = Buffer.from(await adminFetch('/admin/promo/export.csv').then(r => r.arrayBuffer()));
    assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'CSV musí začínat BOM (Excel pak pozná UTF-8)');
    const csv = buf.toString('utf8');
    assert.ok(csv.slice(1).startsWith('"Datum";"Kód"'), 'CSV hlavička');
    assert.ok(csv.includes(akce.kod) && csv.includes('Vráceno') && csv.includes('Použito'));
    ok('S14) ověření kódu nic neukládá; CSV export obsahuje využití i vrácené');
  }
}

main()
  .then(() => { console.log('\n✅ VŠECHNY TESTY AKCE STROMEČEK PROŠLY (' + vysledky.length + ' scénářů)'); })
  .catch(e => { console.error('CHYBA:', e); process.exitCode = 1; })
  .finally(async () => {
    console.log('\n--- úklid ---');
    for (const id of uklidRezervace) await adminFetch('/admin/rezervace/' + id, { method: 'DELETE' }).catch(() => {});
    for (const id of uklidZadosti) await adminFetch('/admin/poukazy/zadosti/' + id, { method: 'DELETE' }).catch(() => {});
    for (const id of uklidPoukazy) await adminFetch('/admin/poukazy/' + id, { method: 'DELETE' }).catch(() => {});
    for (const id of uklidKlientky) await adminFetch('/admin/klientky/' + id, { method: 'DELETE' }).catch(() => {});
    for (const id of uklidCeniky) await adminFetch('/admin/cenik/' + id, { method: 'DELETE' }).catch(() => {});
    for (const kod of uklidAkce) await adminFetch('/admin/promo/' + kod, { method: 'PATCH', body: JSON.stringify({ aktivni: false }) }).catch(() => {});
    await obnovPracovniDobu();
    console.log(`(uklizeno: ${uklidRezervace.length} rezervací, ${uklidZadosti.length} žádostí, ${uklidPoukazy.length} poukazů, ${uklidKlientky.size} klientek, ${uklidCeniky.length} ceníků; ${uklidAkce.length} testovacích akcí vypnuto)`);
  });
