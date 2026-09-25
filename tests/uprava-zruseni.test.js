// Regresní test: úprava a zrušení rezervace + e-maily (Fáze 4).
// 19 scénářů ze zadání (testy 1–9 a 11–19; test 10/12 ověřuje aspoň příznak
// "e-mail se pokusil odeslat", reálné doručení nelze z testu ověřit).
//
// Spuštění:  ADMIN_HESLO=... node tests/uprava-zruseni.test.js

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
async function dvaVolneTerminySameDen(cenikId, odpocetDni) {
  for (let i = odpocetDni; i < odpocetDni + 90; i += 3) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const terminy = await fetch(`${API}/rezervace/volne-terminy?datum=${iso}&cenik_id=${cenikId}`).then(r => r.json());
    const volne = Array.isArray(terminy) ? terminy.filter(t => t.volno) : [];
    if (volne.length >= 4) return { datum: iso, cas1: volne[0].cas, cas2: volne[volne.length - 1].cas };
  }
  throw new Error('Nenalezen den se dvěma volnými termíny pro test');
}
async function najitNejblizsiNedeli(odpocetDni) {
  for (let i = odpocetDni; i < odpocetDni + 30; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    if (d.getDay() === 0) return d.toISOString().slice(0, 10);
  }
  throw new Error('Nenalezena neděle pro test');
}
async function vytvorRezervaci(cenikId, telefonSuffix, odpocetDni) {
  const { datum, cas } = await novyVolnyTermin(cenikId, odpocetDni);
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: cas, jmeno: 'TEST-UPRAVA (smazat)', telefon: '00000' + telefonSuffix, email: 'test-uprava@example.cz' })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'Vytvoření testovací rezervace selhalo: ' + JSON.stringify(data));
  return data.rezervace;
}
async function upravit(id, zmeny) {
  const res = await adminFetch(`/admin/rezervace/${id}`, { method: 'PATCH', body: JSON.stringify(zmeny) });
  return { status: res.status, data: await res.json() };
}
async function historiePlateb(id) {
  return adminFetch(`/admin/rezervace/${id}/platby`).then(r => r.json());
}

const uklidRezervace = [];
const uklidPoukazy = [];

async function main() {
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const rezervovatelne = cenik.filter(c => c.rezervovatelna);
    const polozka = rezervovatelne[0];
    const jinaPolozka = rezervovatelne.find(c => c.id !== polozka.id) || polozka;
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');

    const zakladniTvar = r => ({
      cenik_id: r.cenik_id, datum: r.datum, cas_od: String(r.cas_od).slice(0, 5),
      jmeno: r.jmeno, telefon: r.telefon, email: r.email || '', poznamka: r.poznamka || ''
    });

    // Test 1: úprava data
    console.log('--- Test 1: úprava data ---');
    {
      const r = await vytvorRezervaci(polozka.id, '30', 30 + Math.floor(Math.random() * 200));
      uklidRezervace.push(r.id);
      const { datum: novyDatum } = await novyVolnyTermin(polozka.id, 250);
      const t = zakladniTvar(r); t.datum = novyDatum;
      const { status, data } = await upravit(r.id, t);
      assert.equal(status, 200, JSON.stringify(data));
      assert.equal(data.rezervace.datum, novyDatum);
      assert.equal(data.terminZmenen, true);
      console.log('OK — datum úspěšně změněno, terminZmenen=true');
    }

    // Test 2: úprava času
    console.log('--- Test 2: úprava času ---');
    {
      const r = await vytvorRezervaci(polozka.id, '31', 30 + Math.floor(Math.random() * 200));
      uklidRezervace.push(r.id);
      const terminy = await fetch(`${API}/rezervace/volne-terminy?datum=${r.datum}&cenik_id=${polozka.id}`).then(x => x.json());
      const jinyCas = terminy.find(x => x.volno && x.cas !== String(r.cas_od).slice(0, 5));
      assert.ok(jinyCas, 'Nenalezen jiný volný čas ve stejný den pro test');
      const t = zakladniTvar(r); t.cas_od = jinyCas.cas;
      const { status, data } = await upravit(r.id, t);
      assert.equal(status, 200, JSON.stringify(data));
      assert.equal(String(data.rezervace.cas_od).slice(0, 5), jinyCas.cas);
      assert.equal(data.terminZmenen, true);
      console.log('OK — čas úspěšně změněn na ' + jinyCas.cas);
    }

    // Test 3: úprava služby (a tím i ceny)
    console.log('--- Test 3: úprava služby ---');
    if (jinaPolozka.id !== polozka.id) {
      const r = await vytvorRezervaci(polozka.id, '32', 30 + Math.floor(Math.random() * 200));
      uklidRezervace.push(r.id);
      // Najít volný čas pro NOVOU masáž ten samý den (jiná délka může kolidovat)
      const terminyNove = await fetch(`${API}/rezervace/volne-terminy?datum=${r.datum}&cenik_id=${jinaPolozka.id}`).then(x => x.json());
      const volnyProNovou = terminyNove.find(x => x.volno);
      const t = zakladniTvar(r);
      t.cenik_id = jinaPolozka.id;
      t.cas_od = volnyProNovou ? volnyProNovou.cas : t.cas_od;
      const { status, data } = await upravit(r.id, t);
      assert.equal(status, 200, JSON.stringify(data));
      assert.equal(Number(data.rezervace.cena), Number(jinaPolozka.cena));
      assert.ok(data.rezervace.masaz.includes(jinaPolozka.varianta));
      console.log('OK — služba i cena úspěšně změněny (' + jinaPolozka.cena + ' Kč)');
    } else {
      console.log('(přeskočeno — v ceníku je jen jedna rezervovatelná položka)');
    }

    // Test 4: úprava poznámky — beze změny termínu, bez e-mailu
    console.log('--- Test 4: úprava poznámky ---');
    {
      const r = await vytvorRezervaci(polozka.id, '33', 30 + Math.floor(Math.random() * 200));
      uklidRezervace.push(r.id);
      const t = zakladniTvar(r); t.poznamka = 'nová testovací poznámka';
      const { status, data } = await upravit(r.id, t);
      assert.equal(status, 200, JSON.stringify(data));
      assert.equal(data.rezervace.poznamka, 'nová testovací poznámka');
      assert.equal(data.terminZmenen, false, 'Změna poznámky nesmí vypadat jako změna termínu');
      assert.equal(data.zmeneno, true);
      console.log('OK — poznámka změněna, terminZmenen=false (žádný e-mail o změně termínu)');
    }

    // Test 5: změna klientských údajů
    console.log('--- Test 5: změna klientských údajů ---');
    {
      const r = await vytvorRezervaci(polozka.id, '34', 30 + Math.floor(Math.random() * 200));
      uklidRezervace.push(r.id);
      const t = zakladniTvar(r); t.jmeno = 'Jiné Jméno'; t.telefon = '111222333';
      const { status, data } = await upravit(r.id, t);
      assert.equal(status, 200, JSON.stringify(data));
      assert.equal(data.rezervace.jmeno, 'Jiné Jméno');
      assert.equal(data.rezervace.telefon, '111222333');
      assert.equal(data.terminZmenen, false);
      console.log('OK — jméno/telefon změněny, termín beze změny');
    }

    // Test 6: přesun na obsazený termín → zamítnuto
    console.log('--- Test 6: přesun na obsazený termín ---');
    {
      const { datum, cas1, cas2 } = await dvaVolneTerminySameDen(polozka.id, 30 + Math.floor(Math.random() * 100));
      const rA = await adminFetch('/admin/rezervace', { method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, datum, cas_od: cas1, jmeno: 'TEST-UPRAVA-A (smazat)', telefon: '000000035' }) }).then(x => x.json());
      uklidRezervace.push(rA.rezervace.id);
      const rB = await adminFetch('/admin/rezervace', { method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, datum, cas_od: cas2, jmeno: 'TEST-UPRAVA-B (smazat)', telefon: '000000036' }) }).then(x => x.json());
      uklidRezervace.push(rB.rezervace.id);

      const t = zakladniTvar(rB.rezervace); t.cas_od = cas1; // pokusit se přesunout B na čas A
      const { status, data } = await upravit(rB.rezervace.id, t);
      assert.equal(status, 409, 'Přesun na obsazený termín měl být zamítnut: ' + JSON.stringify(data));
      console.log('OK — přesun na obsazený termín zamítnut (409): ' + data.chyba);
    }

    // Test 7: přesun mimo pracovní dobu → zamítnuto
    console.log('--- Test 7: přesun mimo pracovní dobu ---');
    {
      const r = await vytvorRezervaci(polozka.id, '37', 30 + Math.floor(Math.random() * 200));
      uklidRezervace.push(r.id);
      const t = zakladniTvar(r); t.cas_od = '23:30';
      const { status, data } = await upravit(r.id, t);
      assert.equal(status, 400, 'Přesun mimo otevírací dobu měl být zamítnut: ' + JSON.stringify(data));
      console.log('OK — přesun mimo otevírací dobu zamítnut (400): ' + data.chyba);
    }

    // Test 8: přesun na uzavřený den (neděle) → zamítnuto
    console.log('--- Test 8: přesun na uzavřený den ---');
    {
      const r = await vytvorRezervaci(polozka.id, '38', 30 + Math.floor(Math.random() * 200));
      uklidRezervace.push(r.id);
      const nedele = await najitNejblizsiNedeli(30);
      const t = zakladniTvar(r); t.datum = nedele; t.cas_od = '10:00';
      const { status, data } = await upravit(r.id, t);
      assert.equal(status, 400, 'Přesun na uzavřený den měl být zamítnut: ' + JSON.stringify(data));
      console.log('OK — přesun na uzavřený den (' + nedele + ') zamítnut (400): ' + data.chyba);
    }

    // Test 9: změna bez skutečné změny → bez zbytečného e-mailu
    console.log('--- Test 9: uložení beze změny ---');
    {
      const r = await vytvorRezervaci(polozka.id, '39', 30 + Math.floor(Math.random() * 200));
      uklidRezervace.push(r.id);
      const t = zakladniTvar(r); // identické hodnoty
      const { status, data } = await upravit(r.id, t);
      assert.equal(status, 200, JSON.stringify(data));
      assert.equal(data.terminZmenen, false);
      assert.equal(data.zmeneno, false, 'Odeslání identických hodnot nesmí vypadat jako reálná změna');
      console.log('OK — uložení beze změny: zmeneno=false, terminZmenen=false (žádný zbytečný e-mail)');
    }

    // Test 10: změna rezervace → příznak e-mailu o změně
    console.log('--- Test 10: příznak e-mailu při reálné změně termínu ---');
    {
      const r = await vytvorRezervaci(polozka.id, '40', 30 + Math.floor(Math.random() * 200));
      uklidRezervace.push(r.id);
      const { datum: novyDatum } = await novyVolnyTermin(polozka.id, 260);
      const t = zakladniTvar(r); t.datum = novyDatum;
      const { status, data } = await upravit(r.id, t);
      assert.equal(status, 200, JSON.stringify(data));
      assert.equal(data.terminZmenen, true, 'Reálná změna termínu musí nastavit terminZmenen (spouští e-mail)');
      console.log('OK — reálná změna termínu nastavuje terminZmenen=true (e-mail o změně se odešle, protože rezervace má e-mail)');
    }

    // Test 11 + 12: zrušení → stav zrušena + příznak e-mailu
    console.log('--- Test 11/12: zrušení rezervace ---');
    let rZruseni;
    {
      const r = await vytvorRezervaci(polozka.id, '41', 30 + Math.floor(Math.random() * 200));
      uklidRezervace.push(r.id);
      const { status, data } = await adminFetch(`/admin/rezervace/${r.id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zrusena' }) }).then(async res => ({ status: res.status, data: await res.json() }));
      assert.equal(status, 200, JSON.stringify(data));
      assert.equal(data.emailOdeslan, true, 'První zrušení musí nastavit emailOdeslan=true (rezervace má e-mail)');
      const seznam = await adminFetch('/admin/rezervace').then(res => res.json());
      const aktualni = seznam.find(x => x.id === r.id);
      assert.equal(aktualni.stav, 'zrusena');
      console.log('OK — rezervace zrušena, emailOdeslan=true při první změně na "zrusena"');
      rZruseni = r;
    }

    // Test 19: opakované zrušení → bez duplicitního e-mailu
    console.log('--- Test 19: opakované zrušení ---');
    {
      const { status, data } = await adminFetch(`/admin/rezervace/${rZruseni.id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zrusena' }) }).then(async res => ({ status: res.status, data: await res.json() }));
      assert.equal(status, 200, JSON.stringify(data));
      assert.equal(data.emailOdeslan, false, 'Opakované zrušení už zrušené rezervace nesmí znovu poslat e-mail');
      console.log('OK — opakované zrušení: emailOdeslan=false (bez duplicitního e-mailu)');
    }

    // Test 13 + 14: zrušení zachová platební historii a nevytvoří automatickou vratku
    console.log('--- Test 13/14: zrušení zaplacené rezervace ---');
    {
      const r = await vytvorRezervaci(polozka.id, '42', 30 + Math.floor(Math.random() * 200));
      uklidRezervace.push(r.id);
      await adminFetch(`/admin/rezervace/${r.id}/platba`, { method: 'PATCH', body: JSON.stringify({ castka: Number(r.cena), zpusob_platby: 'hotove' }) });
      const historiePred = await historiePlateb(r.id);
      assert.equal(historiePred.length, 1);

      await adminFetch(`/admin/rezervace/${r.id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zrusena' }) });

      const historiePo = await historiePlateb(r.id);
      assert.equal(historiePo.length, 1, 'Zrušení nesmí přidat ani ubrat záznam v deníku plateb');
      assert.deepEqual(historiePred, historiePo, 'Historie plateb se zrušením nesmí nijak změnit');
      const zadnaVratka = !historiePo.some(h => h.typ === 'vratka');
      assert.ok(zadnaVratka, 'Zrušení nesmí samo vytvořit vratku');

      const seznam = await adminFetch('/admin/rezervace').then(res => res.json());
      const aktualni = seznam.find(x => x.id === r.id);
      assert.equal(Number(aktualni.uhrazeno), Number(r.cena), 'uhrazeno se zrušením nesmí vynulovat');
      assert.equal(aktualni.stav, 'zrusena');
      console.log('OK — zrušení zaplacené rezervace: historie plateb beze změny, žádná automatická vratka, uhrazeno zachováno');
    }

    // Test 15: rezervace s více platbami → historie zachována po editaci
    console.log('--- Test 15: editace nemění historii více plateb ---');
    {
      const r = await vytvorRezervaci(polozka.id, '43', 30 + Math.floor(Math.random() * 200));
      uklidRezervace.push(r.id);
      const cena = Number(r.cena);
      const c1 = Math.max(1, Math.floor(cena * 0.3));
      await adminFetch(`/admin/rezervace/${r.id}/platba`, { method: 'PATCH', body: JSON.stringify({ castka: c1, zpusob_platby: 'hotove' }) });
      await adminFetch(`/admin/rezervace/${r.id}/platba`, { method: 'PATCH', body: JSON.stringify({ castka: c1, zpusob_platby: 'kartou' }) });
      const historiePred = await historiePlateb(r.id);
      assert.equal(historiePred.length, 2);

      const t = zakladniTvar(r); t.poznamka = 'editace po platbách';
      // Znovu načíst aktuální cenik_id/datum/cas_od (nezměněné)
      const cerstva = await adminFetch('/admin/rezervace').then(res => res.json()).then(list => list.find(x => x.id === r.id));
      const t2 = zakladniTvar(cerstva); t2.poznamka = 'editace po platbách';
      const { status, data } = await upravit(r.id, t2);
      assert.equal(status, 200, JSON.stringify(data));

      const historiePo = await historiePlateb(r.id);
      assert.deepEqual(historiePred, historiePo, 'Editace nesmí měnit historii plateb');
      assert.equal(Number(data.rezervace.uhrazeno), c1 + c1, 'uhrazeno musí zůstat součtem obou plateb');
      console.log('OK — editace rezervace se dvěma platbami: historie i uhrazeno beze změny');
    }

    // Test 16: rezervace s poukazem → vazba zachována po editaci
    console.log('--- Test 16: editace nemění vazbu na poukaz ---');
    {
      const r = await vytvorRezervaci(polozka.id, '44', 30 + Math.floor(Math.random() * 200));
      uklidRezervace.push(r.id);
      const poukazRes = await adminFetch('/admin/poukazy', { method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-UPRAVA-POUKAZ (smazat)' }) }).then(x => x.json());
      uklidPoukazy.push(poukazRes.poukaz.id);
      const castPoukazem = Math.max(1, Math.floor(Number(r.cena) * 0.5));
      await adminFetch(`/admin/poukazy/${poukazRes.poukaz.id}/uplatnit`, { method: 'POST', body: JSON.stringify({ castka: castPoukazem, rezervace_id: r.id }) });

      const cerstva = await adminFetch('/admin/rezervace').then(res => res.json()).then(list => list.find(x => x.id === r.id));
      const t = zakladniTvar(cerstva); t.poznamka = 'editace po uplatnění poukazu';
      const { status } = await upravit(r.id, t);
      assert.equal(status, 200);

      const historie = await historiePlateb(r.id);
      const poukazRadek = historie.find(h => h.zpusob_platby === 'poukaz');
      assert.ok(poukazRadek, 'Vazba na poukaz v deníku musí zůstat po editaci');
      assert.equal(poukazRadek.poukaz_id, poukazRes.poukaz.id);
      assert.equal(Number(poukazRadek.castka), castPoukazem);
      console.log('OK — editace rezervace s poukazem: vazba na poukaz v deníku zachována');
    }

    // Test 17: změna ceny po částečné úhradě
    console.log('--- Test 17: změna ceny po částečné úhradě ---');
    if (jinaPolozka.id !== polozka.id) {
      const r = await vytvorRezervaci(polozka.id, '45', 30 + Math.floor(Math.random() * 200));
      uklidRezervace.push(r.id);
      const castecna = Math.max(1, Math.floor(Number(r.cena) * 0.3));
      await adminFetch(`/admin/rezervace/${r.id}/platba`, { method: 'PATCH', body: JSON.stringify({ castka: castecna, zpusob_platby: 'hotove' }) });

      const cerstva = await adminFetch('/admin/rezervace').then(res => res.json()).then(list => list.find(x => x.id === r.id));
      const terminyNove = await fetch(`${API}/rezervace/volne-terminy?datum=${cerstva.datum}&cenik_id=${jinaPolozka.id}`).then(x => x.json());
      const volnyProNovou = terminyNove.find(x => x.volno);
      const t = zakladniTvar(cerstva); t.cenik_id = jinaPolozka.id; if (volnyProNovou) t.cas_od = volnyProNovou.cas;
      const { status, data } = await upravit(r.id, t);
      assert.equal(status, 200, JSON.stringify(data));
      assert.equal(Number(data.rezervace.uhrazeno), castecna, 'Částečná úhrada se nesmí při změně ceny ztratit');
      assert.equal(Number(data.rezervace.cena), Number(jinaPolozka.cena));
      const ocekavanyStav = castecna >= Number(jinaPolozka.cena) ? 'zaplaceno' : 'castecne_zaplaceno';
      assert.equal(data.rezervace.stav_platby, ocekavanyStav);
      console.log('OK — změna ceny po částečné úhradě: uhrazeno (' + castecna + ' Kč) zachováno, nová cena ' + jinaPolozka.cena + ' Kč, stav "' + ocekavanyStav + '"');
    } else {
      console.log('(přeskočeno — v ceníku je jen jedna rezervovatelná položka)');
    }

    // Test 18: změna ceny po úplné úhradě (nová cena nižší → "přeplatek")
    console.log('--- Test 18: změna ceny po úplné úhradě ---');
    if (jinaPolozka.id !== polozka.id) {
      const dražší = Number(polozka.cena) >= Number(jinaPolozka.cena) ? polozka : jinaPolozka;
      const levnější = dražší.id === polozka.id ? jinaPolozka : polozka;
      const r = await vytvorRezervaci(dražší.id, '46', 30 + Math.floor(Math.random() * 200));
      uklidRezervace.push(r.id);
      await adminFetch(`/admin/rezervace/${r.id}/platba`, { method: 'PATCH', body: JSON.stringify({ castka: Number(dražší.cena), zpusob_platby: 'hotove' }) });

      const cerstva = await adminFetch('/admin/rezervace').then(res => res.json()).then(list => list.find(x => x.id === r.id));
      const terminyNove = await fetch(`${API}/rezervace/volne-terminy?datum=${cerstva.datum}&cenik_id=${levnější.id}`).then(x => x.json());
      const volnyProNovou = terminyNove.find(x => x.volno);
      const t = zakladniTvar(cerstva); t.cenik_id = levnější.id; if (volnyProNovou) t.cas_od = volnyProNovou.cas;
      const { status, data } = await upravit(r.id, t);
      assert.equal(status, 200, JSON.stringify(data));
      assert.equal(Number(data.rezervace.uhrazeno), Number(dražší.cena), 'Plná úhrada se nesmí při změně ceny snížit/ztratit');
      assert.equal(Number(data.rezervace.cena), Number(levnější.cena));
      assert.equal(data.rezervace.stav_platby, 'zaplaceno', 'Uhrazeno >= nová cena musí zůstat "zaplaceno" (přeplatek), ne se resetovat');
      console.log('OK — změna na levnější službu po plné úhradě: uhrazeno (' + dražší.cena + ' Kč) zachováno i když převyšuje novou cenu (' + levnější.cena + ' Kč), stav zůstává "zaplaceno" (přeplatek ' + (Number(dražší.cena) - Number(levnější.cena)) + ' Kč, k řešení ruční vratkou)');
    } else {
      console.log('(přeskočeno — v ceníku je jen jedna rezervovatelná položka)');
    }

    console.log('\n✅ VŠECHNY TESTY ÚPRAVY A ZRUŠENÍ REZERVACE PROŠLY');
  } finally {
    for (const id of uklidRezervace) await adminFetch(`/admin/rezervace/${id}`, { method: 'DELETE' });
    for (const id of uklidPoukazy) await adminFetch(`/admin/poukazy/${id}`, { method: 'DELETE' });
    if (uklidRezervace.length || uklidPoukazy.length) {
      console.log(`(uklizeno: ${uklidRezervace.length} testovacích rezervací, ${uklidPoukazy.length} testovacích poukazů)`);
    }
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
