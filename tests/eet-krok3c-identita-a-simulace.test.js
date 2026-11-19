// Krok 3c (Fáze A) — body 5 a 6 zadání:
//   5) pravidla pro opakované odesílání (identita tržby vs. UUID zprávy)
//   6) lokální simulace odpovědí (potvrzení/chyba/timeout/opakování)
// Čistě lokální, beze SÍŤOVÉHO volání — bod "Simulace nesmí navazovat žádné
// skutečné spojení s Finanční správou" je ověřen i staticky (test 6 níž čte
// zdrojový kód eet/simulator.js a kontroluje, že v něm není import žádného
// síťového modulu).
//
// Spuštění:  node tests/eet-krok3c-identita-a-simulace.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sestavitXmlTrzby, MASKY } = require('../eet/xml-zprava');
const { jeToPrvniZaslani, dalsiPokusOdeslani, overitNezmenenouIdentitu } = require('../eet/odesilaci-identita');
const { simulovatOdpoved, SimulovanyTimeout, CHYBOVE_KODY } = require('../eet/simulator');
const { TESTOVACI_EIC } = require('../eet/specifikace');

const CFG = { eicPopl: TESTOVACI_EIC.pravnickaOsoba };

async function main() {
  console.log('--- Krok 3c: identita tržby vs. UUID zprávy, lokální simulace odpovědí ---');

  // 1) Identita tržby (id_jednotky/id_pokl/porad_cis/dat_trzby/celk_trzba)
  //    je MEZI POKUSY stejná, ale uuid_zpravy a prvni_zaslani se liší.
  {
    const trzba = { id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis: 'ET-3001', dat_trzby: new Date('2027-04-25T15:30:40+02:00'), celk_trzba: '350.00' };

    assert.equal(jeToPrvniZaslani(0), true);
    assert.equal(jeToPrvniZaslani(1), false);
    assert.equal(jeToPrvniZaslani(5), false);

    const pokus1 = sestavitXmlTrzby(trzba, CFG, dalsiPokusOdeslani(trzba, 0));
    assert.equal(pokus1.hlavicka.prvni_zaslani, true);

    // "opakované zaslání" po výpadku spojení — stejná tržba, DRUHÝ pokus.
    const pokus2 = sestavitXmlTrzby(trzba, CFG, dalsiPokusOdeslani(trzba, 1));
    assert.equal(pokus2.hlavicka.prvni_zaslani, false);

    // UUID zprávy MUSÍ být jiné při každém pokusu (spec: nové UUID i při
    // opakovaném zaslání téže tržby).
    assert.notEqual(pokus1.hlavicka.uuid_zpravy, pokus2.hlavicka.uuid_zpravy);
    assert.match(pokus1.hlavicka.uuid_zpravy, MASKY.uuidZpravy);
    assert.match(pokus2.hlavicka.uuid_zpravy, MASKY.uuidZpravy);

    // Identita tržby (datová oblast <Data>) musí zůstat BEZE ZMĚNY.
    assert.deepEqual(pokus1.data, pokus2.data);
    console.log('OK — 1) identita tržby stejná, uuid_zpravy a prvni_zaslani se liší mezi pokusy');
  }

  // 2) Pokus o změnu identity tržby mezi pokusy (např. jiná částka) musí být
  //    odmítnut APLIKAČNĚ (zrcadlo DB triggeru evidovana_trzba_chranit_po_odeslani)
  //    — rychlejší diagnóza, dřív než by to zamítla databáze.
  {
    const puvodni = { id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis: 'ET-3002', dat_trzby: '2027-04-25T15:30:40+02:00', celk_trzba: '350.00', smer: 'prijem' };
    const zmeneny = { ...puvodni, celk_trzba: '999.00' };
    assert.throws(() => overitNezmenenouIdentitu(puvodni, zmeneny), /celk_trzba/);
    assert.equal(overitNezmenenouIdentitu(puvodni, { ...puvodni }), true);
    console.log('OK — 2) změna identity tržby mezi pokusy je odmítnuta');
  }

  // 3) Simulace ÚSPĚŠNÉHO potvrzení — tvar odpovědi odpovídá potvrzovací
  //    datové zprávě (pok ve správném formátu, test=true protože jde o
  //    simulaci, nikdy ne skutečnou produkci).
  {
    const odpoved = simulovatOdpoved('potvrzeni', { uuidZpravy: 'b3a09b52-7c87-4014-a496-4c7a53cf9125' });
    assert.equal(odpoved.typ, 'potvrzeni');
    assert.equal(odpoved.test, true);
    assert.match(odpoved.pok, /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}-[0-9a-fA-F]{2}$/);
    console.log('OK — 3) simulace úspěšného potvrzení (správný formát POK)');
  }

  // 4) Simulace CHYBOVÉ odpovědi — používá jen dokumentované kódy
  //    (EET_popis_rozhrani_v1.2.pdf, kap. 3.5.4), ne vymyšlené.
  {
    const odpoved = simulovatOdpoved('chyba', { uuidZpravy: 'b3a09b52-7c87-4014-a496-4c7a53cf9125', chyba: CHYBOVE_KODY.XSD });
    assert.equal(odpoved.typ, 'chyba');
    assert.equal(odpoved.kod, 3);
    assert.equal(odpoved.text, 'XML zprava nevyhovela kontrole XML schematu');
    console.log('OK — 4) simulace chybové odpovědi (dokumentovaný kód 3)');
  }

  // 5) Simulace TIMEOUTU a NÁSLEDNÉHO OPAKOVÁNÍ — ukazuje celý tok: pokus 1
  //    → timeout (žádná odpověď do mezní doby odezvy) → stav "nejisté" →
  //    pokus 2 (nové UUID, prvni_zaslani=false, IDENTICKÁ identita tržby) →
  //    potvrzení.
  {
    const trzba = { id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis: 'ET-3003', dat_trzby: new Date('2027-04-25T15:30:40+02:00'), celk_trzba: '350.00' };

    const pokus1 = sestavitXmlTrzby(trzba, CFG, dalsiPokusOdeslani(trzba, 0));
    assert.throws(
      () => simulovatOdpoved('timeout', { uuidZpravy: pokus1.hlavicka.uuid_zpravy }),
      SimulovanyTimeout
    );
    // → aplikace by teď (v budoucím Kroku 3d) uložila stav_evidence='nejiste'
    //   a tuto evidovanou tržbu později znovu zařadila do fronty (viz
    //   eet_zamknout_dalsi_davku v schema.sql — ten mechanismus už existuje).

    const pokus2 = sestavitXmlTrzby(trzba, CFG, dalsiPokusOdeslani(trzba, 1));
    assert.equal(pokus2.hlavicka.prvni_zaslani, false);
    assert.notEqual(pokus2.hlavicka.uuid_zpravy, pokus1.hlavicka.uuid_zpravy);
    assert.deepEqual(pokus2.data, pokus1.data);

    const odpoved2 = simulovatOdpoved('potvrzeni', { uuidZpravy: pokus2.hlavicka.uuid_zpravy });
    assert.equal(odpoved2.typ, 'potvrzeni');
    console.log('OK — 5) timeout → opakování s novým UUID → potvrzení (identita tržby neporušena)');
  }

  // 6) STATICKÁ kontrola: eet/simulator.js nesmí obsahovat ŽÁDNÝ import
  //    síťového modulu ani volání fetch — tj. nemůže technicky navázat
  //    spojení s Finanční správou, ani s Playgroundem, ani s čímkoli jiným.
  {
    const zdrojovyKod = fs.readFileSync(path.join(__dirname, '..', 'eet', 'simulator.js'), 'utf8');
    const zakazaneVzory = [/require\(\s*['"]https?['"]\s*\)/, /require\(\s*['"]net['"]\s*\)/, /require\(\s*['"]dgram['"]\s*\)/, /\bfetch\s*\(/, /XMLHttpRequest/];
    for (const vzor of zakazaneVzory) {
      assert.ok(!vzor.test(zdrojovyKod), `eet/simulator.js nesmí obsahovat ${vzor} — simulace musí být nedosažitelná po síti`);
    }
    console.log('OK — 6) eet/simulator.js staticky neobsahuje žádný síťový kód');
  }

  console.log('\n✅ VŠECHNY TESTY IDENTITY/OPAKOVÁNÍ A LOKÁLNÍ SIMULACE PROŠLY');
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
