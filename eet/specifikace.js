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
