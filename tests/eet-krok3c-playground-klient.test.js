// Krok 3c — příprava testovacího klienta pro EET Playground (bod 2, 6, 9).
//
// POZOR: tento test NENAVAZUJE žádné spojení s Playgroundem ani s Finanční
// správou. Všechny scénáře běží proti lokálnímu mock serveru
// (tests/helpers/mock-eet-server.js) na 127.0.0.1, který sám o sobě
// kontroluje XSD a podpis (reálnými moduly eet/xsd-validace.js, eet/podpis.js),
// takže test má reálnou vypovídací hodnotu, i když nejde o skutečnou síť.
//
// Spuštění:  node tests/eet-krok3c-playground-klient.test.js
const assert = require('node:assert/strict');
const { sestavitXmlTrzby } = require('../eet/xml-zprava');
const { sestavitNepodepsanouObalku } = require('../eet/soap-obalka');
const { podepsatObalku, vytvoritTestovaciKlic } = require('../eet/podpis');
const { dalsiPokusOdeslani } = require('../eet/odesilaci-identita');
const { rozebratOdpoved } = require('../eet/odpoved-parser');
const { _odeslatNaLokalniMockServer, EetZakazanaAdresa, EetTimeout, ADRESA_PLAYGROUND } = require('../eet/playground-klient');
const { PODKLADY } = require('../eet/specifikace');
const { spustitMockEetServer } = require('./helpers/mock-eet-server');
const { TESTOVACI_EIC } = require('../eet/specifikace');

const CFG = { eicPopl: TESTOVACI_EIC.pravnickaOsoba };

function trzba(porad_cis, dalsi = {}) {
  return { id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis, dat_trzby: new Date(), celk_trzba: '350.00', ...dalsi };
}

async function sestavitPodepsanouZpravu(t, klic, pokus = { prvniZaslani: true }) {
  const { xml } = sestavitXmlTrzby(t, CFG, pokus);
  const nepodepsana = sestavitNepodepsanouObalku(xml, { certificatePem: klic.certificatePem });
  return podepsatObalku(nepodepsana, { privateKeyPem: klic.privateKeyPem, certificatePem: klic.certificatePem });
}

async function main() {
  console.log('--- Krok 3c: testovací klient pro Playground (jen proti lokálnímu mock serveru) ---');

  // 0) Adresa Playgroundu v kódu se musí shodovat se zaznamenanou oficiální
  //    adresou (eet/specifikace.js, ověřeno v Kroku 3c proti
  //    EET_pristupove_provozni_informace_playground_1_2.pdf).
  assert.equal(ADRESA_PLAYGROUND, PODKLADY.playground.url);
  assert.equal(ADRESA_PLAYGROUND, 'https://pg.trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4');
  console.log('OK — 0) adresa Playgroundu v kódu odpovídá oficiálnímu manifestu');

  // 1) PEVNÁ OCHRANA: testovací odesílací funkce odmítne cokoli mimo
  //    localhost — včetně adresy, která vypadá jako Finanční správa.
  {
    await assert.rejects(() => _odeslatNaLokalniMockServer('<x/>', 'https://pg.trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4'), EetZakazanaAdresa);
    await assert.rejects(() => _odeslatNaLokalniMockServer('<x/>', 'https://evil.example.com/'), EetZakazanaAdresa);
    await assert.rejects(() => _odeslatNaLokalniMockServer('<x/>', 'http://10.0.0.5:8080/'), EetZakazanaAdresa);
    console.log('OK — 1) odeslání na jakoukoli neloopback adresu (včetně domény FS) je zakázáno');
  }

  const mock = await spustitMockEetServer();
  console.log(`(mock EET server běží na ${mock.url} — jen 127.0.0.1, ne Playground)`);

  try {
    const klic = vytvoritTestovaciKlic();

    // 2) Běžná platba.
    {
      const zprava = await sestavitPodepsanouZpravu(trzba('ET-PG-001'), klic);
      const { telo } = await _odeslatNaLokalniMockServer(zprava, mock.url);
      const odpoved = rozebratOdpoved(telo);
      assert.equal(odpoved.typ, 'potvrzeni');
      assert.equal(odpoved.test, true);
      console.log('OK — 2) běžná platba → potvrzení (mock, test=true)');
    }

    // 3) Hodnotový poukaz (vydání).
    {
      const zprava = await sestavitPodepsanouZpravu(trzba('ET-PG-002', { urceno_cerp_zuct: '350.00' }), klic);
      const { telo } = await _odeslatNaLokalniMockServer(zprava, mock.url);
      assert.equal(rozebratOdpoved(telo).typ, 'potvrzeni');
      console.log('OK — 3) hodnotový poukaz (vydání) → potvrzení');
    }

    // 4) Poukaz na konkrétní masáž (jen prodej se eviduje, žádné cerp_zuct pole).
    {
      const zprava = await sestavitPodepsanouZpravu(trzba('ET-PG-003'), klic);
      const { telo } = await _odeslatNaLokalniMockServer(zprava, mock.url);
      assert.equal(rozebratOdpoved(telo).typ, 'potvrzeni');
      console.log('OK — 4) poukaz na konkrétní masáž (prodej) → potvrzení');
    }

    // 5) Kombinovaná platba (sloučená částka).
    {
      const zprava = await sestavitPodepsanouZpravu(trzba('ET-PG-004', { celk_trzba: '890.00', cerp_zuct: '500.00' }), klic);
      const { telo } = await _odeslatNaLokalniMockServer(zprava, mock.url);
      assert.equal(rozebratOdpoved(telo).typ, 'potvrzeni');
      console.log('OK — 5) kombinovaná platba (poukaz + hotovost v jedné zprávě) → potvrzení');
    }

    // 6) Storno (záporná částka).
    {
      const zprava = await sestavitPodepsanouZpravu(trzba('ET-PG-005', { celk_trzba: '-350.00' }), klic);
      const { telo } = await _odeslatNaLokalniMockServer(zprava, mock.url);
      assert.equal(rozebratOdpoved(telo).typ, 'potvrzeni');
      console.log('OK — 6) storno (záporná částka) → potvrzení');
    }

    // 7) Chybný podpis — mock MUSÍ vrátit chybu kódu 4 (Neplatny podpis SOAP zpravy).
    {
      const zprava = await sestavitPodepsanouZpravu(trzba('ET-PG-006'), klic);
      const porusena = zprava.replace(/<SignatureValue>([A-Za-z0-9+/=]{10})/, (m, p1) => `<SignatureValue>${p1[0] === 'A' ? 'B' : 'A'}${p1.slice(1)}`);
      const { telo } = await _odeslatNaLokalniMockServer(porusena, mock.url);
      const odpoved = rozebratOdpoved(telo);
      assert.equal(odpoved.typ, 'chyba');
      assert.equal(odpoved.kod, 4);
      console.log('OK — 7) chybný podpis → chyba kód 4 (ověřeno mockem, který reálně ověřuje podpis)');
    }

    // 8) Neplatná XML zpráva — odstraníme povinný atribut celk_trzba ze
    //    syrového XML (mimo náš generátor, přímou manipulací stringu) tak,
    //    aby prošla přes podpis (podepisuje se, co je v obálce), ale
    //    neprošla XSD validací na straně příjemce → kód 3.
    {
      const zpravaValidni = await sestavitPodepsanouZpravu(trzba('ET-PG-007'), klic);
      const poskozena = zpravaValidni.replace(/ celk_trzba="[^"]*"/, '');
      // Podpis se tím zneplatní (obsah Body se po podpisu změnil) — ale to
      // je v pořádku, mock kontroluje XSD validitu PŘED kontrolou podpisu
      // (viz tests/helpers/mock-eet-server.js), takže i tak dostaneme kód 3,
      // ne kód 4 — ověřujeme tím navíc i pořadí kontrol.
      const { telo } = await _odeslatNaLokalniMockServer(poskozena, mock.url);
      const odpoved = rozebratOdpoved(telo);
      assert.equal(odpoved.typ, 'chyba');
      assert.equal(odpoved.kod, 3);
      console.log('OK — 8) neplatná XML zpráva (chybějící povinný atribut) → chyba kód 3');
    }

    // 9) Timeout a opakované odeslání.
    {
      const t = trzba('ET-PG-008-MOCK-TIMEOUT');
      const pokus1 = await sestavitPodepsanouZpravu(t, klic, dalsiPokusOdeslani(t, 0));
      await assert.rejects(
        () => _odeslatNaLokalniMockServer(pokus1, mock.url, { timeoutMs: 300 }),
        EetTimeout,
        'mock server pro MOCK-TIMEOUT nikdy neodpoví — klient musí timeoutnout'
      );

      // Opakování: STEJNÁ identita tržby (jen jsme odstranili marker, aby mock
      // tentokrát odpověděl — v reálu by porad_cis zůstal stejný, markerem
      // tady jen simulujeme "druhý pokus po výpadku"), NOVÉ uuid_zpravy.
      const tOpakovani = trzba('ET-PG-008');
      const pokus2 = await sestavitPodepsanouZpravu(tOpakovani, klic, dalsiPokusOdeslani(tOpakovani, 1));
      assert.notEqual(pokus1, pokus2);
      const { telo } = await _odeslatNaLokalniMockServer(pokus2, mock.url);
      const odpoved = rozebratOdpoved(telo);
      assert.equal(odpoved.typ, 'potvrzeni');
      console.log('OK — 9) timeout (žádná odpověď) → EetTimeout; opakování s novým uuid_zpravy → potvrzení');
    }
  } finally {
    await mock.zastavit();
    console.log('(mock EET server zastaven)');
  }

  console.log('\n✅ VŠECHNY TESTY TESTOVACÍHO KLIENTA (PROTI LOKÁLNÍMU MOCKU) PROŠLY');
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
