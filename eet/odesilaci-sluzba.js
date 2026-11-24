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
const { overitShoduKlicACertifikatu } = require('./podpis');

// Bezpečnostní hranice mezi síťovým timeoutem JEDNOHO pokusu a "stale"
// oknem databázového zámku (eet_zamknout_dalsi_davku/eet_zamknout_konkretni,
// Krok 3a: 5 minut). Pokud by HTTP timeout mohl být delší (nebo jen
// nebezpečně blízký) oknu, po kterém se zámek považuje za "spadlý a
// uvolnitelný", mohl by DRUHÝ worker zamknout a odeslat TUTÉŽ tržbu, zatímco
// PRVNÍ pokus je stále skutečně (ne jen zdánlivě) v běhu — to by způsobilo
// DVOJÍ odeslání. Proto se timeoutMs vždy musí zůstat výrazně (aspoň 2×)
// pod touto hranicí; jinak se o konfigurační chybu odmítáme i jen pokusit.
const STALE_OKNO_MINUT = 5;
const MAX_BEZPECNY_TIMEOUT_MS = (STALE_OKNO_MINUT * 60 * 1000) / 2;

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

// Kontrola OBOU přepínačů PŘÍMO tady, ne jen u volajícího (server.js dřív
// kontroloval "eet_odesilani_pozastaveno" jen u okamžitého odeslání po
// platbě — budoucí worker/dávkové zpracování i ruční znovu-zařazení by na
// tuhle kontrolu musely spoléhat samostatně, a jediné opomenutí by znamenalo
// síťové odeslání navzdory vypnutému přepínači). Obě cesty (odeslatIhned i
// zpracovatDavku) volají STEJNOU zpracovatZamcenouTrzbu níž, takže kontrola
// tady platí pro VŠECHNY vstupní cesty najednou.
//
// Fail-closed: povoleno je JEN přesná dvojice ('true','false'). Chybějící
// řádek, NULL, prázdný řetězec nebo jakákoli jiná hodnota (typo, poškozená
// migrace) se považuje za "nejasné nastavení" a odesílání se odmítne, nikdy
// naopak.
async function zkontrolovatPrepinaceOdesilani(db) {
  const radky = await dotaz(
    db,
    `SELECT klic, hodnota FROM nastaveni WHERE klic IN ('eet_evidence_zapnuta','eet_odesilani_pozastaveno')`
  );
  const m = {};
  radky.forEach(r => { m[r.klic] = r.hodnota; });

  if (m.eet_evidence_zapnuta !== 'true') {
    return { povoleno: false, duvod: `eet_evidence_zapnuta musí být přesně 'true' (nalezeno: ${JSON.stringify(m.eet_evidence_zapnuta ?? null)})` };
  }
  if (m.eet_odesilani_pozastaveno !== 'false') {
    return { povoleno: false, duvod: `eet_odesilani_pozastaveno musí být přesně 'false' (nalezeno: ${JSON.stringify(m.eet_odesilani_pozastaveno ?? null)})` };
  }
  return { povoleno: true, duvod: null };
}

// Sestaví a podepíše XML pro JEDEN pokus o odeslání dané (už zamčené)
// evidované tržby. "pocetPredchozichPokusu" se čte čerstvě z DB (ne z
// počítadla v paměti) — je to jediný zdroj pravdy o tom, jde-li o první
// zaslání.
async function pocetPokusuOdResetu(db, trzbaRow) {
  // Pokusy PŘED ručním "znovu zařazením" (eet_znovu_zaradit_do_fronty) se do
  // stropu (eet_max_pokusu) nepočítají — ten reset je VÝSLOVNÉ rozhodnutí
  // administrátora po opravě skutečné příčiny, znovu zařazená tržba dostává
  // plný nový rozpočet pokusů. Staré pokusy se tím ale nemažou ani nemění —
  // zůstávají navždy jako audit (eet_odeslani).
  const predchozi = await dotaz(
    db,
    `SELECT count(*)::int AS pocet FROM eet_odeslani WHERE evidovana_trzba_id = $1 AND odeslano_kdy > coalesce($2, '-infinity'::timestamptz)`,
    [trzbaRow.id, trzbaRow.rucni_reset_kdy || null]
  );
  return predchozi[0].pocet;
}

async function sestavitZpravu(db, trzbaRow, { eicPopl, certificatePem, privateKeyPem }) {
  const pocetPredchozichPokusu = await pocetPokusuOdResetu(db, trzbaRow);
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
function klasifikovatOdpoved({ telo, duveryhodneKotvyPem, ocekavanySubjekt }) {
  let odpovedParsovana;
  try {
    odpovedParsovana = rozebratOdpoved(telo);
  } catch (e) {
    if (e instanceof EetOdpovedChyba) {
      return { stav: 'nejiste', pok: null, chybaKod: null, chybaText: `Nerozpoznatelná odpověď: ${e.message}`, fsPodpisDuveryhodny: false, fsPodpisPoznamka: 'Odpověď se nepodařilo rozebrat, podpis nelze ani zkoušet ověřit.' };
    }
    throw e;
  }

  const overeniPodpisu = overitPodpisAKotvuOdpovedi(telo, { duveryhodneKotvyPem, ocekavanySubjekt });

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
  const { rezim, mockUrl, timeoutMs = 15000, certificatePem, privateKeyPem, eicPopl, duveryhodneKotvyPem = [], ocekavanySubjekt, maxPokusu = 10 } = opts;
  if (rezim !== REZIM.LOCAL_MOCK) {
    // Krok 3d je výslovně omezen na lokální TEST/mock (zadání, bod 10) —
    // tahle funkce REZIM.OFFICIAL_PLAYGROUND vůbec nepřijme, aby ji nešlo
    // omylem zapojit do automatizovaného odesílání na Playground/produkci
    // dřív, než to bude samostatně schváleno.
    throw new Error('eet/odesilaci-sluzba.js smí v tomto kroku pracovat jen s REZIM.LOCAL_MOCK.');
  }
  if (!(timeoutMs > 0) || timeoutMs > MAX_BEZPECNY_TIMEOUT_MS) {
    // Bod 7 — timeoutMs musí zůstat bezpečně (2×) pod 5minutovým "stale"
    // oknem zámku, jinak by souběžný worker mohl tutéž tržbu zamknout a
    // odeslat PODRUHÉ, zatímco první pokus je stále skutečně v běhu.
    throw new Error(`timeoutMs (${timeoutMs}) je nebezpečně blízko nebo nad "stale" oknem zámku (${STALE_OKNO_MINUT} min) — mohlo by dojít k dvojímu odeslání. Maximální bezpečná hodnota je ${MAX_BEZPECNY_TIMEOUT_MS} ms.`);
  }

  // Oba přepínače se čtou ČERSTVĚ z DB při KAŽDÉM volání (ne jen jednou na
  // začátku dávky) — pokud je někdo změní UPROSTŘED zpracovávání dávky,
  // další řádek dávky už se řídí novou hodnotou, žádné "zamrznuté" čtení
  // z doby, kdy dávka začala.
  const prepinace = await zkontrolovatPrepinaceOdesilani(db);
  if (!prepinace.povoleno) {
    await dotaz(db, 'SELECT eet_uvolnit_zamek_bez_vysledku($1,$2)', [trzbaRow.id, trzbaRow.aktualni_pokus_id]);
    throw new Error(`Odesílání odmítnuto přepínači (${prepinace.duvod}) — zámek uvolněn beze zápisu výsledku, tržba zůstává nedotčená pro další pokus, až budou přepínače v odesílatelném stavu.`);
  }

  // Certifikát/klíč se ověří JEŠTĚ PŘED sestavením zprávy a ZVLÁŠŤ od
  // chyb ve vlastních datech tržby (bod 8) — chybějící/neplatný/nesedící
  // certifikát je INFRASTRUKTURNÍ/konfigurační problém (týká se VŠECH
  // tržeb, ne téhle jedné), ne vada dat téhle konkrétní tržby. Takový
  // pokus se nesmí počítat do eet_max_pokusu ani tržbu trvale uzavřít —
  // zámek se jen uvolní (eet_uvolnit_zamek_bez_vysledku) a tržba zůstane
  // ve svém původním stavu, ihned znovu dostupná pro další pokus.
  if (!certificatePem || !privateKeyPem) {
    await dotaz(db, 'SELECT eet_uvolnit_zamek_bez_vysledku($1,$2)', [trzbaRow.id, trzbaRow.aktualni_pokus_id]);
    throw new Error('Chybí certificatePem/privateKeyPem (infrastrukturní/konfigurační problém, ne chyba dat této tržby) — zámek uvolněn beze zápisu výsledku.');
  }
  try {
    overitShoduKlicACertifikatu(privateKeyPem, certificatePem);
  } catch (e) {
    await dotaz(db, 'SELECT eet_uvolnit_zamek_bez_vysledku($1,$2)', [trzbaRow.id, trzbaRow.aktualni_pokus_id]);
    throw new Error(`Certifikát/klíč nejsou použitelné (infrastrukturní problém, ne chyba dat této tržby): ${e.message} — zámek uvolněn beze zápisu výsledku.`);
  }

  // Sestavení/podpis zprávy (vlastní data TÉTO tržby — na rozdíl od
  // kontroly certifikátu výš) se zabaluje do try/catch — jinak by trvalá
  // chyba v uložených datech (např. id_jednotky neplatného tvaru) vyhodila
  // nezachycenou výjimku PŘED jakýmkoli zápisem výsledku: řádek by zůstal
  // "zamčený" bez eet_odeslani záznamu a po 5 minutách by se znovu a znovu
  // předhazoval se stejnou (neopravitelnou retry) chybou navždy — přesně
  // to, co zadání bodu 6/8 zakazuje. Tahle chyba se považuje za TRVALOU
  // (opakování nic nezmění, dokud se DATA tržby ručně neopraví).
  let podepsana, uuidZpravy, prvniZaslani, pocetPredchozichPokusu;
  try {
    ({ podepsana, uuidZpravy, prvniZaslani, pocetPredchozichPokusu } = await sestavitZpravu(db, trzbaRow, { eicPopl, certificatePem, privateKeyPem }));
  } catch (e) {
    const nahradniUuid = require('crypto').randomUUID();
    const predchoziPocet = await pocetPokusuOdResetu(db, trzbaRow);
    const vysledekZapisu = await dotaz(
      db,
      `SELECT zapsano FROM eet_zapsat_vysledek($1,$2,'chyba',$3,$4,'chyba',null,'SESTAVENI',$5,null,null,$6)`,
      [trzbaRow.id, trzbaRow.aktualni_pokus_id, nahradniUuid, jeToPrvniZaslani(predchoziPocet), `Zprávu se nepodařilo sestavit/podepsat: ${e.message}`, 'Zpráva se nikdy neposlala, chyba nastala při sestavení/podpisu dat této tržby.']
    );
    return { zapsano: vysledekZapisu[0].zapsano, stav: 'chyba', uuidZpravy: nahradniUuid, pocetPokusuCelkem: predchoziPocet + 1, klasifikace: { stav: 'chyba', chybaText: e.message } };
  }

  let klasifikace;
  let httpStatus = null;
  try {
    const odpoved = await odeslatZpravu(podepsana, { rezim, mockUrl, timeoutMs });
    httpStatus = odpoved.httpStatus;
    klasifikace = klasifikovatOdpoved({ telo: odpoved.telo, duveryhodneKotvyPem, ocekavanySubjekt });
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
    try {
      vysledky.push({ trzbaId: radek.id, ...(await zpracovatZamcenouTrzbu(db, radek, opts)) });
    } catch (e) {
      // zpracovatZamcenouTrzbu už sama uvolňuje zámek beze zápisu výsledku u
      // ZNÁMÝCH chyb (přepínače, chybějící/nesedící certifikát) PŘED tím, než
      // je vyhodí — ale bez tohoto catch by jediná taková chyba U JEDNOHO
      // řádku dávky vyhodila výjimku z celé funkce a VŠECHNY další, už
      // zamčené řádky téže dávky by zůstaly zamčené až do vypršení 5minutového
      // "stale" okna, místo aby se o ně mohl ihned pokusit další běh workeru.
      // Druhé (idempotentní, bezpečné i když zámek už byl uvolněn výš)
      // uvolnění tady jako pojistka i pro JAKOUKOLI jinou, nečekanou chybu,
      // co by zámek sama neuvolnila.
      await dotaz(db, 'SELECT eet_uvolnit_zamek_bez_vysledku($1,$2)', [radek.id, radek.aktualni_pokus_id]).catch(() => {});
      vysledky.push({ trzbaId: radek.id, zamceno: true, stav: 'chyba_zpracovani', chybaText: e.message });
    }
  }
  return vysledky;
}

// Bezpečné ruční znovu-zařazení tržby, která skončila ve stavu 'chyba', zpět
// do fronty (bod 6) — tenká obálka nad eet_znovu_zaradit_do_fronty, aby
// volající (administrátorský nástroj/skript) nemusel sám sestavovat SQL.
// VÝSLOVNĚ ruční akce — nikde v tomto modulu se nevolá automaticky.
async function znovuZaraditDoFronty(db, trzbaId, poznamka) {
  if (!poznamka || !String(poznamka).trim()) {
    throw new Error('znovuZaraditDoFronty vyžaduje poznámku (proč/jak byla příčina opravena) — auditní stopa, ne volitelná položka.');
  }
  const [vysledek] = await dotaz(db, 'SELECT eet_znovu_zaradit_do_fronty($1,$2) AS ok', [trzbaId, String(poznamka).trim()]);
  return vysledek.ok;
}

module.exports = { zpracovatZamcenouTrzbu, odeslatIhned, zpracovatDavku, klasifikovatOdpoved, znovuZaraditDoFronty, zkontrolovatPrepinaceOdesilani, PRECHODNE_CHYBOVE_KODY, MAX_BEZPECNY_TIMEOUT_MS };
