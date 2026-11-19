// Krok 3c — nezávislá kontrola (bod 3): negativní testy.
//   1) neplatný podpis
//   2) změněný obsah XML (po podpisu)
//   3) chybějící povinné pole
//   4) neplatná částka
//   5) chybný certifikát
//   6) opakovaný požadavek (duplicitní odeslání)
// Čistě lokální, beze síťového volání.
//
// Spuštění:  node tests/eet-krok3c-negativni.test.js
const assert = require('node:assert/strict');
const { sestavitXmlTrzby, formatovatCastku, EetFormatovaciChyba } = require('../eet/xml-zprava');
const { sestavitNepodepsanouObalku } = require('../eet/soap-obalka');
const { podepsatObalku, overitPodpisObalky, overitShoduKlicACertifikatu, vytvoritTestovaciKlic } = require('../eet/podpis');
const { dalsiPokusOdeslani } = require('../eet/odesilaci-identita');
const { TESTOVACI_EIC } = require('../eet/specifikace');

const CFG = { eicPopl: TESTOVACI_EIC.pravnickaOsoba };
const VZOROVA_TRZBA = () => ({ id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis: 'ET-9001', dat_trzby: new Date(), celk_trzba: '100.00' });

async function main() {
  console.log('--- Krok 3c: negativní testy ---');

  // 1) NEPLATNÝ PODPIS — ručně porušená SignatureValue musí být odhalena.
  {
    const { privateKeyPem, certificatePem } = vytvoritTestovaciKlic();
    const nepodepsana = sestavitNepodepsanouObalku(sestavitXmlTrzby(VZOROVA_TRZBA(), CFG, { prvniZaslani: true }).xml, { certificatePem });
    const podepsana = podepsatObalku(nepodepsana, { privateKeyPem, certificatePem });
    // Porušíme jen jeden znak v Base64 SignatureValue (platný Base64, ale jiná hodnota).
    const porusena = podepsana.replace(/<SignatureValue>([A-Za-z0-9+/=]{20})/, (m, p1) => {
      const otocene = p1[0] === 'A' ? 'B' : 'A';
      return `<SignatureValue>${otocene}${p1.slice(1)}`;
    });
    assert.notEqual(porusena, podepsana, 'test musí reálně pozměnit SignatureValue');
    const overeni = overitPodpisObalky(porusena, { certificatePem });
    assert.equal(overeni.valid, false, 'ručně porušený podpis MUSÍ být odmítnut');
    console.log('OK — 1) neplatný (ručně porušený) podpis je odmítnut');
  }

  // 2) ZMĚNĚNÝ OBSAH XML po podpisu — i jen částka beze zásahu do podpisu.
  {
    const { privateKeyPem, certificatePem } = vytvoritTestovaciKlic();
    const nepodepsana = sestavitNepodepsanouObalku(sestavitXmlTrzby(VZOROVA_TRZBA(), CFG, { prvniZaslani: true }).xml, { certificatePem });
    const podepsana = podepsatObalku(nepodepsana, { privateKeyPem, certificatePem });
    const zmenena = podepsana.replace('celk_trzba="100.00"', 'celk_trzba="100000.00"');
    assert.notEqual(zmenena, podepsana);
    const overeni = overitPodpisObalky(zmenena, { certificatePem });
    assert.equal(overeni.valid, false, 'změna obsahu podepsaného <Body> MUSÍ zneplatnit podpis');
    console.log('OK — 2) změněný obsah XML (jiná částka) po podpisu je odhalen');
  }

  // 3) CHYBĚJÍCÍ POVINNÉ POLE — každé z pěti povinných polí samostatně.
  {
    const povinna = ['id_jednotky', 'id_pokl', 'porad_cis', 'dat_trzby', 'celk_trzba'];
    for (const pole of povinna) {
      const trzba = VZOROVA_TRZBA();
      delete trzba[pole];
      assert.throws(
        () => sestavitXmlTrzby(trzba, CFG, { prvniZaslani: true }),
        EetFormatovaciChyba,
        `chybějící povinné pole "${pole}" musí být odmítnuto`
      );
    }
    console.log('OK — 3) chybějící povinné pole (všech 5) je odmítnuto s jasnou chybou');
  }

  // 4) NEPLATNÁ ČÁSTKA — několik variant.
  {
    const neplatneHodnoty = [
      'abc', NaN, Infinity, -Infinity, undefined, null,
      100000000, -100000000, 99999999.995, '82,50' // desetinná čárka místo tečky → parseFloat("82,50") = 82, ale ověříme i explicitně nečíselné
    ];
    for (const h of neplatneHodnoty) {
      assert.throws(() => formatovatCastku(h), (e) => {
        if (!(e instanceof EetFormatovaciChyba)) return false;
        return true;
      }, `hodnota ${JSON.stringify(h)} musí být odmítnuta jako neplatná částka`);
    }
    console.log('OK — 4) neplatná částka (NaN/Infinity/mimo rozsah/nedostatečná přesnost) je odmítnuta');
  }

  // 5) CHYBNÝ CERTIFIKÁT — tři varianty chybné konfigurace klíč/certifikát.
  {
    const klicA = vytvoritTestovaciKlic({ eic: TESTOVACI_EIC.pravnickaOsoba });
    const klicB = vytvoritTestovaciKlic({ eic: TESTOVACI_EIC.fyzickaOsoba });

    // 5a) Podpis klíčem A, ale v obálce je vložený certifikát B (BST neodpovídá klíči).
    const nepodepsana = sestavitNepodepsanouObalku(sestavitXmlTrzby(VZOROVA_TRZBA(), CFG, { prvniZaslani: true }).xml, { certificatePem: klicB.certificatePem });
    assert.throws(
      () => podepsatObalku(nepodepsana, { privateKeyPem: klicA.privateKeyPem, certificatePem: klicB.certificatePem }),
      /neodpovídá/,
      '5a) podpis klíčem, který nepatří k vloženému certifikátu, musí být odmítnut PŘED podpisem'
    );

    // 5b) Poškozený (nevalidní) certifikát.
    const poskozenyCert = klicA.certificatePem.replace('CERTIFICATE', 'CERTIFICATE_X');
    assert.throws(
      () => overitShoduKlicACertifikatu(klicA.privateKeyPem, poskozenyCert),
      /certifikát/
    );

    // 5c) Ověření proti zcela jinému (ale platnému) certifikátu musí selhat.
    const nepodepsanaC = sestavitNepodepsanouObalku(sestavitXmlTrzby(VZOROVA_TRZBA(), CFG, { prvniZaslani: true }).xml, { certificatePem: klicA.certificatePem });
    const podepsanaC = podepsatObalku(nepodepsanaC, { privateKeyPem: klicA.privateKeyPem, certificatePem: klicA.certificatePem });
    const overeniC = overitPodpisObalky(podepsanaC, { certificatePem: klicB.certificatePem });
    assert.equal(overeniC.valid, false, '5c) ověření proti nesouvisejícímu certifikátu musí selhat');

    console.log('OK — 5) chybný certifikát (neodpovídající klíč, poškozený certifikát, cizí certifikát) je odmítnut');
  }

  // 6) OPAKOVANÝ (DUPLICITNÍ) POŽADAVEK — stejná evidovaná tržba, druhý
  //    pokus: identita musí zůstat stejná, UUID zprávy se MUSÍ lišit (nikdy
  //    se nesmí poslat dvakrát STEJNÁ zpráva se stejným uuid_zpravy).
  {
    const trzba = VZOROVA_TRZBA();
    const pokus1 = sestavitXmlTrzby(trzba, CFG, dalsiPokusOdeslani(trzba, 0));
    const pokus2 = sestavitXmlTrzby(trzba, CFG, dalsiPokusOdeslani(trzba, 1));
    assert.notEqual(pokus1.hlavicka.uuid_zpravy, pokus2.hlavicka.uuid_zpravy, 'opakovaný pokus NESMÍ znovu použít stejné uuid_zpravy');
    assert.deepEqual(pokus1.data, pokus2.data, 'identita tržby musí zůstat identická i při opakování');
    assert.notEqual(pokus1.xml, pokus2.xml, 'výsledné XML pokusů 1 a 2 se musí lišit (jiné uuid_zpravy/dat_odesl/prvni_zaslani)');
    // Skutečná ochrana proti dvojímu zaevidování stejné tržby žije na úrovni
    // databáze (schema.sql: UNIQUE(id_jednotky, id_pokl, porad_cis,
    // dat_trzby) na evidovana_trzba + UNIQUE(zdroj_typ, zdroj_id) na
    // evidovana_trzba_zdroje, obojí ověřeno v tests/eet-krok3a.test.js a
    // tests/eet-krok3b-platby.test.js) — tady jen ověřujeme, že vrstva
    // generování XML tuhle identitu věrně zachovává a nikdy nereuse UUID.
    console.log('OK — 6) opakovaný požadavek: identita tržby zachována, uuid_zpravy se liší (duplicitní zaevidování brání DB vrstva, ověřeno v Krok 3a/3b testech)');
  }

  console.log('\n✅ VŠECHNY NEGATIVNÍ TESTY PROŠLY');
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
