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

// Nezávislá validace OČEKÁVANÉ odpovědi na ověřovací (overeni=false,
// playground) zprávu — Krok 3d. Používá se PŘED skutečným odesláním (aby šlo
// připravit a jednotkově otestovat, co se bude kontrolovat) i PO něm (na
// skutečnou odpověď). Kontroluje přesně to, co po úspěchu vyžaduje
// specifikace (kap. 2.2.1/2.2.2) a popis položek (POK na playgroundu končí
// "-ff"): typ odpovědi, test=true, správné přiřazení k odeslané zprávě
// (shoda uuid_zpravy) a tvar POK.
function overitOverovaciOdpoved(odpoved, { uuidZpravyOdeslane } = {}) {
  const duvody = [];
  if (!odpoved || typeof odpoved !== 'object') {
    return { ok: false, duvody: ['Odpověď chybí nebo nemá očekávaný tvar.'] };
  }
  if (odpoved.typ !== 'potvrzeni') {
    duvody.push(`Očekávána potvrzovací zpráva (POK), dostali jsme typ "${odpoved.typ}"${odpoved.text ? ` (${odpoved.text})` : ''}.`);
  }
  if (odpoved.test !== true) {
    duvody.push('Odpověď nemá test=true — to je u Playgroundu VŽDY povinné; bez toho nejde výsledku věřit jako testovacímu.');
  }
  if (!uuidZpravyOdeslane) {
    duvody.push('Chybí uuid_zpravy odeslané zprávy — nelze ověřit přiřazení odpovědi.');
  } else if (odpoved.uuidZpravy !== uuidZpravyOdeslane) {
    duvody.push(`uuid_zpravy odpovědi ("${odpoved.uuidZpravy}") neodpovídá odeslané zprávě ("${uuidZpravyOdeslane}") — odpověď nelze bezpečně přiřadit.`);
  }
  if (odpoved.typ === 'potvrzeni') {
    if (!odpoved.pok || typeof odpoved.pok !== 'string') {
      duvody.push('Potvrzovací zpráva neobsahuje POK.');
    } else if (!odpoved.pok.endsWith('-ff')) {
      duvody.push(`POK z neprodukčního prostředí musí končit "-ff" (EET_popis_polozek_datove_zpravy.pdf), dostali jsme: "${odpoved.pok}".`);
    }
  }
  return { ok: duvody.length === 0, duvody };
}

module.exports = { EetOdpovedChyba, rozebratOdpoved, overitOverovaciOdpoved };
