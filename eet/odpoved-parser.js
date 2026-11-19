// Rozbor odpovědi systému EET (potvrzovací nebo chybová datová zpráva,
// element <tns:Odpoved>) — dle EET_popis_rozhrani_v1.2.pdf, kap. 3.4/3.5.
// Čistě lokální parsování textu, žádné síťové volání.
const { DOMParser } = require('@xmldom/xmldom');
const xpath = require('xpath');

class EetOdpovedChyba extends Error {}

function textElementu(doc, xp) {
  const uzel = xpath.select1(xp, doc);
  return uzel ? uzel.textContent.trim() : null;
}

function atribut(uzel, jmeno) {
  if (!uzel) return null;
  const a = uzel.getAttribute ? uzel.getAttribute(jmeno) : null;
  return a === '' ? null : a;
}

// Vrací { typ: 'potvrzeni'|'chyba', uuidZpravy, test, varovani: [{kod,text}], ...}
// "test: true" VŽDY znamená neprodukční prostředí (Playground) — POK/chyba
// vrácená s test=true NENÍ platným splněním evidenční povinnosti (spec,
// kap. 2.2.2). Tahle appka v tomto kroku nic neodesílá, ale parser musí tuhle
// informaci zachovat přesně, protože na ní bude stát rozlišení v Kroku 3d.
function rozebratOdpoved(xmlText) {
  let doc;
  const chybyParsovani = [];
  try {
    doc = new DOMParser({
      onError: (level, msg) => { if (level === 'error' || level === 'fatalError') chybyParsovani.push(msg); }
    }).parseFromString(xmlText, 'text/xml');
  } catch (e) {
    throw new EetOdpovedChyba(`Odpověď není platné XML: ${e.message}`);
  }
  if (chybyParsovani.length > 0) {
    throw new EetOdpovedChyba(`Odpověď není platné XML: ${chybyParsovani.join('; ')}`);
  }

  const hlavicka = xpath.select1("//*[local-name(.)='Hlavicka']", doc);
  const potvrzeni = xpath.select1("//*[local-name(.)='Potvrzeni']", doc);
  const chyba = xpath.select1("//*[local-name(.)='Chyba']", doc);
  const varovaniUzly = xpath.select("//*[local-name(.)='Varovani']", doc);
  const varovani = varovaniUzly.map((u) => ({
    kod: Number(atribut(u, 'kod_varov')),
    text: u.textContent.trim()
  }));

  if (!hlavicka || (!potvrzeni && !chyba)) {
    throw new EetOdpovedChyba('Odpověď neobsahuje rozpoznatelnou strukturu <Odpoved> (ani Potvrzeni, ani Chyba).');
  }

  const uuidZpravy = atribut(hlavicka, 'uuid_zpravy');

  if (potvrzeni) {
    return {
      typ: 'potvrzeni',
      uuidZpravy,
      datPrij: atribut(hlavicka, 'dat_prij'),
      pok: atribut(potvrzeni, 'pok'),
      test: atribut(potvrzeni, 'test') === 'true',
      varovani
    };
  }
  return {
    typ: 'chyba',
    uuidZpravy,
    datOdmit: atribut(hlavicka, 'dat_odmit'),
    kod: Number(atribut(chyba, 'kod')),
    text: chyba.textContent.trim(),
    test: atribut(chyba, 'test') === 'true',
    varovani
  };
}

module.exports = { EetOdpovedChyba, rozebratOdpoved };
