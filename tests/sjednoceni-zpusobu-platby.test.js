// Regresní test: Krok 1 přípravy na EET 2.0 — sjednocení a validace způsobů
// plateb napříč rezervacemi, poukazy a prodejnou/produkty.
//
// Cíl testu:
//  1) Neplatná/chybějící hodnota zpusob_platby je odmítnuta (400) na VŠECH
//     peněžních endpointech — žádný tichý fallback na "hotove".
//  2) Všechny historicky platné hodnoty na každém endpointu dál procházejí
//     beze změny chování (kompatibilita) — a žádná dřív NEpovolená hodnota
//     (např. "kartou" v prodejně) se sjednocením nestala nově povolenou.
//  3) Prodejna s poukazem, který plně kryje cenu, funguje i BEZ zadaného
//     zpusob_platby (zbytek=0 — metoda není potřeba, stejně jako dřív).
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=http://localhost:3001/api DATABASE_URL=... node tests/sjednoceni-zpusobu-platby.test.js

const assert = require('node:assert/strict');

const { ziskatTestApiBase, ziskatTestDatabaseUrl } = require('./env-guard');
const { uklidRezervaciSFallbackem } = require('./test-helpers');
const API = ziskatTestApiBase();
const DB_URL = ziskatTestDatabaseUrl(); // nepoužito přímo, jen ověří fail-closed prostředí
const HESLO = process.env.ADMIN_HESLO;

if (!HESLO) {
  console.error('Chybí ADMIN_HESLO v prostředí.');
  process.exit(1);
}

function adminFetch(cesta, opts = {}) {
  return fetch(API + cesta, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-admin-heslo': HESLO, ...(opts.headers || {}) }
  });
}

const uklidRezervace = [];
const uklidKlientky = new Set();
const uklidPoukazyTypy = [];
// "prodeje"/"prodeje_produktu"/"poukazy" vzniklé v tomhle testu se NEmažou
// přes HTTP API (DELETE /admin/prodejna/:id by poukazu vracel zůstatek —
// nechceme ho oživovat, chceme ho se vším, co z něj vzniklo, úplně
// odstranit) — čistě testovací přímý SQL úklid v TEST DB, stejný princip
// jako smazatRezervaciNatvrdo v test-helpers.js.
const uklidProdejny = [];
const uklidProdejeProduktu = [];
const uklidPoukazy = [];
const uklidProdukty = []; // jen test-VYTVOŘENÉ produkty — mažou se AŽ PO úklidu prodeje_produktu (jinak by DELETE selhal na historii prodeje)

// Poukaz s nevyčerpaným zůstatkem a stav_uhrady='zaplaceno' nelze zrušit
// přes běžné API (chrání to existující ochrana proti ztrátě evidence — viz
// ochrana-mazani-rezervaci.test.js). Testovací poukazy níž proto vždy
// necháváme vyčerpat ÚPLNĚ přes prodejnu (cena prodeje = přesně hodnota
// poukazu) a po testu se smažou přímo SQL (viz výš) — ne přes stav='zruseny'.
async function vycerpatPoukazCele(poukazKod, cena) {
  const res = await adminFetch('/admin/prodejna', {
    method: 'POST', body: JSON.stringify({ masaz: 'TEST-SJEDNOCENI-UKLID-POUKAZU', cena, poukaz_kod: poukazKod })
  });
  const data = await res.json().catch(() => ({}));
  assert.equal(res.status, 200, 'úklidové vyčerpání testovacího poukazu musí uspět: ' + JSON.stringify(data));
  if (data.prodej && data.prodej.id) uklidProdejny.push(data.prodej.id);
}

async function najitVolnyTermin(datum, cenikId) {
  const terminy = await fetch(`${API}/rezervace/volne-terminy?datum=${datum}&cenik_id=${cenikId}`).then(r => r.json());
  const volny = Array.isArray(terminy) ? terminy.find(t => t.volno) : null;
  return volny ? volny.cas : null;
}
async function novyVolnyTermin(cenikId, odpocetDni) {
  for (let i = odpocetDni; i < odpocetDni + 60; i += 3) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const cas = await najitVolnyTermin(iso, cenikId);
    if (cas) return { datum: iso, cas };
  }
  throw new Error('Nenalezen volný termín pro test');
}

let telefonCitac = 0;
async function vytvorRezervaci(cenikId, sufix) {
  telefonCitac++;
  const { datum, cas } = await novyVolnyTermin(cenikId, 1400 + telefonCitac * 3);
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: cas, jmeno: 'TEST-SJEDNOCENI-PLATBY ' + sufix + ' (smazat)', telefon: '00007' + telefonCitac, email: 'test-sjednoceni-platby@example.cz' })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'vytvoření testovací rezervace musí uspět: ' + JSON.stringify(data));
  uklidRezervace.push(data.rezervace.id);
  if (data.rezervace.klientka_id) uklidKlientky.add(data.rezervace.klientka_id);
  return data.rezervace;
}

async function main() {
  console.log('--- Krok 1 EET: sjednocení a validace způsobů plateb ---');

  const cenikRes = await adminFetch('/admin/cenik').then(r => r.json());
  const polozka = cenikRes.find(p => Number(p.cena) > 0 && p.rezervovatelna !== false);
  assert.ok(polozka, 'ceník musí mít aspoň jednu rezervovatelnou položku s cenou > 0');

  // 1) Rezervace — platba: neplatná a chybějící hodnota odmítnuta, historické hodnoty fungují
  {
    const r = await vytvorRezervaci(polozka.id, '1');
    const resNeplatna = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: 1, zpusob_platby: 'bitcoin' })
    });
    assert.equal(resNeplatna.status, 400, '1a) neplatná metoda platby u rezervace musí být odmítnuta');

    const resChybejici = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
      method: 'PATCH', body: JSON.stringify({ castka: 1 })
    });
    assert.equal(resChybejici.status, 400, '1b) chybějící metoda platby u rezervace musí být odmítnuta (žádný tichý fallback na hotove)');

    for (const metoda of ['hotove', 'kartou', 'online']) {
      const r2 = await vytvorRezervaci(polozka.id, '1-' + metoda);
      const resOk = await adminFetch(`/admin/rezervace/${r2.id}/platba`, {
        method: 'PATCH', body: JSON.stringify({ castka: 1, zpusob_platby: metoda, kontaktni_platba: true })
      });
      assert.equal(resOk.status, 200, `1c) historická metoda '${metoda}' musí dál procházet: ` + JSON.stringify(await resOk.json().catch(() => ({}))));
    }
    console.log('OK — 1) rezervace/platba: neplatná a chybějící metoda odmítnuta, historické metody (hotove/kartou/online) fungují');
  }

  // 2) Poukaz — vydání se zaplaceno=true: neplatná/chybějící hodnota odmítnuta, qr dál funguje
  {
    const resNeplatny = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-SJEDNOCENI (smazat)', zaplaceno: true, zpusob_platby: 'bitcoin' })
    });
    assert.equal(resNeplatny.status, 400, '2a) neplatná metoda platby u vydání poukazu musí být odmítnuta');

    const resChybejici = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-SJEDNOCENI (smazat)', zaplaceno: true })
    });
    assert.equal(resChybejici.status, 400, '2b) chybějící metoda platby u vydání poukazu musí být odmítnuta');

    const resQr = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-SJEDNOCENI-QR (smazat)', zaplaceno: true, zpusob_platby: 'qr', kontaktni_platba: true })
    });
    const poukazQr = await resQr.json();
    assert.equal(resQr.status, 200, '2c) historická metoda qr u vydání poukazu musí dál fungovat: ' + JSON.stringify(poukazQr));
    uklidPoukazy.push(poukazQr.poukaz.id);
    await vycerpatPoukazCele(poukazQr.poukaz.kod, Number(polozka.cena));
    console.log('OK — 2) poukazy (vydání): neplatná a chybějící metoda odmítnuta, historická metoda qr funguje');
  }

  // 3) Poukaz — potvrdit-platbu: neplatná hodnota odmítnuta, historická metoda funguje
  {
    const nezaplaceny = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-SJEDNOCENI-NEZAPLACENO (smazat)', zaplaceno: false })
    }).then(r => r.json());
    uklidPoukazy.push(nezaplaceny.poukaz.id);

    const resNeplatny = await adminFetch(`/admin/poukazy/${nezaplaceny.poukaz.id}/potvrdit-platbu`, {
      method: 'PATCH', body: JSON.stringify({ zpusob_platby: 'bitcoin' })
    });
    assert.equal(resNeplatny.status, 400, '3a) neplatná metoda u potvrzení platby poukazu musí být odmítnuta');

    const resChybejici = await adminFetch(`/admin/poukazy/${nezaplaceny.poukaz.id}/potvrdit-platbu`, {
      method: 'PATCH', body: JSON.stringify({})
    });
    assert.equal(resChybejici.status, 400, '3b) chybějící metoda u potvrzení platby poukazu musí být odmítnuta');

    const resOk = await adminFetch(`/admin/poukazy/${nezaplaceny.poukaz.id}/potvrdit-platbu`, {
      method: 'PATCH', body: JSON.stringify({ zpusob_platby: 'kartou', kontaktni_platba: true })
    });
    assert.equal(resOk.status, 200, '3c) historická metoda kartou musí dál procházet');
    await vycerpatPoukazCele(nezaplaceny.poukaz.kod, Number(polozka.cena));
    console.log('OK — 3) poukazy/potvrdit-platbu: neplatná a chybějící metoda odmítnuta, historická metoda funguje');
  }

  // 4) Prodejna — BEZ poukazu: dřív se nevalidovalo vůbec, teď musí odmítnout neplatnou/chybějící hodnotu;
  //    "kartou" zůstává historicky NEpovolené (sjednocení nesmí rozšířit chování).
  {
    const resNeplatna = await adminFetch('/admin/prodejna', {
      method: 'POST', body: JSON.stringify({ masaz: 'TEST-SJEDNOCENI-PRODEJNA', cena: 100, zpusob_platby: 'bitcoin' })
    });
    assert.equal(resNeplatna.status, 400, '4a) prodejna bez poukazu s neplatnou metodou musí být odmítnuta (dřív se nevalidovalo vůbec)');

    const resChybejici = await adminFetch('/admin/prodejna', {
      method: 'POST', body: JSON.stringify({ masaz: 'TEST-SJEDNOCENI-PRODEJNA', cena: 100 })
    });
    const dataChybejici = await resChybejici.json();
    assert.equal(resChybejici.status, 400, '4b) prodejna bez poukazu a BEZ zpusob_platby musí být odmítnuta (dřív tichý fallback na hotove): ' + JSON.stringify(dataChybejici));

    const resKartou = await adminFetch('/admin/prodejna', {
      method: 'POST', body: JSON.stringify({ masaz: 'TEST-SJEDNOCENI-PRODEJNA', cena: 100, zpusob_platby: 'kartou' })
    });
    assert.equal(resKartou.status, 400, '4c) prodejna s metodou kartou musí být odmítnuta — historicky nikdy nebyla povolená');

    const resOk = await adminFetch('/admin/prodejna', {
      method: 'POST', body: JSON.stringify({ masaz: 'TEST-SJEDNOCENI-PRODEJNA', cena: 100, zpusob_platby: 'hotove' })
    });
    const prodejOk = await resOk.json();
    assert.equal(resOk.status, 200, '4d) prodejna s platnou metodou hotove musí uspět');
    assert.equal(prodejOk.prodej.zpusob_platby, 'hotove', '4d) uložená metoda musí být přesně ta zadaná, ne nějaký fallback');
    uklidProdejny.push(prodejOk.prodej.id);
    console.log('OK — 4) prodejna (bez poukazu): neplatná/chybějící metoda odmítnuta, hotove funguje, kartou zůstává historicky nepovolené');
  }

  // 5) Prodejna — S poukazem, který plně kryje cenu: zpusob_platby není potřeba (zbytek=0)
  //    Hodnota poukazu = přesně cena prodeje, ať se poukaz vyčerpá celý
  //    (stav 'pouzity', zustatek=0) a nemusí se po testu řešit zrušení
  //    nevyčerpaného poukazu (to by navíc existující ochrana blokovala).
  {
    const platnostNahodna = 20 + Math.floor(Math.random() * 180);
    const typRes = await adminFetch('/admin/poukazy/typy', { method: 'POST', body: JSON.stringify({ hodnota: 500, platnost_mesicu: platnostNahodna }) });
    const typ = await typRes.json();
    assert.equal(typRes.status, 200, JSON.stringify(typ));
    uklidPoukazyTypy.push(typ.typ.id);

    const poukaz = await adminFetch('/admin/poukazy', {
      method: 'POST', body: JSON.stringify({ poukaz_typ_id: typ.typ.id, zaplaceno: true, zpusob_platby: 'hotove', kontaktni_platba: true })
    }).then(r => r.json());
    uklidPoukazy.push(poukaz.poukaz.id);

    const resBezMetody = await adminFetch('/admin/prodejna', {
      method: 'POST', body: JSON.stringify({ masaz: 'TEST-SJEDNOCENI-PRODEJNA-POUKAZ', cena: 500, poukaz_kod: poukaz.poukaz.kod })
    });
    const dataBezMetody = await resBezMetody.json();
    assert.equal(resBezMetody.status, 200, '5) prodejna s poukazem, který plně kryje cenu, musí uspět i BEZ zpusob_platby: ' + JSON.stringify(dataBezMetody));
    assert.equal(dataBezMetody.prodej.zpusob_platby, 'poukaz', '5) uložená metoda musí být "poukaz", ne žádný fallback');
    uklidProdejny.push(dataBezMetody.prodej.id);
    console.log('OK — 5) prodejna s poukazem plně kryjícím cenu funguje i bez zadané zpusob_platby (beze změny, jako dřív)');
  }

  // 6) Produkty — prodat: dřív se nevalidovalo vůbec, teď musí odmítnout neplatnou/chybějící hodnotu
  {
    const produktyRes = await adminFetch('/admin/produkty').then(r => r.json());
    // vyloučit vlastní testovací produkt z případného předchozího (např.
    // přerušeného) běhu — jinak by se našel "existující" a test by na něj
    // omylem naskladnil/needeleoval místo vytvoření nového
    let produkt = Array.isArray(produktyRes) ? produktyRes.find(p => Number(p.sklad) >= 2 && p.skupina !== 'TEST-SJEDNOCENI-PLATBY') : null;
    let produktTestovaci = false;
    if (!produkt) {
      const vytvoreny = await adminFetch('/admin/produkty', {
        method: 'POST', body: JSON.stringify({ skupina: 'TEST-SJEDNOCENI-PLATBY', varianta: 'produkt', cena: 100, sklad: 5 })
      }).then(r => r.json());
      produkt = vytvoreny.produkt || vytvoreny;
      produktTestovaci = true;
      uklidProdukty.push(produkt.id);
    }
    {
      const resNeplatna = await adminFetch(`/admin/produkty/${produkt.id}/prodat`, {
        method: 'POST', body: JSON.stringify({ mnozstvi: 1, zpusob_platby: 'bitcoin' })
      });
      assert.equal(resNeplatna.status, 400, '6a) prodej produktu s neplatnou metodou musí být odmítnut (dřív se nevalidovalo vůbec)');

      const resChybejici = await adminFetch(`/admin/produkty/${produkt.id}/prodat`, {
        method: 'POST', body: JSON.stringify({ mnozstvi: 1 })
      });
      assert.equal(resChybejici.status, 400, '6b) prodej produktu BEZ zpusob_platby musí být odmítnut (dřív tichý fallback na hotove)');

      const skladPo = (await adminFetch('/admin/produkty').then(r => r.json())).find(p => p.id === produkt.id).sklad;
      assert.equal(Number(skladPo), Number(produkt.sklad), '6c) odmítnuté pokusy nesmí snížit sklad');

      const resOk = await adminFetch(`/admin/produkty/${produkt.id}/prodat`, {
        method: 'POST', body: JSON.stringify({ mnozstvi: 1, zpusob_platby: 'kartou' })
      });
      const dataOk = await resOk.json();
      assert.equal(resOk.status, 200, '6d) prodej produktu s platnou historickou metodou kartou musí uspět');
      assert.equal(dataOk.prodej.zpusob_platby, 'kartou', '6d) uložená metoda musí být přesně ta zadaná');
      uklidProdejeProduktu.push(dataOk.prodej.id);
      if (!produktTestovaci) {
        // vrátit sklad zpět, ať test neovlivní stav skladu existujícího (ne testovacího) produktu v TEST DB
        await adminFetch(`/admin/produkty/${produkt.id}/naskladnit`, { method: 'POST', body: JSON.stringify({ mnozstvi: 1, nakupni_cena_celkem: 0, dodavatel: 'TEST-UKLID' }) });
      }
      // testovací produkt (uklidProdukty) se smaže v finally AŽ PO přímém SQL
      // úklidu "prodeje_produktu" výš — DELETE by jinak selhal na historii prodeje
      console.log('OK — 6) produkty/prodat: neplatná/chybějící metoda odmítnuta (sklad nedotčen), historická metoda kartou funguje (úklid proveden)');
    }
  }

  console.log('\n✅ VŠECHNY TESTY KROKU 1 (EET — sjednocení způsobů plateb) PROŠLY');
}

async function uklidPrimymSql() {
  if (!uklidProdejny.length && !uklidProdejeProduktu.length && !uklidPoukazy.length) return;
  const { Client } = require('pg');
  const c = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    // "prodeje"/"prodeje_produktu" NEJDŘÍV (žádná jiná tabulka na ně neodkazuje
    // s ON DELETE RESTRICT), "poukazy" až poté — prodeje.poukaz_id má ON DELETE
    // SET NULL, pořadí by tu nevadilo, ale takhle je to čitelnější.
    if (uklidProdejny.length) await c.query('DELETE FROM prodeje WHERE id = ANY($1)', [uklidProdejny]);
    if (uklidProdejeProduktu.length) await c.query('DELETE FROM prodeje_produktu WHERE id = ANY($1)', [uklidProdejeProduktu]);
    if (uklidPoukazy.length) await c.query('DELETE FROM poukazy WHERE id = ANY($1)', [uklidPoukazy]);
  } finally {
    await c.end();
  }
}

main()
  .catch(e => { console.error('❌ CHYBA TESTU:', e.message); process.exitCode = 1; })
  .finally(async () => {
    for (const id of uklidRezervace) {
      await uklidRezervaciSFallbackem(adminFetch, id).catch(e => console.error('Úklid rezervace selhal:', id, e.message));
    }
    for (const id of uklidKlientky) {
      await adminFetch(`/admin/klientky/${id}`, { method: 'DELETE' }).catch(() => null);
    }
    for (const id of uklidPoukazyTypy) {
      await adminFetch(`/admin/poukazy/typy/${id}`, { method: 'DELETE' }).catch(() => null);
    }
    await uklidPrimymSql().catch(e => console.error('Přímý SQL úklid prodejů/poukazů selhal:', e.message));
    for (const id of uklidProdukty) {
      await adminFetch(`/admin/produkty/${id}`, { method: 'DELETE' }).catch(() => null);
    }
  });
