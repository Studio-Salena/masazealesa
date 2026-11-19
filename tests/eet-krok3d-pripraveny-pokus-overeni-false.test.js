// Krok 3d — PŘIPRAVENÝ (ne spuštěný) test druhého typu ověřovacího pokusu
// na oficiální Playground, s overeni="false" (produkuje POK, ne jen
// ověřovací "chybu kód 0" — dle specifikace kap. 2.2.1/2.2.2). POK z
// neprodukčního prostředí končí "-ff" (EET_popis_polozek_datove_zpravy.pdf).
//
// id_jednotky="303": NENÍ odhadnuté. Je to hodnota z OFICIÁLNÍHO vzorového
// podepsaného požadavku Finanční správy pro přesně tuto testovací EIČ
// (eet_specifikace/CZ00000019.eet.v4.req.xml, staženo z eet.gov.cz,
// checksum v MANIFEST.md) — a odpovídá i obecné masce/konvenci z
// EET_popis_rozhrani_v1.2.pdf, kap. 3.3.3.8 ("číslo má obvykle alespoň 2
// dekadická místa a poslední číslici 1,2,3 nebo 4" — "303" splňuje obojí).
// Předchozí pokus s id_jednotky="1" vyvolal jen VAROVÁNÍ (kód 6, formát),
// ne chybu — "303" by tohle varování už neměl vyvolat.
//
// BEZPEČNOSTNÍ ZÁMEK: stejný vzor jako
// eet-krok3d-pripraveny-overovaci-pokus.test.js. Dokud není v prostředí
// EET_SCHVALENO_DRUHE_ODESLANI=true (a cesty ke cert/klíči), skript jen
// vypíše a LOKÁLNĚ ověří, co by odeslal, a skončí úspěchem (exit 0) BEZ
// JAKÉHOKOLI síťového volání.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { sestavitXmlTrzby } = require('../eet/xml-zprava');
const { validovatProtiXsd } = require('../eet/xsd-validace');
const { sestavitNepodepsanouObalku, extrahovatTrzbu, extrahovatBstBase64Der } = require('../eet/soap-obalka');
const { podepsatObalku, overitPodpisObalky } = require('../eet/podpis');
const { rozebratOdpoved, overitOverovaciOdpoved } = require('../eet/odpoved-parser');
const { REZIM, odeslatZpravu, ADRESA_PRODUKCE } = require('../eet/playground-klient');
const { TESTOVACI_EIC } = require('../eet/specifikace');
const crypto = require('node:crypto');

const SCHVALENO = process.env.EET_SCHVALENO_DRUHE_ODESLANI === 'true';

async function main() {
  console.log('--- Krok 3d: připravený pokus na oficiální Playground (overeni=false) ---');

  const trzba = {
    id_jednotky: '303', // z oficiálního vzoru FS pro CZ00000019 — ne odhad
    id_pokl: 'TEST-OVERENI-FALSE-1',
    porad_cis: `OF-${Date.now()}`,
    dat_trzby: new Date(),
    celk_trzba: '1.00'
  };
  const cfg = { eicPopl: TESTOVACI_EIC.pravnickaOsoba };

  // 1) Trzba musí být validní proti XSD ještě PŘED podpisem.
  const { xml, hlavicka } = sestavitXmlTrzby(trzba, cfg, { prvniZaslani: true, overeni: false });
  const xsd1 = await validovatProtiXsd(xml);
  assert.equal(xsd1.valid, true, `Trzba XML neprošla XSD validací: ${JSON.stringify(xsd1.errors)}`);
  assert.ok(!hlavicka.overeni, 'tento pokus musí mít overeni=false (atribut se nesmí v XML vůbec objevit)');
  assert.ok(!xml.includes('overeni='), 'XML nesmí obsahovat atribut overeni (false se dle XSD jen vynechává)');
  console.log('OK 1/7 — Trzba (overeni=false, id_jednotky="303") je XSD validní');

  // 2) Cílová adresa nikdy nesmí být produkční endpoint — statická kontrola.
  assert.notEqual(ADRESA_PRODUKCE, undefined);
  assert.ok(ADRESA_PRODUKCE.includes('trzbyeet.gov.cz') && !ADRESA_PRODUKCE.includes('pg.'), 'ADRESA_PRODUKCE musí být skutečně produkční, ne playground');
  console.log('OK 2/7 — produkční endpoint je rozpoznaný a oddělený od Playgroundu (statická kontrola)');

  if (!SCHVALENO) {
    console.log('EET_SCHVALENO_DRUHE_ODESLANI není nastaveno na "true" — zpráva se PŘIPRAVÍ a LOKÁLNĚ ověří, ale NEODESÍLÁ.');

    // I v "suchém" režimu potřebujeme certifikát/klíč jen pro lokální
    // přípravu podpisu — volající je musí dodat stejně jako při ostrém
    // odeslání (žádný pevně zapsaný/produkční certifikát v kódu).
    const certPath = process.env.EET_PLAYGROUND_CERT_PEM;
    const keyPath = process.env.EET_PLAYGROUND_KEY_PEM;
    if (!certPath || !keyPath) {
      console.log('(Bez EET_PLAYGROUND_CERT_PEM/EET_PLAYGROUND_KEY_PEM nelze lokálně ověřit podpis — jen XML/adresová kontrola proběhla.)');
      console.log(`Byla by odeslána tato syntetická tržba (overeni=false): ${JSON.stringify(trzba)}`);
      console.log('\n✅ TEST PŘIPRAVEN (neprovedeno — čeká na výslovné schválení)');
      return;
    }

    const certificatePem = fs.readFileSync(certPath, 'utf8');
    const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
    const nepodepsana = sestavitNepodepsanouObalku(xml, { certificatePem });
    const podepsana = podepsatObalku(nepodepsana, { privateKeyPem, certificatePem });

    // 3) Trzba z podepsané obálky zůstává XSD validní a nezměněná.
    const vytazenaXml = extrahovatTrzbu(podepsana);
    const xsd2 = await validovatProtiXsd(vytazenaXml);
    assert.equal(xsd2.valid, true, `Trzba z podepsané obálky neprošla XSD: ${JSON.stringify(xsd2.errors)}`);
    console.log('OK 3/7 — Trzba z podepsané obálky zůstává XSD validní');

    // 4) BinarySecurityToken obsahuje platný DER certifikát, bajtově shodný
    //    se skutečným certifikátem (stejná kontrola jako před 2. pokusem).
    const bstBase64 = extrahovatBstBase64Der(podepsana);
    assert.ok(bstBase64, 'BinarySecurityToken musí být přítomen');
    const bstDer = Buffer.from(bstBase64, 'base64');
    const cistyDer = new crypto.X509Certificate(certificatePem).raw;
    assert.ok(bstDer.equals(cistyDer), 'BST certifikát musí být bajtově identický se skutečným certifikátem');
    console.log('OK 4/7 — BinarySecurityToken obsahuje platný, bajtově shodný DER certifikát');

    // 5) DigestValue/SignatureValue platné (round-trip ověření).
    const overeniPodpisu = overitPodpisObalky(podepsana, { certificatePem });
    assert.equal(overeniPodpisu.valid, true, `Podpis se musí ověřit jako platný: ${overeniPodpisu.duvod}`);
    console.log('OK 5/7 — DigestValue i SignatureValue jsou platné');

    // 6) Nezávislá validace OČEKÁVANÉ odpovědi — na simulovaném úspěšném i
    //    neúspěšném vzoru, aby šlo ověřit SAMOTNOU kontrolní logiku dřív,
    //    než přijde skutečná odpověď.
    const ocekavanaUspesna = rozebratOdpoved(
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:eet="http://fs.gov.cz/eet/schema/v4">` +
      `<soapenv:Body><eet:Odpoved><eet:Hlavicka uuid_zpravy="${hlavicka.uuid_zpravy}" dat_prij="2026-11-19T22:00:00+01:00"/>` +
      `<eet:Potvrzeni pok="b3a09b52-7c87-4014-a496-4c7a53cf9125-ff" test="true"/></eet:Odpoved></soapenv:Body></soapenv:Envelope>`
    );
    const vysledekOk = overitOverovaciOdpoved(ocekavanaUspesna, { uuidZpravyOdeslane: hlavicka.uuid_zpravy });
    assert.equal(vysledekOk.ok, true, `simulovaná SPRÁVNÁ odpověď musí projít validací: ${vysledekOk.duvody.join('; ')}`);
    console.log('OK 6/7 — nezávislá validace očekávané odpovědi správně PŘIJME validní simulovanou odpověď (test=true, POK -ff, shoda uuid_zpravy)');

    // 7) Tatáž validace musí správně ODMÍTNOUT odpověď, která nekoresponduje
    //    s odeslanou zprávou, nemá test=true, nebo nemá POK -ff.
    const chybnaKorelace = rozebratOdpoved(
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:eet="http://fs.gov.cz/eet/schema/v4">` +
      `<soapenv:Body><eet:Odpoved><eet:Hlavicka uuid_zpravy="00000000-0000-4000-8000-000000000000" dat_prij="2026-11-19T22:00:00+01:00"/>` +
      `<eet:Potvrzeni pok="jina-hodnota-xx" test="true"/></eet:Odpoved></soapenv:Body></soapenv:Envelope>`
    );
    const vysledekChybny = overitOverovaciOdpoved(chybnaKorelace, { uuidZpravyOdeslane: hlavicka.uuid_zpravy });
    assert.equal(vysledekChybny.ok, false, 'odpověď s cizím uuid_zpravy a bez "-ff" musí být odmítnuta');
    assert.ok(vysledekChybny.duvody.some((d) => d.includes('uuid_zpravy')), 'musí hlásit nesoulad uuid_zpravy');
    assert.ok(vysledekChybny.duvody.some((d) => d.includes('-ff')), 'musí hlásit chybný tvar POK');
    console.log('OK 7/7 — nezávislá validace správně ODMÍTNE neshodnou/neplatnou odpověď');

    fs.writeFileSync(require('path').join(require('os').tmpdir(), 'eet-k-odeslani-overeni-false.xml'), podepsana, 'utf8');
    console.log('\n✅ ZPRÁVA (overeni=false) PŘIPRAVENA A LOKÁLNĚ OVĚŘENA — NEODESLÁNO, čeká na výslovné schválení jediného odeslání.');
    return;
  }

  // Od tohoto místa dál (jen po schválení) by se poslal přesně 1 požadavek —
  // stejný vzor jako u prvního pokusu, žádné automatické opakování.
  const certPath = process.env.EET_PLAYGROUND_CERT_PEM;
  const keyPath = process.env.EET_PLAYGROUND_KEY_PEM;
  if (!certPath || !keyPath) {
    throw new Error('EET_SCHVALENO_DRUHE_ODESLANI=true vyžaduje i EET_PLAYGROUND_CERT_PEM a EET_PLAYGROUND_KEY_PEM.');
  }
  const certificatePem = fs.readFileSync(certPath, 'utf8');
  const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
  const nepodepsana = sestavitNepodepsanouObalku(xml, { certificatePem });
  const podepsana = podepsatObalku(nepodepsana, { privateKeyPem, certificatePem });

  console.log('Odesílám tržbu (overeni=false) na OFICIÁLNÍ Playground...');
  const { httpStatus, telo } = await odeslatZpravu(podepsana, { rezim: REZIM.OFFICIAL_PLAYGROUND, timeoutMs: 20000 });
  console.log('HTTP status:', httpStatus);
  console.log('Tělo odpovědi:', telo);
  const odpoved = rozebratOdpoved(telo);
  const vysledek = overitOverovaciOdpoved(odpoved, { uuidZpravyOdeslane: hlavicka.uuid_zpravy });
  console.log('Rozebraná odpověď:', odpoved, '\nVýsledek validace:', vysledek);
  assert.equal(vysledek.ok, true, `Odpověď neprošla validací: ${vysledek.duvody.join('; ')}`);
  console.log('\n✅ POKUS (overeni=false) ÚSPĚŠNÝ — POK vydán, odpovídá odeslané zprávě.');
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
