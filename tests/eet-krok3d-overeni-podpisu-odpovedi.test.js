// Krok 3d, bod 7 — kryptografické ověření ODPOVĚDI Finanční správy proti
// důvěryhodné certifikační kotvě (ne jen XML syntaktická kontrola).
// Spuštění:  node tests/eet-krok3d-overeni-podpisu-odpovedi.test.js
const assert = require('node:assert/strict');
const { sestavitXmlTrzby } = require('../eet/xml-zprava');
const { sestavitNepodepsanouObalku } = require('../eet/soap-obalka');
const { podepsatObalku, vytvoritTestovaciKlic } = require('../eet/podpis');
const { REZIM, odeslatZpravu } = require('../eet/playground-klient');
const { overitPodpisAKotvuOdpovedi, overitPlatnostKotvy } = require('../eet/overeni-odpovedi-fs');
const { TESTOVACI_EIC } = require('../eet/specifikace');
const { spustitMockEetServer } = require('./helpers/mock-eet-server');
const { vytvoritTestovaciCaARetezec } = require('./helpers/testovaci-ca');

async function odeslatAZiskatOdpoved(mock) {
  const klicOdesilatele = vytvoritTestovaciKlic();
  const { xml } = sestavitXmlTrzby(
    { id_jednotky: '24', id_pokl: 'POKLADNA 1', porad_cis: `ET-${Date.now()}`, dat_trzby: new Date(), celk_trzba: '100.00' },
    { eicPopl: TESTOVACI_EIC.pravnickaOsoba },
    { prvniZaslani: true }
  );
  const nepodepsana = sestavitNepodepsanouObalku(xml, { certificatePem: klicOdesilatele.certificatePem });
  const podepsana = podepsatObalku(nepodepsana, { privateKeyPem: klicOdesilatele.privateKeyPem, certificatePem: klicOdesilatele.certificatePem });
  const { telo } = await odeslatZpravu(podepsana, { rezim: REZIM.LOCAL_MOCK, mockUrl: mock.url });
  return telo;
}

async function main() {
  console.log('--- Krok 3d: ověření podpisu odpovědi proti důvěryhodné kotvě ---');

  const ca1 = vytvoritTestovaciCaARetezec({ cnRoot: 'TEST Root CA 1' });
  const ca2 = vytvoritTestovaciCaARetezec({ cnRoot: 'TEST Root CA 2 (jiná, nedůvěryhodná pro náš test)' });

  // 1) Odpověď podepsaná leaf certifikátem vydaným DŮVĚRYHODNOU kotvou →
  //    musí být uznána jako důvěryhodná.
  {
    const mock = await spustitMockEetServer({ podepisovatOdpovedi: { certificatePem: ca1.leafCertificatePem, privateKeyPem: ca1.leafPrivateKeyPem } });
    try {
      const odpovedXml = await odeslatAZiskatOdpoved(mock);
      const vysledek = overitPodpisAKotvuOdpovedi(odpovedXml, { duveryhodneKotvyPem: [ca1.kotvaPem] });
      assert.equal(vysledek.duveryhodny, true, `měla být důvěryhodná: ${vysledek.poznamka}`);
      console.log('OK 1 — odpověď podepsaná leaf certifikátem vydaným správnou kotvou je uznána jako důvěryhodná');
    } finally {
      await mock.zastavit();
    }
  }

  // 2) Stejně platně podepsaná odpověď, ale leaf vydaný JINOU CA, než je v
  //    seznamu důvěryhodných kotev → NESMÍ být uznána (podpis je matematicky
  //    platný vůči svému vlastnímu certifikátu, ale ten certifikát sám
  //    nevede k žádné důvěryhodné kotvě).
  {
    const mock = await spustitMockEetServer({ podepisovatOdpovedi: { certificatePem: ca2.leafCertificatePem, privateKeyPem: ca2.leafPrivateKeyPem } });
    try {
      const odpovedXml = await odeslatAZiskatOdpoved(mock);
      const vysledek = overitPodpisAKotvuOdpovedi(odpovedXml, { duveryhodneKotvyPem: [ca1.kotvaPem] });
      assert.equal(vysledek.duveryhodny, false, 'odpověď podepsaná jinou (nedůvěryhodnou) CA nesmí být uznána');
      assert.ok(vysledek.poznamka.includes('kotvě'));
      console.log('OK 2 — odpověď podepsaná jinou (nedůvěryhodnou) CA je správně ODMÍTNUTA');
    } finally {
      await mock.zastavit();
    }
  }

  // 3) Odpověď VŮBEC nepodepsaná (dosavadní výchozí chování mocku, i
  //    reálná situace např. při útoku/chybě na síti) → nesmí být uznána jako
  //    důvěryhodná, i kdyby XML samo tvrdilo "potvrzeni" s platným POK.
  {
    const mock = await spustitMockEetServer(); // beze změny — bez podpisu
    try {
      const odpovedXml = await odeslatAZiskatOdpoved(mock);
      assert.ok(odpovedXml.includes('<tns:Potvrzeni'), 'sanity: mock skutečně vrátil POK');
      const vysledek = overitPodpisAKotvuOdpovedi(odpovedXml, { duveryhodneKotvyPem: [ca1.kotvaPem] });
      assert.equal(vysledek.duveryhodny, false, 'nepodepsaná odpověď nesmí být uznána, i když má platný POK');
      console.log('OK 3 — nepodepsaná odpověď (i s platným POK) je odmítnuta jako nedůvěryhodná');
    } finally {
      await mock.zastavit();
    }
  }

  // 4) Pozměněná (zfalšovaná) odpověď PO podpisu → podpis se vůbec neověří.
  {
    const mock = await spustitMockEetServer({ podepisovatOdpovedi: { certificatePem: ca1.leafCertificatePem, privateKeyPem: ca1.leafPrivateKeyPem } });
    try {
      const odpovedXml = await odeslatAZiskatOdpoved(mock);
      const pozmenena = odpovedXml.replace(/pok="[^"]+"/, 'pok="UTOCNIKOVO-FALESNE-POK-ff"');
      const vysledek = overitPodpisAKotvuOdpovedi(pozmenena, { duveryhodneKotvyPem: [ca1.kotvaPem] });
      assert.equal(vysledek.duveryhodny, false, 'pozměněná odpověď po podpisu nesmí projít');
      console.log('OK 4 — pozměněná (zfalšovaná) odpověď po podpisu je odmítnuta');
    } finally {
      await mock.zastavit();
    }
  }

  // 5) Žádná dodaná kotva → jasné odmítnutí, ne tichý průchod.
  {
    const vysledek = overitPodpisAKotvuOdpovedi('<soapenv:Envelope/>', { duveryhodneKotvyPem: [] });
    assert.equal(vysledek.duveryhodny, false);
    console.log('OK 5 — bez dodané důvěryhodné kotvy je ověření vždy odmítnuto');
  }

  // 6) Zadání, bod 9: NIKDY nezaměnit veřejný CA certifikát za soukromý
  //    podpisový klíč — pokud by se omylem jako "kotva" dostal soukromý
  //    klíč, musí to být výslovně rozpoznáno a odmítnuto.
  {
    const kontrola = overitPlatnostKotvy(ca1.leafPrivateKeyPem);
    assert.equal(kontrola.ok, false);
    assert.ok(kontrola.duvod.toLowerCase().includes('soukrom'), `musí jasně pojmenovat, že jde o soukromý klíč: ${kontrola.duvod}`);
    console.log('OK 6 — soukromý klíč nasazený jako "kotva" je výslovně rozpoznán a odmítnut (nikdy zaměněn za CA certifikát)');
  }

  // 7) Certifikát, který NENÍ certifikační autoritou (CA:true), nemůže
  //    sloužit jako důvěryhodná kotva, i kdyby byl jinak platný X.509 —
  //    použijeme leaf (koncový) certifikát odesílatele, který CA není.
  {
    const kontrola = overitPlatnostKotvy(ca1.leafCertificatePem);
    assert.equal(kontrola.ok, false);
    assert.ok(kontrola.duvod.includes('CA:true'), `musí jasně pojmenovat chybějící CA:true: ${kontrola.duvod}`);
    console.log('OK 7 — certifikát bez CA:true (koncový, ne certifikační autorita) je jako kotva odmítnut');
  }

  // 8) Platnost certifikátu ODPOVĚDI (notBefore/notAfter) — matematicky
  //    platný podpis s PROŠLÝM certifikátem se nesmí uznat.
  {
    const proslaCa = vytvoritTestovaciCaARetezec({ cnRoot: 'TEST Root CA — prošlý leaf', leafNotAfter: new Date(Date.now() - 24 * 3600 * 1000) }); // platnost skončila včera
    const mock = await spustitMockEetServer({ podepisovatOdpovedi: { certificatePem: proslaCa.leafCertificatePem, privateKeyPem: proslaCa.leafPrivateKeyPem } });
    try {
      const odpovedXml = await odeslatAZiskatOdpoved(mock);
      const vysledek = overitPodpisAKotvuOdpovedi(odpovedXml, { duveryhodneKotvyPem: [proslaCa.kotvaPem] });
      assert.equal(vysledek.duveryhodny, false, 'odpověď podepsaná PROŠLÝM certifikátem nesmí být uznána');
      assert.ok(vysledek.poznamka.includes('platnosti'), vysledek.poznamka);
      console.log('OK 8 — odpověď podepsaná certifikátem po konci platnosti je odmítnuta, i když je podpis matematicky platný');
    } finally {
      await mock.zastavit();
    }
  }

  console.log('\n✅ VŠECHNY TESTY OVĚŘENÍ PODPISU ODPOVĚDI PROŠLY');
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
