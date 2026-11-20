// Strojově čitelná kopie MANIFEST.md (eet_specifikace/MANIFEST.md) — verze,
// data a kontrolní součty oficiálních podkladů EET 2.0, které používá
// xml-zprava.js a xsd-validace.js. Udržovat společně s tím manifestem.
const path = require('path');

const ADRESAR = path.join(__dirname, '..', 'eet_specifikace');

const PODKLADY = {
  xsd: {
    soubor: path.join(ADRESAR, 'EETXMLSchema.xsd'),
    verzeRozhrani: '4.1',
    sha256: '83597d08520cbfab7e51145df9a765d5ca22e2f9a38644a468d695657c7a032a'
  },
  wsdl: {
    soubor: path.join(ADRESAR, 'EETServiceSOAP.wsdl'),
    verzeRozhrani: '4.1',
    sha256: 'df149c0bef4ac18c2a6e82116b6eb9bb17d29c055cb0821ac6d3885ec90faeb4'
  },
  popisRozhrani: {
    soubor: path.join(ADRESAR, 'EET_popis_rozhrani_v1.2.pdf'),
    verze: '1.2',
    datum: '2026-08-25',
    sha256: 'c986e85686927e1e153aee0f33090fd6fda80d09b44e564d8b344dde729b1a1e'
  },
  popisPolozek: {
    soubor: path.join(ADRESAR, 'EET_popis_polozek_datove_zpravy.pdf'),
    verze: '1.0',
    datum: '2026-10-05',
    sha256: 'de09d084688e871c639b2813ed30ba77e838667f16ec94604b6a3f4df2c3576f'
  },
  playground: {
    soubor: path.join(ADRESAR, 'EET_pristupove_provozni_informace_playground_1_2.pdf'),
    verze: '1.2',
    datum: '2026-11-11',
    url: 'https://pg.trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4',
    sha256: '2a5deacd6440a6550f0719c595f3638b3a8f7044c741578b84da2e9a42708f3e'
  },
  produkce: {
    soubor: path.join(ADRESAR, 'EET_pristupove_provozni_informace_produkce_v1_2.pdf'),
    verze: '1.2',
    datum: '2026-11-11',
    url: 'https://trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4',
    sha256: '41c0b5e27770acdc355d5454d6ba9348cc4a3e32646f689d94d57d7a6e1aae99'
  },
  playgroundCaRoot: {
    soubor: path.join(ADRESAR, 'ca_eet-root_cert-playground.crt'),
    sha256: 'c0257db7f2d9dde3f9413e904814a330cbd2efa41f2ab4ecd8f91f7c5f73f3b6'
  },
  playgroundCaSub: {
    soubor: path.join(ADRESAR, 'ca_eet-sub_cert-playground.crt'),
    sha256: '28182077cb77338070e209fe9e950481d01ecbc181dfc76ecd7985bd2e0f9046'
  },
  vzorovaZpravaCZ00000019: {
    soubor: path.join(ADRESAR, 'CZ00000019.eet.v4.req.xml'),
    sha256: '4392b4ca0e6eb586c10b6f80d8946f5269f500a5b2b0d94fa7a092ace867ade5'
  },
  vzorovaZpravaCZ683555118: {
    soubor: path.join(ADRESAR, 'CZ683555118.eet.v4.req.xml'),
    sha256: 'a77d28641603ffd85a3bd9eff580f554e5e822741cd0594d84b48b52e7874b75'
  },
  vzorovaZpravaCZ8551015704: {
    soubor: path.join(ADRESAR, 'CZ8551015704.eet.v4.req.xml'),
    sha256: 'a61b6ac6cc50b908d68550aa4981b91df0f5d3cbfe564b5d60b545ef70a06bd6'
  },
  // Krok 3d, příprava nasazení — CA, která vydává NÁŠ produkční pokladní
  // certifikát (čím bychom podepisovali VLASTNÍ odchozí zprávy). NENÍ totéž
  // jako "icaRoot"/"icaPublicCa" níž — viz MANIFEST.md.
  eetCaRootProd: {
    soubor: path.join(ADRESAR, 'ca_eet-root_prod.pem'),
    sha256: '462afa5e88c894ec414690baef1440419478b31c8524d5de5237a20ce305ec8b'
  },
  eetCaSubProd: {
    soubor: path.join(ADRESAR, 'ca_eet-sub_prod.pem'),
    sha256: 'fd0ae27da503f70c99b85affe3c85640cfbc8569b39aef15252c415c30215800'
  },
  // CA, kterou Finanční správa podepisuje SVOJI odpověď (potvrzení/chybu) —
  // čím ověřujeme PŘÍCHOZÍ zprávu (eet/overeni-odpovedi-fs.js). Zdroj:
  // EET_pristupove_provozni_informace_Produk-4.pdf, kap. 3.3 "Podpisový
  // certifikát" + https://www.ica.cz/korenove-certifikaty (ne eet.gov.cz —
  // jiná, samostatná certifikační autorita, NIKDY nezaměnit s eetCaRootProd/
  // eetCaSubProd výš).
  icaRootCa: {
    soubor: path.join(ADRESAR, 'ca_ica-root-ca-rsa-05-2022.pem'),
    sha256: 'f72dc3232df2c9598f60c1bbc82f4bcc5acc80af73a60ed6eb3f6bd67ab473e2'
  },
  icaPublicCa: {
    soubor: path.join(ADRESAR, 'ca_ica-public-ca-rsa-06-2022.pem'),
    sha256: 'db03fb10906d8cc357ef2d68f2f130d6a5381de3ca9a8cbf45216350ca695116'
  }
};

// Jmenný prostor XML schématu (EETXMLSchema.xsd, atribut targetNamespace).
const NAMESPACE_TRZBA = 'http://fs.gov.cz/eet/schema/v4';
const SOAP_ACTION = 'http://fs.gov.cz/eet/OdeslaniTrzby';

// Oficiální vzorová EIČ z technické specifikace (kap. 3.3.3.5) — používají se
// VÝHRADNĚ v testech a na Playgroundu, nikdy jako skutečné EIČ poplatníka.
const TESTOVACI_EIC = {
  fyzickaOsoba: 'CZ8551015704',
  pravnickaOsoba: 'CZ00000019',
  vcp: 'CZ683555118'
};

module.exports = { PODKLADY, NAMESPACE_TRZBA, SOAP_ACTION, TESTOVACI_EIC };
