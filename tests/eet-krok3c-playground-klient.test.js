// Krok 3c — testovací klient pro EET Playground, DVA VÝSLOVNĚ ODDĚLENÉ
// REŽIMY (ÚKOL B, bod 1-4, 7): REZIM.LOCAL_MOCK a REZIM.OFFICIAL_PLAYGROUND.
//
// POZOR: tento test NENAVAZUJE žádné spojení s Playgroundem ani s Finanční
// správou — všechny scénáře běží v REZIM.LOCAL_MOCK proti lokálnímu mock
// serveru (tests/helpers/mock-eet-server.js) na 127.0.0.1, který sám o sobě
// kontroluje XSD a podpis (reálnými moduly eet/xsd-validace.js, eet/podpis.js),
// takže test má reálnou vypovídací hodnotu, i když nejde o skutečnou síť.
// REZIM.OFFICIAL_PLAYGROUND se v tomhle testu NIKDY nezavolá — jen se
// ověřují jeho ochrany (bod 7), ne samotné odeslání.
//
// Spuštění:  node tests/eet-krok3c-playground-klient.test.js
const assert = require('node:assert/strict');
const { sestavitXmlTrzby } = require('../eet/xml-zprava');
const { sestavitNepodepsanouObalku } = require('../eet/soap-obalka');
const { podepsatObalku, vytvoritTestovaciKlic } = require('../eet/podpis');
const { dalsiPokusOdeslani } = require('../eet/odesilaci-identita');
const { rozebratOdpoved } = require('../eet/odpoved-parser');
const { REZIM, odeslatZpravu, EetZakazanaAdresa, EetTimeout, ADRESA_PLAYGROUND, ADRESA_PRODUKCE } = require('../eet/playground-klient');
const { PODKLADY, TESTOVACI_EIC } = require('../eet/specifikace');
const { spustitMockEetServer } = require('./helpers/mock-eet-server');

const CFG = { eicPopl: TESTOVACI_EIC.pravnickaOsoba };

function trzba(porad_cis, dalsi = {}) {
  return { id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis, dat_trzby: new Date(), celk_trzba: '350.00', ...dalsi };
}

async function sestavitPodepsanouZpravu(t, klic, pokus = { prvniZaslani: true }) {
  const { xml } = sestavitXmlTrzby(t, CFG, pokus);
  const nepodepsana = sestavitNepodepsanouObalku(xml, { certificatePem: klic.certificatePem });
  return podepsatObalku(nepodepsana, { privateKeyPem: klic.privateKeyPem, certificatePem: klic.certificatePem });
}

function odeslatNaMock(zprava, mock, opts = {}) {
  return odeslatZpravu(zprava, { rezim: REZIM.LOCAL_MOCK, mockUrl: mock.url, ...opts });
}

async function main() {
  console.log('--- Krok 3c: testovací klient pro Playground (dva výslovné režimy) ---');

  // 0) Adresy v kódu se musí shodovat s oficiálním manifestem a NESMÍ se
  //    nikdy shodovat mezi sebou.
  assert.equal(ADRESA_PLAYGROUND, PODKLADY.playground.url);
  assert.equal(ADRESA_PLAYGROUND, 'https://pg.trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4');
  assert.equal(ADRESA_PRODUKCE, 'https://trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4');
  assert.notEqual(ADRESA_PLAYGROUND, ADRESA_PRODUKCE);
  console.log('OK — 0) adresy Playgroundu i produkce odpovídají oficiálnímu manifestu a liší se od sebe');

  // 1) Chybějící/neplatný "rezim" je vždy odmítnut — žádná výchozí hodnota,
  //    co by mohla omylem něco odeslat.
  {
    await assert.rejects(() => odeslatZpravu('<x/>', {}), /rezim/i);
    await assert.rejects(() => odeslatZpravu('<x/>', { rezim: 'NECO_JINEHO' }), /rezim/i);
    console.log('OK — 1) chybějící nebo neplatný "rezim" je vždy odmítnut (žádné tiché chování)');
  }

  // 2) REZIM.LOCAL_MOCK: pevná ochrana — odmítne cokoli mimo localhost,
  //    včetně přesné adresy Playgroundu i produkce.
  {
    await assert.rejects(() => odeslatZpravu('<x/>', { rezim: REZIM.LOCAL_MOCK, mockUrl: ADRESA_PLAYGROUND }), EetZakazanaAdresa);
    await assert.rejects(() => odeslatZpravu('<x/>', { rezim: REZIM.LOCAL_MOCK, mockUrl: ADRESA_PRODUKCE }), EetZakazanaAdresa);
    await assert.rejects(() => odeslatZpravu('<x/>', { rezim: REZIM.LOCAL_MOCK, mockUrl: 'https://evil.example.com/' }), EetZakazanaAdresa);
    await assert.rejects(() => odeslatZpravu('<x/>', { rezim: REZIM.LOCAL_MOCK, mockUrl: 'http://10.0.0.5:8080/' }), EetZakazanaAdresa);
    await assert.rejects(() => odeslatZpravu('<x/>', { rezim: REZIM.LOCAL_MOCK }), /mockUrl/);
    console.log('OK — 2) REZIM.LOCAL_MOCK odmítne jakoukoli neloopback adresu (Playground, produkci, cokoli jiného)');
  }

  // 3) REZIM.OFFICIAL_PLAYGROUND: adresa NENÍ parametr — žádný způsob, jak ji
  //    zvenčí přepsat. Ověřujeme, že funkce nebere a nepoužije žádnou
  //    "url"/"mockUrl" hodnotu, kdyby ji volající (omylem) poslal.
  {
    // Projekce: i kdyby volající poslal mockUrl mířící jinam, v režimu
    // OFFICIAL_PLAYGROUND se prostě ignoruje — adresa je vždy ADRESA_PLAYGROUND.
    // Tohle NEVOLÁME doopravdy (bod 7 zadání — žádné skutečné odeslání), jen
    // ověřujeme staticky zdrojový kód modulu, že _odeslatOficialniPlayground
    // nikdy nečte žádný parametr typu "url"/"adresa"/"mockUrl".
    const fs = require('node:fs');
    const zdrojovyKod = fs.readFileSync(require.resolve('../eet/playground-klient'), 'utf8');
    const telo = zdrojovyKod.match(/async function _odeslatOficialniPlayground\(([^)]*)\)/)[1];
    assert.ok(!/url|adresa|mockUrl/i.test(telo), `_odeslatOficialniPlayground nesmí mít parametr pro cílovou adresu, má: "${telo}"`);
    console.log('OK — 3) REZIM.OFFICIAL_PLAYGROUND nemá žádný parametr pro cílovou adresu (statická kontrola signatury funkce)');
  }

  // 4) Produkční endpoint je zakázaný explicitně, jmenovitě, ne jen "protože
  //    není v allowlistu" — i přesná produkční URL je vždy odmítnuta.
  {
    await assert.rejects(() => odeslatZpravu('<x/>', { rezim: REZIM.LOCAL_MOCK, mockUrl: ADRESA_PRODUKCE }), EetZakazanaAdresa);
    console.log('OK — 4) produkční endpoint Finanční správy je výslovně a jmenovitě zakázaný');
  }

  const mock = await spustitMockEetServer();
  console.log(`(mock EET server běží na ${mock.url} — jen 127.0.0.1, ne Playground)`);

  try {
    const klic = vytvoritTestovaciKlic();

    // 5) Běžná platba.
    {
      const zprava = await sestavitPodepsanouZpravu(trzba('ET-PG-001'), klic);
      const { telo } = await odeslatNaMock(zprava, mock);
      const odpoved = rozebratOdpoved(telo);
      assert.equal(odpoved.typ, 'potvrzeni');
      assert.equal(odpoved.test, true);
      console.log('OK — 5) běžná platba → potvrzení (mock, test=true)');
    }

    // 6) Hodnotový poukaz (vydání).
    {
      const zprava = await sestavitPodepsanouZpravu(trzba('ET-PG-002', { urceno_cerp_zuct: '350.00' }), klic);
      const { telo } = await odeslatNaMock(zprava, mock);
      assert.equal(rozebratOdpoved(telo).typ, 'potvrzeni');
      console.log('OK — 6) hodnotový poukaz (vydání) → potvrzení');
    }

    // 7) Poukaz na konkrétní masáž (jen prodej se eviduje, žádné cerp_zuct pole).
    {
      const zprava = await sestavitPodepsanouZpravu(trzba('ET-PG-003'), klic);
      const { telo } = await odeslatNaMock(zprava, mock);
      assert.equal(rozebratOdpoved(telo).typ, 'potvrzeni');
      console.log('OK — 7) poukaz na konkrétní masáž (prodej) → potvrzení');
    }

    // 8) Kombinovaná platba (sloučená částka).
    {
      const zprava = await sestavitPodepsanouZpravu(trzba('ET-PG-004', { celk_trzba: '890.00', cerp_zuct: '500.00' }), klic);
      const { telo } = await odeslatNaMock(zprava, mock);
      assert.equal(rozebratOdpoved(telo).typ, 'potvrzeni');
      console.log('OK — 8) kombinovaná platba (poukaz + hotovost v jedné zprávě) → potvrzení');
    }

    // 9) Storno (záporná částka).
    {
      const zprava = await sestavitPodepsanouZpravu(trzba('ET-PG-005', { celk_trzba: '-350.00' }), klic);
      const { telo } = await odeslatNaMock(zprava, mock);
      assert.equal(rozebratOdpoved(telo).typ, 'potvrzeni');
      console.log('OK — 9) storno (záporná částka) → potvrzení');
    }

    // 10) Chybný podpis — mock MUSÍ vrátit chybu kódu 4 (Neplatny podpis SOAP zpravy).
    {
      const zprava = await sestavitPodepsanouZpravu(trzba('ET-PG-006'), klic);
      const porusena = zprava.replace(/<SignatureValue>([A-Za-z0-9+/=]{10})/, (m, p1) => `<SignatureValue>${p1[0] === 'A' ? 'B' : 'A'}${p1.slice(1)}`);
      const { telo } = await odeslatNaMock(porusena, mock);
      const odpoved = rozebratOdpoved(telo);
      assert.equal(odpoved.typ, 'chyba');
      assert.equal(odpoved.kod, 4);
      console.log('OK — 10) chybný podpis → chyba kód 4 (ověřeno mockem, který reálně ověřuje podpis)');
    }

    // 11) Neplatná XML zpráva — odstraníme povinný atribut celk_trzba ze
    //     syrového XML (mimo náš generátor, přímou manipulací stringu) tak,
    //     aby prošla přes podpis (podepisuje se, co je v obálce), ale
    //     neprošla XSD validací na straně příjemce → kód 3.
    {
      const zpravaValidni = await sestavitPodepsanouZpravu(trzba('ET-PG-007'), klic);
      const poskozena = zpravaValidni.replace(/ celk_trzba="[^"]*"/, '');
      const { telo } = await odeslatNaMock(poskozena, mock);
      const odpoved = rozebratOdpoved(telo);
      assert.equal(odpoved.typ, 'chyba');
      assert.equal(odpoved.kod, 3);
      console.log('OK — 11) neplatná XML zpráva (chybějící povinný atribut) → chyba kód 3');
    }

    // 12) Timeout a opakované odeslání.
    {
      const t = trzba('ET-PG-008-MOCK-TIMEOUT');
      const pokus1 = await sestavitPodepsanouZpravu(t, klic, dalsiPokusOdeslani(t, 0));
      await assert.rejects(
        () => odeslatNaMock(pokus1, mock, { timeoutMs: 300 }),
        EetTimeout,
        'mock server pro MOCK-TIMEOUT nikdy neodpoví — klient musí timeoutnout'
      );

      const tOpakovani = trzba('ET-PG-008');
      const pokus2 = await sestavitPodepsanouZpravu(tOpakovani, klic, dalsiPokusOdeslani(tOpakovani, 1));
      assert.notEqual(pokus1, pokus2);
      const { telo } = await odeslatNaMock(pokus2, mock);
      const odpoved = rozebratOdpoved(telo);
      assert.equal(odpoved.typ, 'potvrzeni');
      console.log('OK — 12) timeout (žádná odpověď) → EetTimeout; opakování s novým uuid_zpravy → potvrzení');
    }
  } finally {
    await mock.zastavit();
    console.log('(mock EET server zastaven)');
  }

  console.log('\n✅ VŠECHNY TESTY TESTOVACÍHO KLIENTA PROŠLY');
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
