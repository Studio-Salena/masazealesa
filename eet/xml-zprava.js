// Generování XML zprávy evidované tržby (element <tns:Trzba>) přesně podle
// EETXMLSchema.xsd (rozhraní 4.1) a věcného popisu položek — viz
// eet_specifikace/MANIFEST.md pro zdroje a kontrolní součty. Čistě lokální:
// tento modul nic neodesílá, jen sestavuje a formátuje XML text ze vstupních
// dat (typicky řádek "evidovana_trzba" + konfigurace eic_popl/id_jednotky/id_pokl).
const crypto = require('crypto');
const { NAMESPACE_TRZBA } = require('./specifikace');

// Masky datového formátu — přesná kopie <xs:pattern> z EETXMLSchema.xsd.
const MASKY = {
  uuidZpravy: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/,
  eic: /^CZ[0-9]{8,10}$/,
  idJednotky: /^[1-9][0-9]{0,8}$/,
  retezec20: /^[0-9a-zA-Z.,:;/#\-_ ]{1,20}$/,
  retezec25: /^[0-9a-zA-Z.,:;/#\-_ ]{1,25}$/,
  datumCas: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d)$/
};

class EetFormatovaciChyba extends Error {}

// Lokální čas v Evropa/Praha s povinnou časovou zónou (+01:00 SEČ / +02:00
// SELČ) — přesně formát požadovaný specifikací (kap. 3.3.3.2). Počítá offset
// z rozdílu mezi "wall clock" času v Praze a UTC pro daný okamžik, takže
// přechod letního/zimního času je vždy správně, bez závislosti na časové
// zóně serveru, na kterém kód běží.
function formatovatDatumCas(datum) {
  const d = datum instanceof Date ? datum : new Date(datum);
  if (Number.isNaN(d.getTime())) {
    throw new EetFormatovaciChyba(`Neplatné datum: ${datum}`);
  }
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const casti = dtf.formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const prahaJakoUtc = Date.UTC(
    Number(casti.year), Number(casti.month) - 1, Number(casti.day),
    Number(casti.hour), Number(casti.minute), Number(casti.second)
  );
  const offsetMin = Math.round((prahaJakoUtc - d.getTime()) / 60000);
  const znamenko = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const vysledek = `${casti.year}-${casti.month}-${casti.day}T${casti.hour}:${casti.minute}:${casti.second}${znamenko}${hh}:${mm}`;
  if (!MASKY.datumCas.test(vysledek)) {
    throw new EetFormatovaciChyba(`Vygenerované datum neodpovídá masce specifikace: ${vysledek}`);
  }
  return vysledek;
}

// Formát částky dle CastkaType: dvě desetinná místa, "0.00" (nikdy "-0.00"),
// rozsah striktně (-100000000, 100000000). "numeric" sloupce PostgreSQL
// chodí přes "pg" jako string — parseFloat je tu bezpečný, protože částky v
// této appce jsou vždy haléřové hodnoty se max. 2 des. místy, ne libovolně
// přesná čísla, kde by hrozila ztráta přesnosti.
function formatovatCastku(hodnota) {
  const n = typeof hodnota === 'string' ? parseFloat(hodnota) : hodnota;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new EetFormatovaciChyba(`Částka není platné číslo: ${hodnota}`);
  }
  if (Math.abs(n) >= 100000000) {
    throw new EetFormatovaciChyba(`Částka mimo povolený rozsah CastkaType (|x| < 100 000 000): ${hodnota}`);
  }
  // Zabránit "-0.00" u hodnot, které po zaokrouhlení na 2 des. místa vyjdou
  // nulové (např. -0.001) — spec nulovou částku se znaménkem nepovoluje.
  const zaokrouhleno = Math.round(n * 100) / 100;
  const text = (zaokrouhleno === 0 ? 0 : zaokrouhleno).toFixed(2);
  const castkaMaska = /^((0|-?[1-9]\d{0,7})\.\d\d|-0\.(0[1-9]|[1-9]\d))$/;
  if (!castkaMaska.test(text)) {
    throw new EetFormatovaciChyba(`Naformátovaná částka neodpovídá masce CastkaType: ${text}`);
  }
  return text;
}

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Nové UUID zprávy musí vzniknout při KAŽDÉM pokusu o odeslání, i opakovaném
// (spec, "UUID zprávy": "Nové UUID datové zprávy musí být vytvořeno a
// použito i v případech, kdy dochází k opakovanému zaslání datové zprávy").
// crypto.randomUUID() generuje verzi 4 (M=4, N v {8,9,a,b}), což maska
// připouští i doporučuje.
function vygenerovatUuidZpravy() {
  return crypto.randomUUID();
}

// Hlavička datové zprávy. "prvniZaslani" musí odrážet, zda jde o historicky
// první pokus o odeslání TÉTO evidované tržby (ne této zprávy) — volající
// (eet/odesilaci-identita.js) to spočítá z počtu předchozích řádků
// eet_odeslani, ne z ničeho uhodnutého tady.
function vygenerovatHlavicku({ prvniZaslani, overeni = false, datOdeslani = new Date() } = {}) {
  if (typeof prvniZaslani !== 'boolean') {
    throw new EetFormatovaciChyba('prvniZaslani musí být explicitně true/false.');
  }
  const hlavicka = {
    uuid_zpravy: vygenerovatUuidZpravy(),
    dat_odesl: formatovatDatumCas(datOdeslani),
    prvni_zaslani: prvniZaslani
  };
  if (overeni) {
    hlavicka.overeni = true;
  }
  return hlavicka;
}

// Datová oblast <Data> z řádku evidovana_trzba + konfigurace poplatníka.
// Nepovinné položky (urceno_cerp_zuct/cerp_zuct/eic_poverujiciho/
// povereni_vice_popl) se do výstupu vůbec nezahrnou, pokud nejsou relevantní
// — spec výslovně zakazuje jejich uvedení s prázdnou/nulovou hodnotou, když
// nejsou relevantní (kap. 3.3.2, poznámka **).
function vygenerovatData(trzba, cfg) {
  if (!cfg || !cfg.eicPopl) {
    throw new EetFormatovaciChyba('Chybí povinná konfigurace eicPopl (EIČ poplatníka).');
  }
  const data = {
    eic_popl: cfg.eicPopl,
    id_jednotky: String(trzba.id_jednotky),
    id_pokl: String(trzba.id_pokl),
    porad_cis: String(trzba.porad_cis),
    dat_trzby: formatovatDatumCas(trzba.dat_trzby),
    celk_trzba: formatovatCastku(trzba.celk_trzba)
  };
  if (cfg.eicPoverujiciho) {
    data.eic_poverujiciho = cfg.eicPoverujiciho;
  }
  if (cfg.povereniViceAPopl) {
    data.povereni_vice_popl = true;
  }
  if (trzba.urceno_cerp_zuct !== null && trzba.urceno_cerp_zuct !== undefined) {
    data.urceno_cerp_zuct = formatovatCastku(trzba.urceno_cerp_zuct);
  }
  if (trzba.cerp_zuct !== null && trzba.cerp_zuct !== undefined) {
    data.cerp_zuct = formatovatCastku(trzba.cerp_zuct);
  }
  return data;
}

// Ověří VŠECHNY masky datového formátu najednou (rychlejší diagnóza chyby
// konfigurace než čekat na odmítnutí celým XSD validátorem) — nejde o
// náhradu XSD validace (ta běží samostatně, viz xsd-validace.js), jen o
// časnější a konkrétnější chybovou zprávu.
function overitMasky(data) {
  const chyby = [];
  if (!MASKY.uuidZpravy.test(data.hlavicka.uuid_zpravy)) chyby.push(`uuid_zpravy neodpovídá masce: ${data.hlavicka.uuid_zpravy}`);
  if (!MASKY.datumCas.test(data.hlavicka.dat_odesl)) chyby.push(`dat_odesl neodpovídá masce: ${data.hlavicka.dat_odesl}`);
  if (!MASKY.eic.test(data.data.eic_popl)) chyby.push(`eic_popl neodpovídá masce: ${data.data.eic_popl}`);
  if (data.data.eic_poverujiciho && !MASKY.eic.test(data.data.eic_poverujiciho)) chyby.push(`eic_poverujiciho neodpovídá masce: ${data.data.eic_poverujiciho}`);
  if (!MASKY.idJednotky.test(data.data.id_jednotky)) chyby.push(`id_jednotky neodpovídá masce: ${data.data.id_jednotky}`);
  if (!MASKY.retezec20.test(data.data.id_pokl)) chyby.push(`id_pokl neodpovídá masce: ${data.data.id_pokl}`);
  if (!MASKY.retezec25.test(data.data.porad_cis)) chyby.push(`porad_cis neodpovídá masce: ${data.data.porad_cis}`);
  if (!MASKY.datumCas.test(data.data.dat_trzby)) chyby.push(`dat_trzby neodpovídá masce: ${data.data.dat_trzby}`);
  if (chyby.length > 0) {
    throw new EetFormatovaciChyba('Neplatný formát položek:\n' + chyby.join('\n'));
  }
}

function atributy(obj) {
  return Object.entries(obj)
    .map(([klic, hodnota]) => `${klic}="${xmlEscape(typeof hodnota === 'boolean' ? (hodnota ? 'true' : 'false') : hodnota)}"`)
    .join(' ');
}

// Sestaví samotný element <tns:Trzba> (bez SOAP obálky — to dělá
// soap-obalka.js). Vrací { xml, hlavicka, data } pro další použití (např.
// zápis uuid_zpravy/prvni_zaslani do eet_odeslani po (budoucím) odeslání).
function sestavitXmlTrzby(trzba, cfg, { prvniZaslani, overeni = false, datOdeslani = new Date() } = {}) {
  const hlavicka = vygenerovatHlavicku({ prvniZaslani, overeni, datOdeslani });
  const data = vygenerovatData(trzba, cfg);
  overitMasky({ hlavicka, data });
  const xml =
    `<tns:Trzba xmlns:tns="${NAMESPACE_TRZBA}">` +
    `<tns:Hlavicka ${atributy(hlavicka)}/>` +
    `<tns:Data ${atributy(data)}/>` +
    `</tns:Trzba>`;
  return { xml, hlavicka, data };
}

module.exports = {
  EetFormatovaciChyba,
  MASKY,
  formatovatDatumCas,
  formatovatCastku,
  vygenerovatUuidZpravy,
  vygenerovatHlavicku,
  vygenerovatData,
  overitMasky,
  sestavitXmlTrzby
};
