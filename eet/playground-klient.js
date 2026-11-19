// HTTP klient pro odeslání podepsané SOAP zprávy — Krok 3c, příprava na
// Playground. ŽÁDNÉ volání exportované z tohoto modulu nesmí být schopné
// zasáhnout produkční prostředí Finanční správy. Adresa Playgroundu je
// NAPEVNO zapsaná konstanta, kterou veřejné API tohoto modulu nedovoluje
// zvenčí přepsat na nic jiného.
//
// DŮLEŽITÉ: tento modul se v Kroku 3c NEVOLÁ produkčním kódem (server.js) a
// žádný jeho test ho nevolá proti reálné adrese — testy běží výhradně proti
// lokálnímu mock serveru (viz tests/helpers/mock-eet-server.js), který NENÍ
// Playground ani Finanční správa, jen napodobuje tvar odpovědí pro ofline
// test HTTP vrstvy samotné.
const { PODKLADY, SOAP_ACTION } = require('./specifikace');

const ADRESA_PLAYGROUND = PODKLADY.playground.url; // https://pg.trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4
// Produkční adresy (dle EET_pristupove_provozni_informace_produkce_v1_2.pdf)
// mají tvar bez "pg." subdomény na "trzbyeet.gov.cz" — tahle appka v tomhle
// kroku neznám PŘESNOU produkční URL (nestahovali jsme ten dokument, protože
// produkční odesílání vůbec nepřipravujeme), ale obecný vzor domény ANO.
// Použijeme ho jako POJISTKU: i kdyby se někde v budoucnu omylem dostala do
// "mockUrl" adresa na *.trzbyeet.gov.cz, která NENÍ přesně adresa
// Playgroundu, odmítneme ji stejně jako cokoli jiného mimo localhost.
const VZOR_DOMENY_FINANCNI_SPRAVY = /\.trzbyeet\.gov\.cz$/i;

class EetSitovaChyba extends Error {}
class EetTimeout extends EetSitovaChyba {
  constructor() { super('Žádná odpověď do stanoveného limitu (mezní doba odezvy) — výsledek odeslání je NEJISTÝ, ne chyba.'); }
}
class EetZakazanaAdresa extends Error {}

async function _provestSoapPost(adresa, signedSoapXml, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const odpoved = await fetch(adresa, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': SOAP_ACTION
      },
      body: signedSoapXml,
      signal: controller.signal
    });
    const telo = await odpoved.text();
    return { httpStatus: odpoved.status, telo };
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new EetTimeout();
    }
    throw new EetSitovaChyba(`Síťová chyba při odesílání: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// JEDINÁ veřejná funkce pro odeslání na Playground — adresa je napevno
// zapsaná konstanta, NIKDY parametr. Nelze ji zvenčí přesměrovat na
// produkční prostředí ani na nic jiného, protože o adrese vůbec nerozhoduje
// volající.
async function odeslatNaPlayground(signedSoapXml, { timeoutMs = 15000 } = {}) {
  return _provestSoapPost(ADRESA_PLAYGROUND, signedSoapXml, { timeoutMs });
}

// POUZE PRO LOKÁLNÍ TESTY bez síťového spojení s Finanční správou (Krok 3c,
// bod 9) — adresa MUSÍ být na localhost/127.0.0.1/::1, cokoli jiného
// (včetně libovolné adresy na *.trzbyeet.gov.cz, tedy i skutečného
// Playgroundu) je touto funkcí ZAKÁZÁNO. Testy proti Playgroundu samotnému
// se spustí teprve přes odeslatNaPlayground výš, až po výslovném schválení.
async function _odeslatNaLokalniMockServer(signedSoapXml, mockUrl, opts = {}) {
  let parsed;
  try {
    parsed = new URL(mockUrl);
  } catch {
    throw new EetZakazanaAdresa(`Neplatná URL pro mock server: ${mockUrl}`);
  }
  const povoleneHostname = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!povoleneHostname.has(parsed.hostname)) {
    throw new EetZakazanaAdresa(
      `Testovací funkce _odeslatNaLokalniMockServer smí cílit JEN na localhost/127.0.0.1/::1 — dostala "${parsed.hostname}". ` +
      `Pro Playground použijte odeslatNaPlayground().`
    );
  }
  if (VZOR_DOMENY_FINANCNI_SPRAVY.test(parsed.hostname)) {
    // Nedosažitelné (localhost nikdy neodpovídá téhle masce), ale pojistka
    // zůstává jako explicitní, čitelný druhý zámek.
    throw new EetZakazanaAdresa('Adresa vypadá jako domain Finanční správy — odmítnuto.');
  }
  return _provestSoapPost(mockUrl, signedSoapXml, opts);
}

module.exports = {
  ADRESA_PLAYGROUND,
  EetSitovaChyba,
  EetTimeout,
  EetZakazanaAdresa,
  odeslatNaPlayground,
  _odeslatNaLokalniMockServer
};
