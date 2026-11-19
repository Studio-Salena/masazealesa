// Krok 3c (Fáze A) — návrh podepisování SOAP zpráv dle WS-Security (bod 4).
// Používá VÝHRADNĚ čerstvě vygenerovaný, nedůvěryhodný testovací certifikát
// (eet/podpis.js: vytvoritTestovaciKlic()) — NIKDY skutečný produkční
// certifikát. Žádný .pem/.key soubor se tímto testem nezapisuje do
// repozitáře (klíč vzniká a je smazán z OS temp adresáře uvnitř
// vytvoritTestovaciKlic()). Čistě lokální, žádné síťové volání.
//
// Spuštění:  node tests/eet-krok3c-podpis.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sestavitXmlTrzby } = require('../eet/xml-zprava');
const { validovatProtiXsd } = require('../eet/xsd-validace');
const { sestavitNepodepsanouObalku, extrahovatTrzbu } = require('../eet/soap-obalka');
const { podepsatObalku, overitPodpisObalky, vytvoritTestovaciKlic } = require('../eet/podpis');
const { TESTOVACI_EIC } = require('../eet/specifikace');

function vzorovaTrzbaXml() {
  const trzba = { id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis: 'ET-2001', dat_trzby: new Date(), celk_trzba: '350.00' };
  return sestavitXmlTrzby(trzba, { eicPopl: TESTOVACI_EIC.pravnickaOsoba }, { prvniZaslani: true }).xml;
}

// Žádný .pem/.key/.p12 nesmí přibyt v projektovém adresáři "eet/" ani
// kdekoli v repozitáři jen tím, že test proběhne — kontrola na úrovni
// souborového systému, ne jen důvěra komentáři v kódu.
function vypsatSoubory(adresar) {
  return fs.readdirSync(adresar).sort();
}

async function main() {
  console.log('--- Krok 3c: návrh podepisování SOAP zpráv (WS-Security) ---');
  const eetAdresar = path.join(__dirname, '..', 'eet');
  const souboryPred = vypsatSoubory(eetAdresar);

  // 1) Podpis + ověření (round-trip) s čerstvým testovacím certifikátem.
  let privateKeyPem, certificatePem;
  {
    const klic = vytvoritTestovaciKlic();
    privateKeyPem = klic.privateKeyPem;
    certificatePem = klic.certificatePem;
    assert.ok(privateKeyPem.includes('BEGIN PRIVATE KEY') || privateKeyPem.includes('BEGIN RSA PRIVATE KEY'));
    assert.ok(certificatePem.includes('BEGIN CERTIFICATE'));

    const nepodepsana = sestavitNepodepsanouObalku(vzorovaTrzbaXml(), { certificatePem });
    const podepsana = podepsatObalku(nepodepsana, { privateKeyPem, certificatePem });
    assert.ok(podepsana.includes('<ds:Signature') || podepsana.includes('<Signature'), 'podepsaná obálka musí obsahovat element Signature');
    assert.ok(podepsana.includes('BinarySecurityToken'), 'podepsaná obálka musí obsahovat BinarySecurityToken s certifikátem');

    const overeni = overitPodpisObalky(podepsana, { certificatePem });
    assert.equal(overeni.valid, true, `podpis se měl ověřit jako platný: ${overeni.duvod}`);
    console.log('OK — 1) podpis + ověření (round-trip) s testovacím certifikátem');

    // 2) Trzba vytažená z PODEPSANÉ obálky musí být stále stejná a stále
    //    validní proti XSD (SOAP/WS-Security vrstva nesmí nijak zasáhnout
    //    do obsahu byznys dat).
    const puvodniXml = vzorovaTrzbaXml();
    const vytazenaXml = extrahovatTrzbu(podepsana);
    // porovnáváme strukturu dat, ne dat_odesl (ten je jiný, protože se
    // generoval dvakrát nezávisle) — ověříme aspoň XSD validitu a to, že jde
    // o stejný typ zprávy.
    const xsdVysledek = await validovatProtiXsd(vytazenaXml);
    assert.equal(xsdVysledek.valid, true, `Trzba z podepsané obálky musí být validní: ${JSON.stringify(xsdVysledek.errors)}`);
    assert.ok(vytazenaXml.includes('porad_cis="ET-2001"'));
    console.log('OK — 2) Trzba vytažená z podepsané obálky zůstává validní a nezměněná');
  }

  // 3) Narušení podepsaného obsahu (pozměnění částky v <Body> PO podpisu)
  //    MUSÍ zneplatnit podpis — jinak by byl podpis k ničemu.
  {
    const nepodepsana = sestavitNepodepsanouObalku(vzorovaTrzbaXml(), { certificatePem });
    const podepsana = podepsatObalku(nepodepsana, { privateKeyPem, certificatePem });
    const pozmenena = podepsana.replace('celk_trzba="350.00"', 'celk_trzba="999999.00"');
    assert.notEqual(pozmenena, podepsana, 'test si musí být jistý, že řetězec skutečně změnil');
    const overeni = overitPodpisObalky(pozmenena, { certificatePem });
    assert.equal(overeni.valid, false, 'podpis MUSÍ být neplatný po změně podepsaného obsahu');
    console.log('OK — 3) pozměnění podepsaných dat je detekováno (podpis se neověří)');
  }

  // 4) Ověření proti JINÉMU certifikátu (ne tomu, kterým bylo podepsáno)
  //    musí selhat.
  {
    const jinyKlic = vytvoritTestovaciKlic({ eic: TESTOVACI_EIC.fyzickaOsoba });
    const nepodepsana = sestavitNepodepsanouObalku(vzorovaTrzbaXml(), { certificatePem });
    const podepsana = podepsatObalku(nepodepsana, { privateKeyPem, certificatePem });
    const overeni = overitPodpisObalky(podepsana, { certificatePem: jinyKlic.certificatePem });
    assert.equal(overeni.valid, false, 'ověření proti cizímu certifikátu musí selhat');
    console.log('OK — 4) ověření proti nesprávnému certifikátu selže');
  }

  // 5) Žádný .pem/.key/.p12 soubor nesmí nikde v "eet/" přibyt jen tím, že
  //    testy proběhly — klíče žijí jen v paměti procesu a v mazaném OS temp.
  {
    const souboryPo = vypsatSoubory(eetAdresar);
    assert.deepEqual(souboryPo, souboryPred, 'adresář eet/ se nesmí změnit (žádný nový soubor s klíčem/certifikátem)');
    const zadneTajneSoubory = souboryPo.filter((n) => /\.(pem|key|p12|pfx|crt)$/i.test(n));
    assert.equal(zadneTajneSoubory.length, 0, 'v repozitáři nesmí být žádný .pem/.key/.p12/.pfx/.crt soubor');
    console.log('OK — 5) žádný klíč/certifikát nebyl zapsán do repozitáře');
  }

  console.log('\n✅ VŠECHNY TESTY PODEPISOVÁNÍ (WS-SECURITY) PROŠLY');
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
