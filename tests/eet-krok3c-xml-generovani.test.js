// Krok 3c (Fáze A) — generování a lokální XSD validace XML zprávy evidované
// tržby pro všechny požadované scénáře. Čistě lokální/ofline: žádné
// TEST_API_BASE, žádné DATABASE_URL, žádné síťové volání — jen eet/xml-zprava.js
// + eet/xsd-validace.js proti EETXMLSchema.xsd uloženému v eet_specifikace/.
//
// Spuštění:  node tests/eet-krok3c-xml-generovani.test.js
const assert = require('node:assert/strict');
const {
  sestavitXmlTrzby, formatovatDatumCas, formatovatCastku, MASKY, EetFormatovaciChyba
} = require('../eet/xml-zprava');
const { validovatProtiXsd } = require('../eet/xsd-validace');
const { TESTOVACI_EIC } = require('../eet/specifikace');

const CFG = { eicPopl: TESTOVACI_EIC.pravnickaOsoba };

async function ocekavatValidni(xml, popis) {
  const v = await validovatProtiXsd(xml);
  assert.equal(v.valid, true, `${popis}: XML má být validní proti XSD, ale: ${JSON.stringify(v.errors)}`);
}

async function main() {
  console.log('--- Krok 3c: generování a XSD validace XML zprávy evidované tržby ---');

  // 1) Běžná platba (rezervace, platba hotově/kartou) — jen celk_trzba.
  {
    const trzba = { id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis: 'ET-1001', dat_trzby: new Date('2027-03-05T12:25:01+01:00'), celk_trzba: '890.00' };
    const { xml, data } = sestavitXmlTrzby(trzba, CFG, { prvniZaslani: true });
    assert.equal(data.urceno_cerp_zuct, undefined, 'běžná platba nesmí obsahovat urceno_cerp_zuct');
    assert.equal(data.cerp_zuct, undefined, 'běžná platba nesmí obsahovat cerp_zuct');
    await ocekavatValidni(xml, 'běžná platba');
    console.log('OK — 1) běžná platba');
  }

  // 2) Hodnotový poukaz — VYDÁNÍ (nabití): urceno_cerp_zuct = celk_trzba.
  {
    const trzba = { id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis: 'ET-1002', dat_trzby: new Date('2027-03-05T12:30:00+01:00'), celk_trzba: '2000.00', urceno_cerp_zuct: '2000.00' };
    const { xml, data } = sestavitXmlTrzby(trzba, CFG, { prvniZaslani: true });
    assert.equal(data.urceno_cerp_zuct, '2000.00');
    assert.equal(data.cerp_zuct, undefined);
    await ocekavatValidni(xml, 'hodnotový poukaz — vydání');
    console.log('OK — 2a) hodnotový poukaz — vydání (nabití)');
  }

  // 2b) Hodnotový poukaz — ČERPÁNÍ (uplatnění části/celku): cerp_zuct = celk_trzba.
  {
    const trzba = { id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis: 'ET-1003', dat_trzby: new Date('2027-04-10T09:00:00+02:00'), celk_trzba: '890.00', cerp_zuct: '890.00' };
    const { xml, data } = sestavitXmlTrzby(trzba, CFG, { prvniZaslani: true });
    assert.equal(data.cerp_zuct, '890.00');
    assert.equal(data.urceno_cerp_zuct, undefined);
    await ocekavatValidni(xml, 'hodnotový poukaz — čerpání');
    console.log('OK — 2b) hodnotový poukaz — čerpání');
  }

  // 3) Poukaz na KONKRÉTNÍ masáž — eviduje se JEN prodej poukazu (žádné
  //    urceno_cerp_zuct/cerp_zuct, protože nejde o "platbu v omezené síti" —
  //    viz EET_popis_polozek_datove_zpravy.pdf, kap. 5.2, příklad 4: "Při
  //    uplatnění poukazu již k platbě nedochází... a proto se tento úkon
  //    neeviduje." — uplatnění se tedy do EET vůbec nedostane, žádná XML
  //    zpráva pro něj nevzniká (ověřeno už v tests/eet-krok3b-platby.test.js
  //    na úrovni serveru — tady jen ověřujeme formát zprávy PRO PRODEJ).
  {
    const trzba = { id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis: 'ET-1004', dat_trzby: new Date('2027-05-16T15:41:12+02:00'), celk_trzba: '1000.00' };
    const { xml, data } = sestavitXmlTrzby(trzba, CFG, { prvniZaslani: true });
    assert.equal(data.urceno_cerp_zuct, undefined);
    assert.equal(data.cerp_zuct, undefined);
    await ocekavatValidni(xml, 'poukaz na konkrétní masáž — prodej');
    console.log('OK — 3) poukaz na konkrétní masáž (eviduje se jen prodej)');
  }

  // 4) Kombinovaná platba — DB (eet_zaevidovat_zdroj, Krok 3a) sloučí víc
  //    zdrojů (např. poukaz + hotovost) do JEDNÉ evidovana_trzba se sečtenou
  //    celk_trzba. Tady modelujeme už sloučený výsledek (sčítání samotné je
  //    otestované v tests/eet-krok3a.test.js) a ověřujeme, že z něj vznikne
  //    jedna platná XML zpráva.
  {
    const castkaPoukazem = 500, castkaHotove = 390;
    const trzba = { id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis: 'ET-1005', dat_trzby: new Date('2027-06-01T11:00:00+02:00'), celk_trzba: String(castkaPoukazem + castkaHotove) };
    const { xml } = sestavitXmlTrzby(trzba, CFG, { prvniZaslani: true });
    await ocekavatValidni(xml, 'kombinovaná platba');
    console.log('OK — 4) kombinovaná platba (sloučení víc zdrojů do jedné tržby)');
  }

  // 5) Vratka (vrácení platby zákazníkovi) — eviduje se jako ZÁPORNÁ částka,
  //    BEZ jakékoli vazby na původní tržbu (žádné UUID, žádný odkaz) —
  //    EET_popis_polozek_datove_zpravy.pdf, kap. 4: "Zaslané údaje o
  //    provedeném stornu či opravě nejsou z technického hlediska nijak
  //    vázány na původní tržbu."
  {
    const trzba = { id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis: 'ET-1006', dat_trzby: new Date('2027-09-10T17:08:33+02:00'), celk_trzba: '-5450.00' };
    const { xml, data } = sestavitXmlTrzby(trzba, CFG, { prvniZaslani: true });
    assert.equal(data.celk_trzba, '-5450.00');
    const povoleneKlice = new Set(['eic_popl', 'eic_poverujiciho', 'povereni_vice_popl', 'id_jednotky', 'id_pokl', 'porad_cis', 'dat_trzby', 'celk_trzba', 'urceno_cerp_zuct', 'cerp_zuct']);
    for (const klic of Object.keys(data)) {
      assert.ok(povoleneKlice.has(klic), `Data vratky obsahuje nedokumentovaný atribut "${klic}" — žádné pole pro odkaz na původní tržbu neexistuje v TrzbaDataType.`);
    }
    await ocekavatValidni(xml, 'vratka');
    console.log('OK — 5) vratka (záporná částka, bez vazby na originál)');
  }

  // 6) Storno chybně zaevidované tržby — stejný princip jako vratka (jen
  //    jiný obchodní důvod), samostatný scénář na výslovnou žádost.
  {
    const trzba = { id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis: 'ET-1007', dat_trzby: new Date('2027-09-04T08:12:46+02:00'), celk_trzba: '-24.00' };
    const { xml, data } = sestavitXmlTrzby(trzba, CFG, { prvniZaslani: true });
    assert.equal(data.celk_trzba, '-24.00');
    await ocekavatValidni(xml, 'storno');
    console.log('OK — 6) storno chybně zaevidované tržby');
  }

  // 7) Ověřovací mód (overeni=true) — jen formát, NIKDY se nikam neodesílá
  //    v tomhle kroku (to je zakázané zadáním). Testuje se jen generování.
  {
    const trzba = { id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis: 'ET-1008', dat_trzby: new Date(), celk_trzba: '1.00' };
    const { xml, hlavicka } = sestavitXmlTrzby(trzba, CFG, { prvniZaslani: true, overeni: true });
    assert.equal(hlavicka.overeni, true);
    assert.ok(xml.includes('overeni="true"'));
    await ocekavatValidni(xml, 'ověřovací mód');
    console.log('OK — 7) ověřovací mód (jen formát, nic se neodesílá)');
  }

  // 8) Formátování částky — CastkaType maska, včetně hraničního "-0.XX" tvaru.
  {
    assert.equal(formatovatCastku(0), '0.00');
    assert.equal(formatovatCastku('0'), '0.00');
    assert.equal(formatovatCastku(-0.5), '-0.50');
    assert.equal(formatovatCastku('-121'), '-121.00');
    assert.equal(formatovatCastku(81.6), '81.60');
    assert.throws(() => formatovatCastku(100000000), EetFormatovaciChyba, 'hodnota >= 100 000 000 musí být odmítnuta');
    assert.throws(() => formatovatCastku(NaN), EetFormatovaciChyba);
    console.log('OK — 8) formátování částky (CastkaType)');
  }

  // 9) Formátování data/času — zimní (+01:00) vs letní (+02:00) čas v ČR,
  //    automaticky podle data (Europe/Prague), bez závislosti na TZ serveru.
  {
    const zimni = formatovatDatumCas(new Date('2027-01-09T03:25:28Z'));
    assert.equal(zimni, '2027-01-09T04:25:28+01:00');
    const letni = formatovatDatumCas(new Date('2027-06-09T03:25:28Z'));
    assert.equal(letni, '2027-06-09T05:25:28+02:00');
    assert.match(zimni, MASKY.datumCas);
    assert.match(letni, MASKY.datumCas);
    console.log('OK — 9) formátování data/času (SEČ/SELČ)');
  }

  // 10) Neplatná konfigurace (id_jednotky s vedoucí nulou) musí spadnout na
  //     masce HNED při generování, ne až na XSD validaci o krok později.
  {
    const trzba = { id_jednotky: '024', id_pokl: 'P1', porad_cis: 'X', dat_trzby: new Date(), celk_trzba: '1.00' };
    assert.throws(() => sestavitXmlTrzby(trzba, CFG, { prvniZaslani: true }), EetFormatovaciChyba);
    console.log('OK — 10) neplatné id_jednotky (vedoucí nula) je odmítnuto při generování');
  }

  console.log('\n✅ VŠECHNY TESTY GENEROVÁNÍ A XSD VALIDACE PROŠLY');
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
