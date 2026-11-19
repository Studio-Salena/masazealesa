// HTTP klient pro odeslání podepsané SOAP zprávy — Krok 3c.
//
// VYŘEŠENÍ ROZPORU z předchozí verze tohoto modulu: dřív existovala JEDNA
// "produkčně vypadající" funkce (odeslatNaPlayground, adresa napevno, ale
// NIKDY netestovaná) a JEDNA testovací funkce (jen localhost, nikdy
// nemůže otestovat nic blízkého reálné cestě). To je logická mezera — kód,
// co by se jednou opravdu použil, zůstával bez jakéhokoli ověření.
//
// Řešení: DVA VÝSLOVNĚ POJMENOVANÉ, STEJNĚ DŮLEŽITÉ REŽIMY přes jednu funkci
// `odeslatZpravu(xml, { rezim, ... })`:
//   - REZIM.LOCAL_MOCK         — jen 127.0.0.1, pro ofline testy (bod 9)
//   - REZIM.OFFICIAL_PLAYGROUND — JEN přesná oficiální adresa Playgroundu,
//     s TLS ověřením, bez přesměrování, adresu nejde zvenčí přepsat
// Produkční endpoint Finanční správy (https://trzbyeet.gov.cz/...) je
// explicitně a navždy zakázaný v OBOU režimech — žádná veřejná funkce
// tohoto modulu ho nemůže zasáhnout, protože žádná z nich nebere URL jako
// parametr volný k libovolnému nastavení.
const https = require('node:https');
const { PODKLADY, SOAP_ACTION } = require('./specifikace');

const REZIM = Object.freeze({ LOCAL_MOCK: 'LOCAL_MOCK', OFFICIAL_PLAYGROUND: 'OFFICIAL_PLAYGROUND' });

// Přesná, oficiálně zdokumentovaná adresa (eet_specifikace/MANIFEST.md,
// EET_pristupove_provozni_informace_playground_1_2.pdf, kap. 2.1).
const ADRESA_PLAYGROUND = PODKLADY.playground.url;
// Přesná produkční adresa (EET_pristupove_provozni_informace_produkce_v1_2.pdf,
// kap. 2.1, staženo a ověřeno 19.11.2026) — NIKDY nepoužitá k odeslání,
// uvedená tu VÝHRADNĚ jako explicitní položka na seznamu zakázaných adres.
const ADRESA_PRODUKCE = 'https://trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4';

if (ADRESA_PLAYGROUND === ADRESA_PRODUKCE) {
  // Nemůže nastat (jsou to různé řetězce), ale kdyby někdy někdo omylem
  // sjednotil konstanty při refaktoringu, tenhle modul se radši vůbec
  // nenačte, než aby tiše dovolil odeslání na produkci pod jménem "Playground".
  throw new Error('KRITICKÁ CHYBA KONFIGURACE: ADRESA_PLAYGROUND a ADRESA_PRODUKCE se nesmí shodovat.');
}

class EetSitovaChyba extends Error {}
class EetTimeout extends EetSitovaChyba {
  constructor() { super('Žádná odpověď do stanoveného limitu (mezní doba odezvy) — výsledek odeslání je NEJISTÝ, ne chyba.'); }
}
class EetZakazanaAdresa extends Error {}

function overitNeniZakazanaAdresa(urlText) {
  if (urlText === ADRESA_PRODUKCE) {
    throw new EetZakazanaAdresa('Odeslání na produkční endpoint Finanční správy je v tomto kroku trvale zakázané.');
  }
  let parsed;
  try {
    parsed = new URL(urlText);
  } catch {
    throw new EetZakazanaAdresa(`Neplatná URL: ${urlText}`);
  }
  if (/(^|\.)trzbyeet\.gov\.cz$/i.test(parsed.hostname) && urlText !== ADRESA_PLAYGROUND) {
    // Cokoli na doméně Finanční správy, co NENÍ přesně adresa Playgroundu
    // (tedy i produkce, i jakákoli budoucí jiná subdoména) — zakázáno.
    throw new EetZakazanaAdresa(`Adresa na doméně Finanční správy, která není přesná adresa Playgroundu: ${urlText}`);
  }
}

// ── REZIM.OFFICIAL_PLAYGROUND ───────────────────────────────────────────
// Jediná cesta k reálnému Playgroundu. Adresa NENÍ parametr — je rozebraná
// z konstanty ADRESA_PLAYGROUND přímo tady, takže volající nemá ŽÁDNOU
// možnost ji ovlivnit. Používá přímo "https" modul (ne fetch/undici), aby
// šlo explicitně (ne jen spoléháním na výchozí chování knihovny):
//   - vynutit ověření TLS certifikátu serveru (rejectUnauthorized: true)
//   - NIKDY nenásledovat přesměrování — klientský kód přesměrování vůbec
//     neumí zpracovat, 3xx odpověď je vždy vyhodnocena jako neočekávaná chyba
async function _odeslatOficialniPlayground(signedSoapXml, { timeoutMs = 15000 } = {}) {
  overitNeniZakazanaAdresa(ADRESA_PLAYGROUND);
  const cil = new URL(ADRESA_PLAYGROUND);
  if (cil.protocol !== 'https:') {
    // Nedosažitelné (konstanta je pevně https), ale explicitní pojistka —
    // tenhle klient nikdy nesmí mluvit s Playgroundem přes nešifrované HTTP.
    throw new EetZakazanaAdresa('Playground musí být vždy adresován přes HTTPS.');
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    // Nejčastější způsob, jak se v Node.js omylem vypne ověřování TLS
    // certifikátů (globální proměnná prostředí). Kdyby byla nastavená,
    // odmítáme pokračovat, místo abychom tiše poslali zprávu bez ověřeného
    // spojení.
    throw new EetZakazanaAdresa(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 je nastaveno v prostředí — to by vypnulo ověřování TLS certifikátu Playgroundu. Odmítnuto.'
    );
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: cil.hostname,
        port: cil.port || 443,
        path: cil.pathname + cil.search,
        method: 'POST',
        // Explicitní (ne jen výchozí) vynucení ověření TLS certifikátu serveru
        // proti důvěryhodným kořenovým autoritám — přesně dle specifikace,
        // kap. 5.1: "Pokladní zařízení musí... povinně kontrolovat platnost
        // TLS certifikátu serveru".
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': SOAP_ACTION,
          'Content-Length': Buffer.byteLength(signedSoapXml)
        },
        timeout: timeoutMs
      },
      (res) => {
        // ŽÁDNÉ sledování přesměrování — 3xx je vždy jen vrácen jako
        // neočekávaný stav, nikdy automaticky nenásledován.
        const kusy = [];
        res.on('data', (k) => kusy.push(k));
        res.on('end', () => {
          resolve({ httpStatus: res.statusCode, telo: Buffer.concat(kusy).toString('utf8') });
        });
        res.on('error', (e) => reject(new EetSitovaChyba(`Chyba při čtení odpovědi: ${e.message}`)));
      }
    );
    req.on('timeout', () => { req.destroy(new EetTimeout()); });
    req.on('error', (e) => {
      if (e instanceof EetTimeout) return reject(e);
      reject(new EetSitovaChyba(`Síťová chyba při odesílání na Playground: ${e.message}`));
    });
    req.end(signedSoapXml);
  });
}

// ── REZIM.LOCAL_MOCK ─────────────────────────────────────────────────────
// Pro ofline testy (Krok 3c, bod 9). "mockUrl" MUSÍ být na
// localhost/127.0.0.1/::1 — cokoli jiného (včetně Playgroundu samotného a
// produkce) je zakázáno. Používá obyčejný fetch — nejde o cestu, která by
// kdy komunikovala s Finanční správou, takže nepotřebuje stejnou úroveň
// explicitní TLS kontroly jako OFFICIAL_PLAYGROUND (mock běží přes HTTP, ne
// HTTPS, protože je to jen loopback test server).
async function _odeslatLokalniMock(signedSoapXml, mockUrl, { timeoutMs = 15000 } = {}) {
  let parsed;
  try {
    parsed = new URL(mockUrl);
  } catch {
    throw new EetZakazanaAdresa(`Neplatná URL pro mock server: ${mockUrl}`);
  }
  const povoleneHostname = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!povoleneHostname.has(parsed.hostname)) {
    throw new EetZakazanaAdresa(
      `Režim LOCAL_MOCK smí cílit JEN na localhost/127.0.0.1/::1 — dostal "${parsed.hostname}". ` +
      `Pro Playground použijte rezim: REZIM.OFFICIAL_PLAYGROUND.`
    );
  }
  overitNeniZakazanaAdresa(mockUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const odpoved = await fetch(mockUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': SOAP_ACTION },
      body: signedSoapXml,
      signal: controller.signal
    });
    const telo = await odpoved.text();
    return { httpStatus: odpoved.status, telo };
  } catch (e) {
    if (e.name === 'AbortError') throw new EetTimeout();
    throw new EetSitovaChyba(`Síťová chyba při odesílání na mock: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Jediný veřejný vstupní bod. "rezim" je POVINNÝ a musí být jedna z hodnot
// REZIM — žádná výchozí hodnota, aby nikdy nedošlo k nechtěnému odeslání na
// Playground jen proto, že se zapomněl parametr.
async function odeslatZpravu(signedSoapXml, { rezim, mockUrl, timeoutMs = 15000 } = {}) {
  if (rezim === REZIM.OFFICIAL_PLAYGROUND) {
    return _odeslatOficialniPlayground(signedSoapXml, { timeoutMs });
  }
  if (rezim === REZIM.LOCAL_MOCK) {
    if (!mockUrl) throw new Error('REZIM.LOCAL_MOCK vyžaduje mockUrl.');
    return _odeslatLokalniMock(signedSoapXml, mockUrl, { timeoutMs });
  }
  throw new Error(`Neplatný nebo chybějící "rezim" (dostal: ${JSON.stringify(rezim)}). Povolené hodnoty: ${Object.values(REZIM).join(', ')}.`);
}

module.exports = {
  REZIM,
  ADRESA_PLAYGROUND,
  ADRESA_PRODUKCE,
  EetSitovaChyba,
  EetTimeout,
  EetZakazanaAdresa,
  odeslatZpravu
};
