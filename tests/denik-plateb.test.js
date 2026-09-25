// Regresní test: deník plateb a nové Účetnictví (Fáze 3B).
// 12 scénářů ze zadání.
//
// Spuštění:  ADMIN_HESLO=... node tests/denik-plateb.test.js

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
async function vytvorRezervaci(cenikId, telefonSuffix, odpocetDni) {
  const { datum, cas } = await novyVolnyTermin(cenikId, odpocetDni);
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: cas, jmeno: 'TEST-DENIK (smazat)', telefon: '00000' + telefonSuffix })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'Vytvoření testovací rezervace selhalo: ' + JSON.stringify(data));
  return data.rezervace;
}
async function platba(id, castka, zpusob_platby, typ) {
  return adminFetch(`/admin/rezervace/${id}/platba`, {
    method: 'PATCH', body: JSON.stringify({ castka, zpusob_platby, ...(typ ? { typ } : {}) })
  }).then(r => r.json().then(data => ({ status: r.status, data })));
}
async function historiePlateb(id) {
  return adminFetch(`/admin/rezervace/${id}/platby`).then(r => r.json());
}

const uklidRezervace = [];
const uklidPoukazy = [];

async function main() {
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');
    const cena = Number(polozka.cena);

    // Test 1: jedna platba 900 Kč (v testu = celá cena masáže)
    console.log('--- Test 1: jedna platba v plné výši ---');
    {
      const r = await vytvorRezervaci(polozka.id, '10', 30 + Math.floor(Math.random() * 300));
      uklidRezervace.push(r.id);
      const { status, data } = await platba(r.id, cena, 'hotove');
      assert.equal(status, 200, JSON.stringify(data));
      assert.equal(Number(data.rezervace.uhrazeno), cena);
      assert.equal(data.rezervace.stav_platby, 'zaplaceno');
      const historie = await historiePlateb(r.id);
      assert.equal(historie.length, 1);
      assert.equal(Number(historie[0].castka), cena);
      assert.equal(historie[0].typ, 'platba');
      console.log('OK — jedna platba: uhrazeno = cena, 1 záznam v deníku');
    }

    // Test 2: 400 + 500 Kč (dvě samostatné platby, každá se svým datem v deníku)
    console.log('--- Test 2: dvě platby ve dvou krocích ---');
    {
      const r = await vytvorRezervaci(polozka.id, '11', 30 + Math.floor(Math.random() * 300));
      uklidRezervace.push(r.id);
      const c1 = Math.max(1, Math.floor(cena * 0.4));
      const c2 = cena - c1;
      const p1 = await platba(r.id, c1, 'hotove');
      assert.equal(p1.status, 200, JSON.stringify(p1.data));
      const p2 = await platba(r.id, c2, 'kartou');
      assert.equal(p2.status, 200, JSON.stringify(p2.data));
      assert.equal(Number(p2.data.rezervace.uhrazeno), cena);
      assert.equal(p2.data.rezervace.stav_platby, 'zaplaceno');
      const historie = await historiePlateb(r.id);
      assert.equal(historie.length, 2, 'Očekávány 2 samostatné záznamy v deníku');
      assert.equal(Number(historie[0].castka), c1);
      assert.equal(historie[0].zpusob_platby, 'hotove');
      assert.equal(Number(historie[1].castka), c2);
      assert.equal(historie[1].zpusob_platby, 'kartou');
      assert.ok(historie[0].vytvoreno && historie[1].vytvoreno, 'Obě platby mají vlastní datum/čas');
      console.log('OK — dvě platby: 2 záznamy v deníku, každý se svým datem, součet = cena');
    }

    // Test 3: poukaz 600 + hotově 300 (poukaz pokryje část, doplatek zbytek)
    console.log('--- Test 3: poukaz + doplatek hotově ---');
    {
      const r = await vytvorRezervaci(polozka.id, '12', 30 + Math.floor(Math.random() * 300));
      uklidRezervace.push(r.id);
      const poukazRes = await adminFetch('/admin/poukazy', {
        method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-DENIK-POUKAZ (smazat)' })
      }).then(res => res.json());
      uklidPoukazy.push(poukazRes.poukaz.id);
      const castPoukazem = Math.max(1, Math.floor(cena * 0.6));
      const doplatek = cena - castPoukazem;

      const u = await adminFetch(`/admin/poukazy/${poukazRes.poukaz.id}/uplatnit`, {
        method: 'POST', body: JSON.stringify({ castka: castPoukazem, rezervace_id: r.id })
      }).then(res => res.json());
      assert.equal(Number(u.rezervace.uhrazeno), castPoukazem);

      const d = await platba(r.id, doplatek, 'hotove');
      assert.equal(d.status, 200, JSON.stringify(d.data));
      assert.equal(Number(d.data.rezervace.uhrazeno), cena);
      assert.equal(d.data.rezervace.stav_platby, 'zaplaceno');

      const historie = await historiePlateb(r.id);
      assert.equal(historie.length, 2);
      const poukazRadek = historie.find(h => h.zpusob_platby === 'poukaz');
      const hotoveRadek = historie.find(h => h.zpusob_platby === 'hotove');
      assert.ok(poukazRadek && Number(poukazRadek.castka) === castPoukazem);
      assert.ok(hotoveRadek && Number(hotoveRadek.castka) === doplatek);
      assert.equal(poukazRadek.poukaz_id, poukazRes.poukaz.id, 'Vazba na poukaz v deníku chybí');
      console.log('OK — poukaz (' + castPoukazem + ' Kč) + doplatek hotově (' + doplatek + ' Kč): oba řádky v deníku, vazba na poukaz zachovaná');
    }

    // Test 4: prodej poukazu → pozdější uplatnění → žádné dvojí započítání v Účetnictví
    console.log('--- Test 4: poukaz se v Přijatých platbách nepočítá dvakrát ---');
    {
      const r = await vytvorRezervaci(polozka.id, '13', 30 + Math.floor(Math.random() * 300));
      uklidRezervace.push(r.id);
      const poukazRes = await adminFetch('/admin/poukazy', {
        method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-DENIK-DVOJI (smazat)' })
      }).then(res => res.json());
      uklidPoukazy.push(poukazRes.poukaz.id);
      const hodnotaPoukazu = Number(poukazRes.poukaz.hodnota);

      await adminFetch(`/admin/poukazy/${poukazRes.poukaz.id}/uplatnit`, {
        method: 'POST', body: JSON.stringify({ castka: hodnotaPoukazu, rezervace_id: r.id })
      });

      const ucetnictvi = await adminFetch('/admin/ucetnictvi').then(res => res.json());
      const prodejTohotoPoukazu = ucetnictvi.prodejPoukazu.pocet; // jen sanity, hlavní je částka níž
      const jePoukazVPrijatychPlatbach = ucetnictvi.prijatePlatby.seznam.some(p => p.zpusob_platby === 'poukaz');
      assert.equal(jePoukazVPrijatychPlatbach, false, 'Uplatnění poukazu se objevilo v Přijatých platbách — dvojí započítání!');
      console.log('OK — uplatnění poukazu se v Přijatých platbách neobjevuje (žádné dvojí započítání), prodej poukazů evidován samostatně (' + prodejTohotoPoukazu + ' položek v evidenci)');
    }

    // Test 5: 900 zaplaceno → vratka 900 → oba záznamy v deníku, uhrazeno = 0
    console.log('--- Test 5: plná platba a plná vratka ---');
    {
      const r = await vytvorRezervaci(polozka.id, '14', 30 + Math.floor(Math.random() * 300));
      uklidRezervace.push(r.id);
      await platba(r.id, cena, 'hotove');
      const v = await platba(r.id, cena, 'hotove', 'vratka');
      assert.equal(v.status, 200, JSON.stringify(v.data));
      assert.equal(Number(v.data.rezervace.uhrazeno), 0);
      assert.equal(v.data.rezervace.stav_platby, 'nezaplaceno');
      const historie = await historiePlateb(r.id);
      assert.equal(historie.length, 2, 'Vratka nesmí smazat historii — má přibýt, ne nahradit');
      assert.equal(historie[0].typ, 'platba');
      assert.equal(Number(historie[0].castka), cena);
      assert.equal(historie[1].typ, 'vratka');
      assert.equal(Number(historie[1].castka), -cena);
      console.log('OK — vratka nemaže historii: +' + cena + ' Kč platba a -' + cena + ' Kč vratka oba v deníku, uhrazeno = 0');
    }

    // Test 6: částečná vratka
    console.log('--- Test 6: částečná vratka ---');
    {
      const r = await vytvorRezervaci(polozka.id, '15', 30 + Math.floor(Math.random() * 300));
      uklidRezervace.push(r.id);
      await platba(r.id, cena, 'hotove');
      const vratka = Math.max(1, Math.floor(cena / 3));
      const v = await platba(r.id, vratka, 'hotove', 'vratka');
      assert.equal(v.status, 200, JSON.stringify(v.data));
      assert.equal(Number(v.data.rezervace.uhrazeno), cena - vratka);
      assert.equal(v.data.rezervace.stav_platby, 'castecne_zaplaceno');
      console.log('OK — částečná vratka (' + vratka + ' Kč): uhrazeno = ' + (cena - vratka) + ' Kč, stav "castecne_zaplaceno"');

      // Nejde vrátit víc, než bylo uhrazeno
      const prilis = await platba(r.id, cena, 'hotove', 'vratka');
      assert.equal(prilis.status, 400, 'Vratka převyšující uhrazenou částku měla selhat');
      console.log('OK — vratka převyšující uhrazenou částku je odmítnuta');
    }

    // Test 7 + 8: přijatá platba před datem masáže vs. v den masáže —
    // ověří, že Tržby za služby (A) a Přijaté platby (B) používají různá data.
    console.log('--- Test 7/8: platba předem vs. v den masáže (různá data v A a B) ---');
    {
      const r = await vytvorRezervaci(polozka.id, '16', 45); // masáž ~45 dní dopředu
      uklidRezervace.push(r.id);
      await platba(r.id, cena, 'hotove'); // platba "dnes", masáž je v budoucnu
      const dnesIso = new Date().toISOString().slice(0, 10);

      const ucetnictvi = await adminFetch('/admin/ucetnictvi').then(res => res.json());
      const trzbaPodDnesnimDnem = ucetnictvi.trzbyZaSluzby.podleDne.find(d => d.den === dnesIso);
      const trzbaPodDatumMasaze = ucetnictvi.trzbyZaSluzby.podleDne.find(d => d.den === r.datum);
      const platbaPodDnesnimDnem = ucetnictvi.prijatePlatby.podleDne.find(d => d.den === dnesIso);

      assert.ok(trzbaPodDatumMasaze, 'Tržba za službu chybí pod datem masáže');
      assert.ok(platbaPodDnesnimDnem, 'Přijatá platba chybí pod dnešním dnem (kdy reálně přišla)');
      if (dnesIso !== r.datum) {
        console.log('OK — tržba za službu je pod datem masáže (' + r.datum + '), přijatá platba pod dneškem (' + dnesIso + ') — jiná data, jak má být');
      } else {
        console.log('OK (datum masáže vyšlo na dnešek, takže se shodují — to je taky správně, viz Test 8)');
      }
    }

    // Test 9: starší rezervace bez záznamu v deníku
    console.log('--- Test 9: rezervace bez záznamu v deníku ---');
    {
      const seznam = await adminFetch('/admin/rezervace').then(res => res.json());
      const bezPlatby = seznam.find(x => Number(x.uhrazeno) === 0 && x.stav_platby === 'nezaplaceno');
      assert.ok(bezPlatby, 'V databázi není žádná nezaplacená rezervace pro kontrolu');
      const historie = await historiePlateb(bezPlatby.id);
      assert.deepEqual(historie, [], 'Rezervace bez platby by měla mít prázdný deník, ne chybu');
      console.log('OK — rezervace bez platby (id ' + bezPlatby.id + ') má prázdný deník, žádná chyba');
    }

    // Test 10: rezervace.uhrazeno vždy odpovídá součtu deníku
    console.log('--- Test 10: uhrazeno == SUM(platby) ---');
    {
      const r = await vytvorRezervaci(polozka.id, '17', 30 + Math.floor(Math.random() * 300));
      uklidRezervace.push(r.id);
      const c1 = Math.max(1, Math.floor(cena * 0.3));
      await platba(r.id, c1, 'hotove');
      const c2 = Math.max(1, Math.floor(cena * 0.3));
      const posledni = await platba(r.id, c2, 'kartou');
      const historie = await historiePlateb(r.id);
      const soucetDeniku = historie.reduce((s, h) => s + Number(h.castka), 0);
      assert.equal(Number(posledni.data.rezervace.uhrazeno), soucetDeniku);
      console.log('OK — rezervace.uhrazeno (' + posledni.data.rezervace.uhrazeno + ' Kč) přesně odpovídá součtu deníku (' + soucetDeniku + ' Kč)');
    }

    // Test 11: souběžné platby nesmí způsobit nekonzistentní stav (lost update)
    console.log('--- Test 11: souběžné platby ---');
    {
      const r = await vytvorRezervaci(polozka.id, '18', 30 + Math.floor(Math.random() * 300));
      uklidRezervace.push(r.id);
      const c1 = Math.max(1, Math.floor(cena * 0.2));
      const c2 = Math.max(1, Math.floor(cena * 0.2));
      const [p1, p2] = await Promise.all([
        platba(r.id, c1, 'hotove'),
        platba(r.id, c2, 'kartou')
      ]);
      assert.equal(p1.status, 200, JSON.stringify(p1.data));
      assert.equal(p2.status, 200, JSON.stringify(p2.data));
      const historie = await historiePlateb(r.id);
      assert.equal(historie.length, 2, 'Obě souběžné platby musí mít vlastní záznam v deníku');
      const soucet = historie.reduce((s, h) => s + Number(h.castka), 0);
      const seznam = await adminFetch('/admin/rezervace').then(res => res.json());
      const aktualni = seznam.find(x => x.id === r.id);
      assert.equal(Number(aktualni.uhrazeno), soucet, 'Souběžné platby vedly k nekonzistentnímu součtu (lost update)');
      assert.equal(Number(aktualni.uhrazeno), c1 + c2);
      console.log('OK — dvě souběžné platby: obě zapsané, součet konzistentní (' + aktualni.uhrazeno + ' Kč = ' + c1 + ' + ' + c2 + ')');
    }

    // Test 12: souběžné uplatnění poukazu nesmí vytvořit duplicitní platbu
    console.log('--- Test 12: souběžné uplatnění poukazu ---');
    {
      const r = await vytvorRezervaci(polozka.id, '19', 30 + Math.floor(Math.random() * 300));
      uklidRezervace.push(r.id);
      const poukazRes = await adminFetch('/admin/poukazy', {
        method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-DENIK-SOUBEZNE (smazat)' })
      }).then(res => res.json());
      uklidPoukazy.push(poukazRes.poukaz.id);
      const hodnotaPoukazu = Number(poukazRes.poukaz.hodnota);

      // Dva souběžné pokusy uplatnit CELOU hodnotu poukazu na tutéž rezervaci —
      // smí uspět jen jeden (poukaz nemá na oba, ani rezervace nemá dvojnásobný dluh).
      const [u1, u2] = await Promise.all([
        adminFetch(`/admin/poukazy/${poukazRes.poukaz.id}/uplatnit`, { method: 'POST', body: JSON.stringify({ castka: hodnotaPoukazu, rezervace_id: r.id }) }),
        adminFetch(`/admin/poukazy/${poukazRes.poukaz.id}/uplatnit`, { method: 'POST', body: JSON.stringify({ castka: hodnotaPoukazu, rezervace_id: r.id }) })
      ]);
      const uspesnych = [u1.status, u2.status].filter(s => s === 200).length;
      assert.equal(uspesnych, 1, `Souběžné uplatnění poukazu prošlo ${uspesnych}× místo 1× — duplicitní platba!`);
      const historie = await historiePlateb(r.id);
      assert.equal(historie.length, 1, 'V deníku nesmí být duplicitní záznam ze souběžného uplatnění');
      console.log('OK — souběžné uplatnění téhož poukazu na stejnou rezervaci prošlo jen jednou, v deníku je jen 1 záznam');
    }

    console.log('\n✅ VŠECH 12 TESTŮ DENÍKU PLATEB PROŠLO');
  } finally {
    for (const id of uklidRezervace) await adminFetch(`/admin/rezervace/${id}`, { method: 'DELETE' });
    for (const id of uklidPoukazy) await adminFetch(`/admin/poukazy/${id}`, { method: 'DELETE' });
    if (uklidRezervace.length || uklidPoukazy.length) {
      console.log(`(uklizeno: ${uklidRezervace.length} testovacích rezervací, ${uklidPoukazy.length} testovacích poukazů)`);
    }
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
