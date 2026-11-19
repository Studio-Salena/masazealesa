// Lokální simulátor odpovědí systému EET (Krok 3c, bod 6). ÚMYSLNĚ zde není
// ŽÁDNÝ import "http"/"https"/"net"/"fetch" ani adresa žádného serveru — tento
// soubor nemůže navázat síťové spojení, i kdyby se o to volající pokusil,
// protože k tomu nemá vůbec žádné prostředky. Simuluje jen TVAR odpovědí
// podle oficiální specifikace (chybové kódy a kódy varování v komentářích
// níž jsou přesná citace z EET_popis_rozhrani_v1.2.pdf, kap. 3.4.4 a 3.5.4 —
// ne vymyšlené), aby šlo offline testovat zpracování odpovědi/timeoutu/
// opakování beze spojení s Finanční správou (ani s Playgroundem).
const crypto = require('crypto');
const { formatovatDatumCas } = require('./xml-zprava');

// Skutečně zdokumentované chybové kódy (zbytek rozsahu -999..999 je dle
// specifikace "rezervováno pro budoucí použití" nebo byl používán jen ve
// starší verzi rozhraní — proto to NENÍ úplný číselník, jen reprezentativní
// výběr pro simulaci).
const CHYBOVE_KODY = Object.freeze({
  TEMPORARY: { kod: -1, text: 'Docasna technicka chyba zpracovani - odeslete prosim datovou zpravu pozdeji' },
  OVERENI_OK: { kod: 0, text: 'Datovou zpravu evidovane trzby v overovacim modu se podarilo zpracovat' },
  KODOVANI: { kod: 2, text: 'Kodovani XML neni platne' },
  XSD: { kod: 3, text: 'XML zprava nevyhovela kontrole XML schematu' },
  PODPIS: { kod: 4, text: 'Neplatny podpis SOAP zpravy' },
  EIC_STRUKTURA: { kod: 6, text: 'EIC poplatnika ma chybnou strukturu' },
  PRILIS_VELKA: { kod: 7, text: 'Datova zprava je prilis velka' },
  TECHNICKA: { kod: 8, text: 'Datova zprava nebyla zpracovana kvuli technicke chybe nebo chybe dat' }
});

const KODY_VAROVANI = Object.freeze({
  EIC_NESHODA_CERT: { kod: 1, text: 'EIC poplatnika v datove zprave se neshoduje s EIC v certifikatu' },
  EIC_POVERUJICIHO_FORMAT: { kod: 2, text: 'Chybny format EIC poverujiciho poplatnika' },
  DAT_TRZBY_V_BUDOUCNU: { kod: 4, text: 'Datum a cas uskutecneni trzby je novejsi nez datum a cas prijeti zpravy' },
  DAT_TRZBY_STARE: { kod: 5, text: 'Datum a cas uskutecneni trzby je vyrazne v minulosti' },
  ID_JEDNOTKY_FORMAT: { kod: 6, text: 'id_jednotky neodpovida formatem pridelenemu c. evidencni jednotky' },
  EIC_POVERUJICIHO_SHODNE: { kod: 7, text: 'EIC poverujiciho se shoduje s EIC poplatnika' }
});

// Ryze lokální chybová třída pro "simulovaný timeout" — NIKDY vzniklá ze
// skutečného síťového volání (to by vracel jiný druh výjimky z http klienta,
// který tu navíc vůbec není k dispozici).
class SimulovanyTimeout extends Error {
  constructor() { super('SIMULACE: žádná odpověď do mezní doby odezvy (lokální simulace, nic se nikam neposlalo).'); }
}

// POK má tvar "uuid_prijem-Id_zarizeni" (popis rozhraní v1.2, §3.4.2.3) —
// pro neprodukční/testovací simulaci je Id_zarizeni vždy "ff" (mnemotechnicky
// Fiktivní-Fiktivní), stejně jako na reálném Playgroundu.
function vygenerovatFiktivniPok() {
  return `${crypto.randomUUID()}-ff`;
}

function ted() {
  return formatovatDatumCas(new Date());
}

// scenar: 'potvrzeni' | 'chyba' | 'timeout'
function simulovatOdpoved(scenar, { uuidZpravy, chyba = CHYBOVE_KODY.TECHNICKA, varovani = [] } = {}) {
  if (scenar === 'timeout') {
    throw new SimulovanyTimeout();
  }
  if (scenar === 'potvrzeni') {
    return {
      typ: 'potvrzeni',
      uuid_zpravy: uuidZpravy,
      dat_prij: ted(),
      pok: vygenerovatFiktivniPok(),
      test: true,
      varovani: varovani.map((v) => ({ kod_varov: v.kod, text: v.text }))
    };
  }
  if (scenar === 'chyba') {
    return {
      typ: 'chyba',
      uuid_zpravy: uuidZpravy,
      dat_odmit: ted(),
      kod: chyba.kod,
      text: chyba.text,
      test: true,
      varovani: varovani.map((v) => ({ kod_varov: v.kod, text: v.text }))
    };
  }
  throw new Error(`Neznámý scénář simulace: ${scenar}`);
}

module.exports = { CHYBOVE_KODY, KODY_VAROVANI, SimulovanyTimeout, vygenerovatFiktivniPok, simulovatOdpoved };
