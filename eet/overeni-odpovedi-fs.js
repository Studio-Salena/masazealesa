// Krok 3d — kryptografické ověření ODPOVĚDI od Finanční správy (ne naší
// odchozí zprávy, to řešil Krok 3c/eet/podpis.js). Dosavadní kód (parser +
// mock server) kontroloval jen to, že odpověď je syntakticky platné XML se
// správnou strukturou <Odpoved>/<Potvrzeni>/<Chyba> — NIKDY neověřoval, že
// ji skutečně podepsala Finanční správa. To je mezera: útočník (nebo chyba
// na síti/proxy) by mohl vrátit falešné "potvrzeni" s věrohodně vyhlížejícím
// POK a appka by to bez tohoto modulu tiše uznala.
//
// Dvě NEZÁVISLÉ kontroly, obě musí projít:
//   1) XML-DSig podpis odpovědi je platný proti certifikátu, který je v ní
//      vlastní vložený (BinarySecurityToken) — ZNOVUŽITÍ eet/podpis.js
//      (overitPodpisObalky), stejná funkce, co ověřuje i naše odchozí
//      zprávy (žádný druhý, duplicitní ověřovací mechanismus).
//   2) Tenhle certifikát je vydaný (přímo) některou z DŮVĚRYHODNÝCH KOTEV
//      (trusted root), které volající výslovně dodá — NIKDY žádná vestavěná
//      konstanta v tomhle modulu. V produkci by to byl kořen skutečné
//      certifikační autority Finanční správy (I.CA Public CA) — jeho
//      bezpečné stažení/ověření a zapojení je VÝSLOVNĚ VYNECHANÉ z tohoto
//      kroku (jen lokální TEST), proto tahle funkce nikdy sama žádnou kotvu
//      nenačítá, jen přijímá to, co dostane.
//
// Bez OBOU kontrol se odpověď nesmí nikdy považovat za důvěryhodné potvrzení
// evidenční povinnosti — i syntakticky "úspěšná" odpověď (POK, test=true)
// se zapisuje jen jako nejistá, dokud podpis+kotva neprojdou (viz
// eet/odesilaci-sluzba.js).
const crypto = require('crypto');
const { extrahovatBstBase64Der, base64DerNaPem } = require('./soap-obalka');
const { overitPodpisObalky } = require('./podpis');

// Je "leaf" (koncový certifikát) vydaný a podepsaný přímo některou z
// "kotvyPem" (root certifikáty, PEM)? Jen JEDNOÚROVŇOVÉ ověření (leaf →
// přímo root, bez prostředních CA) — pro skutečnou produkční certifikační
// cestu FS (root → sub CA → podpisový cert) by se stejným způsobem
// procházel celý řetězec; tady stačí jedna úroveň, protože lokální TEST
// kotva/leaf dvojice (viz tests/helpers/testovaci-ca.js) je právě tak
// hluboká a mechanismus je identický pro libovolnou délku řetězce.
function vydanoDuveryhodnouKotvou(leafCert, kotvyPem) {
  for (const kotvaPem of kotvyPem) {
    let kotva;
    try {
      kotva = new crypto.X509Certificate(kotvaPem);
    } catch {
      continue;
    }
    try {
      if (leafCert.checkIssued(kotva) && leafCert.verify(kotva.publicKey)) {
        return { ano: true, kotvaSubjekt: kotva.subject };
      }
    } catch {
      // leafCert.verify() vyhazuje, pokud algoritmus/klíč nesedí — to je
      // prostě "ne, tahle kotva to nevydala", ne chyba funkce.
    }
  }
  return { ano: false, kotvaSubjekt: null };
}

// Vrací { duveryhodny: boolean, poznamka: string, certifikatSubjekt: string|null }.
// "duveryhodny: false" NENÍ totéž jako "síťová chyba" — je to jasný,
// zaznamenatelný závěr "tuhle odpověď nelze ověřit jako skutečně od FS".
function overitPodpisAKotvuOdpovedi(soapXmlOdpovedi, { duveryhodneKotvyPem } = {}) {
  if (!Array.isArray(duveryhodneKotvyPem) || duveryhodneKotvyPem.length === 0) {
    return { duveryhodny: false, poznamka: 'Nebyla dodána žádná důvěryhodná kotva (duveryhodneKotvyPem) — bez ní nelze podpis odpovědi ověřit.', certifikatSubjekt: null };
  }

  const bstBase64 = extrahovatBstBase64Der(soapXmlOdpovedi);
  if (!bstBase64) {
    return { duveryhodny: false, poznamka: 'Odpověď neobsahuje žádný BinarySecurityToken (není podepsaná, nebo v jiném formátu) — nelze ověřit, kdo ji vystavil.', certifikatSubjekt: null };
  }

  const certificatePem = base64DerNaPem(bstBase64);
  let leaf;
  try {
    leaf = new crypto.X509Certificate(certificatePem);
  } catch (e) {
    return { duveryhodny: false, poznamka: `Certifikát v odpovědi není platný X.509: ${e.message}`, certifikatSubjekt: null };
  }

  const overeniPodpisu = overitPodpisObalky(soapXmlOdpovedi, { certificatePem });
  if (!overeniPodpisu.valid) {
    return { duveryhodny: false, poznamka: `XML-DSig podpis odpovědi je neplatný: ${overeniPodpisu.duvod}`, certifikatSubjekt: leaf.subject };
  }

  const kotva = vydanoDuveryhodnouKotvou(leaf, duveryhodneKotvyPem);
  if (!kotva.ano) {
    return { duveryhodny: false, poznamka: `Podpis je matematicky platný, ale certifikát ("${leaf.subject}") nevede k žádné důvěryhodné kotvě.`, certifikatSubjekt: leaf.subject };
  }

  return { duveryhodny: true, poznamka: `Podpis platný, certifikát vydán důvěryhodnou kotvou "${kotva.kotvaSubjekt}".`, certifikatSubjekt: leaf.subject };
}

module.exports = { overitPodpisAKotvuOdpovedi };
