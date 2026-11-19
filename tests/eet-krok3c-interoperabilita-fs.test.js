// Krok 3c — nezávislý interoperabilní test proti SKUTEČNÝM, oficiálním
// vzorovým zprávám publikovaným přímo Finanční správou
// (eet_specifikace/CZ*.eet.v4.req.xml — staženo z eet.gov.cz, veřejné,
// obsahují jen sdílený TESTOVACÍ certifikát, žádný soukromý klíč).
//
// Tohle NENÍ test naší vlastní generace (ten je v
// eet-krok3c-xml-generovani.test.js) — je to test, že NAŠE OVĚŘOVACÍ KOD
// (XSD validace + WS-Security ověření podpisu) správně rozumí zprávě, kterou
// NAPSAL NĚKDO JINÝ (přímo FS) podle stejné specifikace. Úspěšné ověření
// skutečného kryptografického podpisu nad reálnou zprávou od FS je mnohem
// silnější důkaz správnosti naší implementace WS-Security než cokoli, co
// umíme otestovat jen sami se sebou.
//
// Žádné síťové volání — jen čtení lokálních souborů.
//
// Spuštění:  node tests/eet-krok3c-interoperabilita-fs.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateXML } = require('xmllint-wasm');
const { extrahovatBstBase64Der, base64DerNaPem } = require('../eet/soap-obalka');
const { overitPodpisObalky } = require('../eet/podpis');
const { PODKLADY } = require('../eet/specifikace');

const ADRESAR = path.join(__dirname, '..', 'eet_specifikace');

// bstId se u těchto vzorů liší soubor od souboru (FS generuje náhodné wsu:Id
// pro každou zprávu) — vytáhneme ho přímo z BinarySecurityToken elementu.
function ziskatBstId(xml) {
  const m = xml.match(/<wsse:BinarySecurityToken[^>]*wsu:Id="([^"]+)"/);
  return m ? m[1] : null;
}

async function overitVzor(nazevSouboru, ocekavanyEic) {
  const xml = fs.readFileSync(path.join(ADRESAR, nazevSouboru), 'utf8');

  // Vzory FS používají prefix "v4:" (deklarovaný na Envelope), naše vlastní
  // generace "tns:" (deklarovaný lokálně na Trzba) — XSD validuje podle
  // namespace URI, ne podle prefixu, takže potřebujeme jen zajistit, že
  // extrahovaný fragment má svou xmlns deklaraci u sebe.
  const shoda = xml.match(/<v4:Trzba>[^]*?<\/v4:Trzba>/);
  assert.ok(shoda, `${nazevSouboru}: element <v4:Trzba> nebyl nalezen`);
  const trzba = shoda[0].replace('<v4:Trzba>', `<v4:Trzba xmlns:v4="${PODKLADY ? 'http://fs.gov.cz/eet/schema/v4' : ''}">`);

  const xsd = fs.readFileSync(PODKLADY.xsd.soubor, 'utf8');
  const xsdVysledek = await validateXML({
    xml: { fileName: nazevSouboru, contents: trzba },
    schema: { fileName: 'EETXMLSchema.xsd', contents: xsd }
  });
  assert.equal(xsdVysledek.valid, true, `${nazevSouboru}: oficiální vzor FS musí projít NAŠÍ XSD validací: ${JSON.stringify(xsdVysledek.errors)}`);

  assert.ok(trzba.includes(`eic_popl="${ocekavanyEic}"`), `${nazevSouboru}: očekávané EIČ ${ocekavanyEic} nenalezeno`);

  const bstId = ziskatBstId(xml);
  assert.ok(bstId, `${nazevSouboru}: BinarySecurityToken nenalezen`);
  const bstB64 = extrahovatBstBase64Der(xml, bstId);
  assert.ok(bstB64, `${nazevSouboru}: obsah BinarySecurityToken nenalezen`);
  const certPem = base64DerNaPem(bstB64);

  const overeni = overitPodpisObalky(xml, { certificatePem: certPem });
  assert.equal(overeni.valid, true, `${nazevSouboru}: NÁŠ overitPodpisObalky musí uznat skutečný podpis FS za platný: ${overeni.duvod}`);

  return { trzba, certPem };
}

async function main() {
  console.log('--- Krok 3c: interoperabilita s oficiálními vzory Finanční správy ---');

  const { certPem: certCZ00000019 } = await overitVzor('CZ00000019.eet.v4.req.xml', 'CZ00000019');
  console.log('OK — 1) CZ00000019.eet.v4.req.xml: naše XSD validace i ověření podpisu uznávají oficiální vzor FS za platný');

  await overitVzor('CZ683555118.eet.v4.req.xml', 'CZ683555118');
  console.log('OK — 2) CZ683555118.eet.v4.req.xml: totéž');

  await overitVzor('CZ8551015704.eet.v4.req.xml', 'CZ8551015704');
  console.log('OK — 3) CZ8551015704.eet.v4.req.xml: totéž');

  // 4) Certifikát z BST musí být vydaný (přes řetězec) EET CA 2 Playground —
  //    kryptografické ověření řetězce (ne jen textové porovnání subject/issuer).
  {
    const { X509Certificate } = require('crypto');
    const cert = new X509Certificate(certCZ00000019);
    const subCa = new X509Certificate(fs.readFileSync(path.join(ADRESAR, 'ca_eet-sub_cert-playground.crt')));
    const rootCa = new X509Certificate(fs.readFileSync(path.join(ADRESAR, 'ca_eet-root_cert-playground.crt')));
    assert.equal(subCa.verify(rootCa.publicKey), true, 'Sub CA musí být podepsána Root CA (kryptograficky ověřeno)');
    assert.equal(cert.verify(subCa.publicKey), true, 'Pokladní certifikát CZ00000019 musí být podepsán Sub CA (kryptograficky ověřeno)');
    assert.equal(rootCa.subject, rootCa.issuer, 'Root CA musí být sama sobě vydavatelem (self-signed)');
    console.log('OK — 4) kryptograficky ověřený řetězec: Root CA -> Sub CA -> pokladní certifikát CZ00000019');
  }

  console.log('\n✅ VŠECHNY INTEROPERABILNÍ TESTY S OFICIÁLNÍMI VZORY FS PROŠLY');
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
