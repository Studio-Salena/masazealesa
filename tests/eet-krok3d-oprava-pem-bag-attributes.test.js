// Regresní test pro chybu nalezenou při diagnostice chyby 4 ("Neplatny
// podpis SOAP zpravy") z prvního ověřovacího pokusu na EET Playgroundu
// (19.11.2026). Příčina: `openssl pkcs12 -clcerts -nokeys` (běžný způsob
// extrakce certifikátu z .p12) píše před samotný "-----BEGIN
// CERTIFICATE-----" blok řádky "Bag Attributes" / "localKeyID:" /
// "subject=" / "issuer=". Dřívější `pemNaBase64Der()` tyto řádky
// neodstraňovala — jen BEGIN/END markery a mezery — takže metadata splynula
// s base64 obsahem a <wsse:BinarySecurityToken> obsahoval nedekódovatelný,
// neplatný "certifikát". Ověřeno nezávisle přes OpenSSL (`base64 -d` +
// `openssl x509 -inform DER`): před opravou embedded obsah nebyl platný
// X.509 certifikát, po opravě je bajtově identický s reálným DER.
//
// Spuštění:  node tests/eet-krok3d-oprava-pem-bag-attributes.test.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pemNaBase64Der } = require('../eet/soap-obalka');
const { vytvoritTestovaciKlic } = require('../eet/podpis');

async function main() {
  console.log('--- Krok 3d: regrese pro "Bag Attributes" v PEM certifikátu z openssl pkcs12 ---');

  const { certificatePem: cistyPem } = vytvoritTestovaciKlic();
  const cistyDer = new crypto.X509Certificate(cistyPem).raw; // nezávislé, holé DER

  // 1) PEM přesně v podobě, jakou produkuje `openssl pkcs12 -clcerts -nokeys`
  //    (metadata řádky PŘED BEGIN CERTIFICATE) — reálný scénář, který
  //    způsobil chybu 4 na Playgroundu.
  {
    const pemSBagAttributes =
      'Bag Attributes\n' +
      '    localKeyID: AF BD C4 30 1B EC F7 19 6F 61 09 F1 63 40 4F 99 21 88 15 56 \n' +
      'subject=description=pravnicka osoba, CN=CZ00000019, C=CZ\n' +
      'issuer=CN=playground EETv2 NCA SubCA RSA 05/2026, O=Správa, C=CZ\n' +
      cistyPem;

    const base64Der = pemNaBase64Der(pemSBagAttributes);
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(base64Der), 'výsledek musí být čistý base64 (bez zbytků metadat typu ":"/",")');

    const dekodovanyDer = Buffer.from(base64Der, 'base64');
    assert.ok(dekodovanyDer.equals(cistyDer), 'base64 DER z PEM s "Bag Attributes" musí být bajtově identický s čistým certifikátem');

    // Nezávislá kontrola přes OpenSSL (ne náš vlastní kód) — potvrdí, že jde
    // o platně dekódovatelný X.509 certifikát, ne jen o "nějaký base64".
    const der = execFileSync('openssl', ['x509', '-inform', 'DER', '-noout', '-subject'], {
      input: dekodovanyDer
    });
    assert.ok(der.toString().includes('subject='), 'OpenSSL musí nezávisle rozpoznat výsledek jako platný X.509 certifikát');
    console.log('OK — 1) PEM s "Bag Attributes" (jak jej produkuje openssl pkcs12) se správně očistí');
  }

  // 2) Čistý PEM (bez metadat) musí dál fungovat úplně stejně jako dřív.
  {
    const base64Der = pemNaBase64Der(cistyPem);
    assert.ok(Buffer.from(base64Der, 'base64').equals(cistyDer), 'čistý PEM musí dát stejný výsledek jako dřív');
    console.log('OK — 2) čistý PEM (bez metadat) se chová nezměněně');
  }

  // 3) Vstup bez PEM bloku vůbec musí vyhodit jasnou chybu, ne vrátit ticho
  //    nesmyslný base64 řetězec.
  {
    assert.throws(
      () => pemNaBase64Der('Bag Attributes\nsubject=CN=x\n(tady žádný certifikát není)'),
      /platný PEM blok/,
      'vstup bez BEGIN/END CERTIFICATE musí vyhodit chybu'
    );
    console.log('OK — 3) vstup bez PEM bloku vyhodí jasnou chybu');
  }

  console.log('\n✅ VŠECHNY REGRESNÍ TESTY PRO OPRAVU "BAG ATTRIBUTES" PROŠLY');
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
