// Krok 3c ÚKOL B, bod 6 — PŘIPRAVENÝ (ne spuštěný) test prvního ověřovacího
// odeslání na SKUTEČNÝ oficiální Playground, s overeni="true" (ověřovací
// mód — nic se tím nezaeviduje, jen se testuje spojení, viz specifikace
// kap. 2.2.1).
//
// BEZPEČNOSTNÍ ZÁMEK: tenhle test se SÁM OD SEBE nikdy nespustí doopravdy.
// Dokud není v prostředí nastaveno EET_SCHVALENO_PRVNI_ODESLANI=true (a
// zároveň cesty ke skutečnému testovacímu certifikátu Playgroundu), skript
// jen vypíše, co by udělal, a skončí úspěchem (exit 0) BEZ JAKÉHOKOLI
// síťového volání — takže ho lze bezpečně spouštět i jako součást běžné
// regresní sady, aniž by kdy něco odeslal.
//
// Až bude odeslání výslovně schváleno, spustí se takto (viz plán v hlášení):
//   EET_SCHVALENO_PRVNI_ODESLANI=true \
//   EET_PLAYGROUND_CERT_PEM=/cesta/k/certifikatu.pem \
//   EET_PLAYGROUND_KEY_PEM=/cesta/k/soukromemu-klici.pem \
//   node tests/eet-krok3d-pripraveny-overovaci-pokus.test.js
//
// Certifikát a klíč se získají z oficiálního CAEET_Playground_2026_v1.zip
// (eet.gov.cz) extrakcí p12 souboru (heslo je přiloženo v tom ZIPu,
// soubor "password_pokladni_cert_playground.txt") — NIKDY se neukládají do
// tohoto repozitáře (viz .gitignore: *.p12/*.pfx/*.pem/*.key).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { sestavitXmlTrzby } = require('../eet/xml-zprava');
const { sestavitNepodepsanouObalku } = require('../eet/soap-obalka');
const { podepsatObalku } = require('../eet/podpis');
const { rozebratOdpoved } = require('../eet/odpoved-parser');
const { REZIM, odeslatZpravu } = require('../eet/playground-klient');
const { TESTOVACI_EIC } = require('../eet/specifikace');

const SCHVALENO = process.env.EET_SCHVALENO_PRVNI_ODESLANI === 'true';

async function main() {
  console.log('--- Krok 3d: připravený ověřovací pokus na oficiální Playground (overeni=true) ---');

  // Syntetická, zcela fiktivní tržba — jen pro ověření spojení, žádná
  // skutečná obchodní událost. id_jednotky/id_pokl jsou formálně platné
  // (odpovídají maskám), ale nejsou vázané na žádnou skutečnou evidenční
  // jednotku — v ověřovacím módu to podle specifikace nevadí.
  const trzba = {
    id_jednotky: '1',
    id_pokl: 'TEST-OVERENI-1',
    porad_cis: `OVERENI-${Date.now()}`,
    dat_trzby: new Date(),
    celk_trzba: '1.00'
  };
  const cfg = { eicPopl: TESTOVACI_EIC.pravnickaOsoba }; // CZ00000019, sdílené testovací EIČ

  if (!SCHVALENO) {
    console.log('EET_SCHVALENO_PRVNI_ODESLANI není nastaveno na "true" — test je PŘIPRAVENÝ, ale NESPOUŠTÍ se.');
    console.log('Žádné síťové volání neproběhlo. To je očekávaný, bezpečný výchozí stav.');
    console.log(`Byla by odeslána tato syntetická tržba (overeni=true): ${JSON.stringify(trzba)}`);
    console.log('\n✅ TEST PŘIPRAVEN (neprovedeno — čeká na výslovné schválení)');
    return;
  }

  // Od tohoto místa dál by test SKUTEČNĚ odeslal zprávu na Playground —
  // spustí se jen po výslovném schválení a s reálně dodaným certifikátem.
  const certPath = process.env.EET_PLAYGROUND_CERT_PEM;
  const keyPath = process.env.EET_PLAYGROUND_KEY_PEM;
  if (!certPath || !keyPath) {
    throw new Error('EET_SCHVALENO_PRVNI_ODESLANI=true vyžaduje i EET_PLAYGROUND_CERT_PEM a EET_PLAYGROUND_KEY_PEM.');
  }
  const certificatePem = fs.readFileSync(certPath, 'utf8');
  const privateKeyPem = fs.readFileSync(keyPath, 'utf8');

  const { xml } = sestavitXmlTrzby(trzba, cfg, { prvniZaslani: true, overeni: true });
  const nepodepsana = sestavitNepodepsanouObalku(xml, { certificatePem });
  const podepsana = podepsatObalku(nepodepsana, { privateKeyPem, certificatePem });

  console.log('Odesílám ověřovací zprávu na OFICIÁLNÍ Playground...');
  const { httpStatus, telo } = await odeslatZpravu(podepsana, { rezim: REZIM.OFFICIAL_PLAYGROUND, timeoutMs: 20000 });
  console.log('HTTP status:', httpStatus);
  console.log('Tělo odpovědi:', telo);

  const odpoved = rozebratOdpoved(telo);
  console.log('Rozebraná odpověď:', odpoved);

  // Očekávaný výsledek dle specifikace (kap. 2.2.2, tabulka 1): ověřovací mód
  // na Playgroundu, validní zpráva → chybová zpráva s kódem 0, test=true.
  assert.equal(odpoved.typ, 'chyba', 'ověřovací mód vždy vrací "chybovou" datovou zprávu i při úspěchu (kód 0)');
  assert.equal(odpoved.kod, 0, 'kód 0 = "Datovou zpravu evidovane trzby v overovacim modu se podarilo zpracovat"');
  assert.equal(odpoved.test, true, 'odpověď z Playgroundu musí mít test=true');

  console.log('\n✅ OVĚŘOVACÍ POKUS NA PLAYGROUND ÚSPĚŠNÝ (kód 0, test=true)');
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
