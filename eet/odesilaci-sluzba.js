// Krok 3d — koordinované odesílání evidovaných tržeb (okamžitě po platbě i
// záložní worker). JEDNA sdílená funkce (zpracovatZamcenouTrzbu) dělá
// samotnou práci pro OBĚ cesty — rozdíl je jen v tom, JAK se tržba zamkne
// (eet_zamknout_konkretni pro okamžité odeslání, eet_zamknout_dalsi_davku
// pro worker), obojí ale stejnou DB funkcí/stejnou WHERE podmínkou/stejným
// CAS lístkem (aktualni_pokus_id) z Kroku 3a — žádný druhý nezávislý
// zamykací mechanismus.
//
// Znovu používá (NEduplikuje): eet/xml-zprava.js (sestavení <Trzba>),
// eet/soap-obalka.js + eet/podpis.js (obálka a podpis, Krok 3c),
// eet/odesilaci-identita.js (prvni_zaslani dle počtu předchozích pokusů),
// eet/playground-klient.js (HTTP, Krok 3c — v tomto kroku VÝHRADNĚ
// REZIM.LOCAL_MOCK, viz zadání), eet/odpoved-parser.js (rozbor odpovědi),
// eet/overeni-odpovedi-fs.js (NOVÉ — kryptografické ověření odpovědi).
const { sestavitXmlTrzby } = require('./xml-zprava');
const { sestavitNepodepsanouObalku } = require('./soap-obalka');
const { podepsatObalku } = require('./podpis');
const { jeToPrvniZaslani } = require('./odesilaci-identita');
const { REZIM, odeslatZpravu, EetSitovaChyba, EetTimeout } = require('./playground-klient');
const { rozebratOdpoved, EetOdpovedChyba } = require('./odpoved-parser');
const { overitPodpisAKotvuOdpovedi } = require('./overeni-odpovedi-fs');

// Chybové kódy FS, které spec/praxe popisuje jako PŘECHODNÉ (dočasná
// technická chyba na straně FS — smysluplné zkusit znovu). Všechno ostatní
// (neplatná XSD, neplatný podpis, špatná struktura EIČ, zpráva příliš
// velká, obecná "technická nebo datová chyba") je buď chyba naší
// konfigurace/dat, nebo nesouvisí s dočasným výpadkem — opakování by na tom
// nic nezměnilo, proto se považuje za TRVALÉ (vyžaduje ruční zásah).
const PRECHODNE_CHYBOVE_KODY = new Set([-1]);

async function dotaz(db, sql, params) {
  const { rows } = await db.query(sql, params);
  return rows;
}

// Sestaví a podepíše XML pro JEDEN pokus o odeslání dané (už zamčené)
// evidované tržby. "pocetPredchozichPokusu" se čte čerstvě z DB (ne z
// počítadla v paměti) — je to jediný zdroj pravdy o tom, jde-li o první
// zaslání.
async function sestavitZpravu(db, trzbaRow, { eicPopl, certificatePem, privateKeyPem }) {
  const predchozi = await dotaz(db, 'SELECT count(*)::int AS pocet FROM eet_odeslani WHERE evidovana_trzba_id = $1', [trzbaRow.id]);
  const pocetPredchozichPokusu = predchozi[0].pocet;
  const prvniZaslani = jeToPrvniZaslani(pocetPredchozichPokusu);

  const trzbaProXml = {
    id_jednotky: trzbaRow.id_jednotky,
    id_pokl: trzbaRow.id_pokl,
    porad_cis: trzbaRow.porad_cis,
    dat_trzby: trzbaRow.dat_trzby,
    celk_trzba: trzbaRow.celk_trzba,
    urceno_cerp_zuct: trzbaRow.urceno_cerp_zuct,
    cerp_zuct: trzbaRow.cerp_zuct
  };
  const { xml, hlavicka } = sestavitXmlTrzby(trzbaProXml, { eicPopl }, { prvniZaslani, overeni: false });
  const nepodepsana = sestavitNepodepsanouObalku(xml, { certificatePem });
  const podepsana = podepsatObalku(nepodepsana, { privateKeyPem, certificatePem });
  return { podepsana, uuidZpravy: hlavicka.uuid_zpravy, prvniZaslani, pocetPredchozichPokusu };
}

// Rozhodne o výsledné klasifikaci JEDNOHO pokusu — vrací vše potřebné pro
// zápis přes eet_zapsat_vysledek. Nikdy nepovýší nedůvěryhodnou odpověď na
// "potvrzeno" (viz eet/overeni-odpovedi-fs.js) — bez platného podpisu proti
// důvěryhodné kotvě se odpověď vždy považuje za nejistou, bez ohledu na to,
// co sama tvrdí.
function klasifikovatOdpoved({ telo, duveryhodneKotvyPem }) {
  let odpovedParsovana;
  try {
    odpovedParsovana = rozebratOdpoved(telo);
  } catch (e) {
    if (e instanceof EetOdpovedChyba) {
      return { stav: 'nejiste', pok: null, chybaKod: null, chybaText: `Nerozpoznatelná odpověď: ${e.message}`, fsPodpisDuveryhodny: false, fsPodpisPoznamka: 'Odpověď se nepodařilo rozebrat, podpis nelze ani zkoušet ověřit.' };
    }
    throw e;
  }

  const overeniPodpisu = overitPodpisAKotvuOdpovedi(telo, { duveryhodneKotvyPem });

  if (!overeniPodpisu.duveryhodny) {
    // Bez důvěryhodného podpisu NEVÍME, co se skutečně stalo — ani kladná,
    // ani záporná odpověď se nesmí brát jako jistá.
    return {
      stav: 'nejiste',
      pok: odpovedParsovana.pok ?? null,
      chybaKod: odpovedParsovana.kod != null ? String(odpovedParsovana.kod) : null,
      chybaText: odpovedParsovana.text ?? null,
      fsPodpisDuveryhodny: false,
      fsPodpisPoznamka: overeniPodpisu.poznamka
    };
  }

  if (odpovedParsovana.typ === 'potvrzeni') {
    return { stav: 'potvrzeno', pok: odpovedParsovana.pok, chybaKod: null, chybaText: null, fsPodpisDuveryhodny: true, fsPodpisPoznamka: overeniPodpisu.poznamka };
  }
  // typ === 'chyba'
  const trvala = !PRECHODNE_CHYBOVE_KODY.has(odpovedParsovana.kod);
  return {
    stav: trvala ? 'chyba' : 'nejiste',
    pok: null,
    chybaKod: String(odpovedParsovana.kod),
    chybaText: odpovedParsovana.text,
    fsPodpisDuveryhodny: true,
    fsPodpisPoznamka: overeniPodpisu.poznamka
  };
}

// Zpracuje JEDNU už zamčenou evidovanou tržbu (trzbaRow musí mít čerstvé
// aktualni_pokus_id — od eet_zamknout_konkretni NEBO eet_zamknout_dalsi_davku,
// to je volajícímu lhostejné). Nikdy nic neopakuje sama od sebe v rámci
// jednoho volání — přesně JEDEN HTTP pokus, výsledek se vždy zapíše (i
// timeout/síťová chyba — jako "nejisté", NIKDY tiše zahozeno).
async function zpracovatZamcenouTrzbu(db, trzbaRow, opts) {
  const { rezim, mockUrl, timeoutMs = 15000, certificatePem, privateKeyPem, eicPopl, duveryhodneKotvyPem = [], maxPokusu = 10 } = opts;
  if (rezim !== REZIM.LOCAL_MOCK) {
    // Krok 3d je výslovně omezen na lokální TEST/mock (zadání, bod 10) —
    // tahle funkce REZIM.OFFICIAL_PLAYGROUND vůbec nepřijme, aby ji nešlo
    // omylem zapojit do automatizovaného odesílání na Playground/produkci
    // dřív, než to bude samostatně schváleno.
    throw new Error('eet/odesilaci-sluzba.js smí v tomto kroku pracovat jen s REZIM.LOCAL_MOCK.');
  }

  // Sestavení/podpis zprávy se zabalují DO STEJNÉHO try/catch jako odeslání
  // — jinak by trvalá chyba v uložených datech (např. id_jednotky neplatného
  // tvaru) nebo v konfiguraci klíče/certifikátu vyhodila nezachycenou
  // výjimku PŘED jakýmkoli zápisem výsledku: řádek by zůstal "zamčený"
  // (zpracovava_se_od) bez eet_odeslani záznamu a po 5 minutách by se znovu
  // a znovu předhazoval s tou samou (neopravitelnou retry) chybou navždy —
  // přesně to, co zadání bodu 6 zakazuje. Build/podpisová chyba se tu vždy
  // považuje za TRVALOU (opakování nic nezmění, dokud se data/konfigurace
  // nezmění ručně).
  let podepsana, uuidZpravy, prvniZaslani, pocetPredchozichPokusu;
  try {
    ({ podepsana, uuidZpravy, prvniZaslani, pocetPredchozichPokusu } = await sestavitZpravu(db, trzbaRow, { eicPopl, certificatePem, privateKeyPem }));
  } catch (e) {
    const nahradniUuid = require('crypto').randomUUID();
    const predchozi = await dotaz(db, 'SELECT count(*)::int AS pocet FROM eet_odeslani WHERE evidovana_trzba_id = $1', [trzbaRow.id]);
    const vysledekZapisu = await dotaz(
      db,
      `SELECT zapsano FROM eet_zapsat_vysledek($1,$2,'chyba',$3,$4,'chyba',null,'SESTAVENI',$5,null,null,$6)`,
      [trzbaRow.id, trzbaRow.aktualni_pokus_id, nahradniUuid, jeToPrvniZaslani(predchozi[0].pocet), `Zprávu se nepodařilo sestavit/podepsat: ${e.message}`, 'Zpráva se nikdy neposlala, chyba nastala při sestavení/podpisu.']
    );
    return { zapsano: vysledekZapisu[0].zapsano, stav: 'chyba', uuidZpravy: nahradniUuid, pocetPokusuCelkem: predchozi[0].pocet + 1, klasifikace: { stav: 'chyba', chybaText: e.message } };
  }

  let klasifikace;
  let httpStatus = null;
  try {
    const odpoved = await odeslatZpravu(podepsana, { rezim, mockUrl, timeoutMs });
    httpStatus = odpoved.httpStatus;
    klasifikace = klasifikovatOdpoved({ telo: odpoved.telo, duveryhodneKotvyPem });
  } catch (e) {
    if (e instanceof EetTimeout || e instanceof EetSitovaChyba) {
      // Timeout/síťová chyba = VÝSLOVNĚ nejistý výsledek (mohlo se doručit,
      // mohlo ne) — nikdy se nepovažuje za chybu ani za potvrzení.
      klasifikace = { stav: 'nejiste', pok: null, chybaKod: null, chybaText: e.message, fsPodpisDuveryhodny: null, fsPodpisPoznamka: null };
    } else {
      throw e;
    }
  }

  // Strop počtu pokusů (zadání, bod 6) — i přechodně klasifikovaný výsledek
  // se po dosažení stropu uzavře jako 'chyba' (vyžaduje ruční zásah), aby
  // trvalý výpadek FS nevedl k nekonečnému opakování navždy.
  const celkovyPocetPokusu = pocetPredchozichPokusu + 1;
  let novyStav = klasifikace.stav;
  if (novyStav === 'nejiste' && celkovyPocetPokusu >= maxPokusu) {
    novyStav = 'chyba';
  }

  const vysledekZapisu = await dotaz(
    db,
    `SELECT zapsano FROM eet_zapsat_vysledek($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      trzbaRow.id, trzbaRow.aktualni_pokus_id, novyStav, uuidZpravy, prvniZaslani,
      klasifikace.stav, klasifikace.pok, klasifikace.chybaKod, klasifikace.chybaText, httpStatus,
      klasifikace.fsPodpisDuveryhodny, klasifikace.fsPodpisPoznamka
    ]
  );

  return {
    zapsano: vysledekZapisu[0].zapsano,
    stav: novyStav,
    uuidZpravy,
    pocetPokusuCelkem: celkovyPocetPokusu,
    klasifikace
  };
}

// Okamžité odeslání (hned po platbě) — zamyká JEN tuhle jednu tržbu, stejnou
// DB funkcí (eet_zamknout_konkretni), jakou by (v jiné situaci) použil i
// worker níž pro jiné řádky.
async function odeslatIhned(db, trzbaId, opts, workerId = `ihned-${process.pid}`) {
  const zamceno = await dotaz(db, 'SELECT * FROM eet_zamknout_konkretni($1,$2)', [trzbaId, workerId]);
  if (zamceno.length === 0) {
    return { zamceno: false };
  }
  const vysledek = await zpracovatZamcenouTrzbu(db, zamceno[0], opts);
  return { zamceno: true, ...vysledek };
}

// Záložní worker — zamyká dávku NEJVÝŠE "pocet" tržeb (eet_zamknout_dalsi_davku,
// Krok 3a), každou zpracuje STEJNOU funkcí jako okamžité odeslání výš.
// Zpracovává sekvenčně (ne paralelně) — v tomto kroku jde o lokální
// TEST/demo, ne o produkční propustnost.
async function zpracovatDavku(db, opts, pocet = 10, workerId = `worker-${process.pid}`) {
  const zamcene = await dotaz(db, 'SELECT * FROM eet_zamknout_dalsi_davku($1,$2)', [workerId, pocet]);
  const vysledky = [];
  for (const radek of zamcene) {
    vysledky.push({ trzbaId: radek.id, ...(await zpracovatZamcenouTrzbu(db, radek, opts)) });
  }
  return vysledky;
}

module.exports = { zpracovatZamcenouTrzbu, odeslatIhned, zpracovatDavku, klasifikovatOdpoved, PRECHODNE_CHYBOVE_KODY };
