// Regresní test: uživatelská data (jméno, telefon, e-mail, poznámky, údaje
// u poukazů...) se v adminu nesmí vykreslovat bez ošetření (XSS).
//
// Netestuje se kopie/reimplementace, ale PŘÍMO funkce escapeHtml/escapeJsAttr
// vytažené ze skutečného admin.html, a statickou kontrolou se ověří, že se
// klíčová pole v souboru nikde nevykreslují bez obalení escapeHtml(...).
//
// Spuštění:  node tests/xss.test.js   (nepotřebuje síť ani heslo)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

const escapeHtmlMatch = html.match(/function escapeHtml\([\s\S]*?\n\}/);
const escapeJsAttrMatch = html.match(/function escapeJsAttr\([\s\S]*?\n\}/);
assert.ok(escapeHtmlMatch, 'Funkce escapeHtml nebyla v admin.html nalezena — regrese!');
assert.ok(escapeJsAttrMatch, 'Funkce escapeJsAttr nebyla v admin.html nalezena — regrese!');

// eslint-disable-next-line no-eval
eval(escapeHtmlMatch[0]);
// eslint-disable-next-line no-eval
eval(escapeJsAttrMatch[0]);

console.log('--- escapeHtml neutralizuje nebezpečné znaky ---');
const payloady = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '"><svg onload=alert(1)>',
  "Jana <b>Nováková</b>",
];
payloady.forEach(p => {
  const vysledek = escapeHtml(p);
  assert.ok(!vysledek.includes('<'), `escapeHtml nechal "<" v: ${p} → ${vysledek}`);
  assert.ok(!vysledek.includes('>'), `escapeHtml nechal ">" v: ${p} → ${vysledek}`);
  assert.ok(!vysledek.includes('"') || p.indexOf('"') === -1 ? true : !vysledek.includes('"'), `escapeHtml nechal '"' v: ${p} → ${vysledek}`);
});
assert.equal(escapeHtml(null), '');
assert.equal(escapeHtml(undefined), '');
console.log('OK — escapeHtml odstraňuje <, >, " ze všech testovacích payloadů a zvládá null/undefined');

console.log('--- escapeJsAttr neutralizuje útěk z JS řetězce i HTML atributu ---');
// Simulace toho, co udělá prohlížeč: nejdřív HTML-dekóduje atribut, pak by prohlížeč
// spustil obsah jako JS. Po dekódování nesmí zůstat nezaescapovaný apostrof.
function simulujHtmlDekodovani(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
const jsPayload = "x'); alert(document.cookie); //";
const zaescapovano = escapeJsAttr(jsPayload);
const poDekodovani = simulujHtmlDekodovani(zaescapovano);
// V řetězci "poDekodovani" smí být apostrof jen tehdy, když je bezprostředně
// předchozí znak zpětné lomítko (tzn. je to escapovaný apostrof pro JS).
let bezpecne = true;
for (let i = 0; i < poDekodovani.length; i++) {
  if (poDekodovani[i] === "'" && poDekodovani[i - 1] !== '\\') { bezpecne = false; break; }
}
assert.ok(bezpecne, `escapeJsAttr nechal po HTML dekódování nezaescapovaný apostrof: ${poDekodovani}`);
console.log('OK — escapeJsAttr správně escapuje pro JS řetězec i HTML atribut zároveň');

console.log('--- statická kontrola: klíčová pole se nikde nevykreslují bez escapeHtml ---');
const rizikovaPole = [
  'jmeno', 'telefon', 'email', 'poznamka', 'masaz', 'popis', 'kod',
  'konkretni_masaz', 'kupujici_jmeno', 'kupujici_email', 'kupujici_telefon',
  'pro_koho', 'varianta', 'skupina', 'predmet', 'alergie', 'preference'
];
let celkemNalezu = 0;
rizikovaPole.forEach(pole => {
  // Hledá přesně "${promenna.pole}" (nic před tečkou a proměnnou navíc) —
  // takový vzor NENÍ podřetězcem "${escapeHtml(promenna.pole)}", protože tam
  // mezi "{" a proměnnou stojí navíc "escapeHtml(".
  const regex = new RegExp('\\$\\{[a-zA-Z0-9_]+\\.' + pole + '\\}', 'g');
  const nalezy = html.match(regex) || [];
  if (nalezy.length) console.log('  Nalezeno neošetřené:', pole, '→', nalezy);
  celkemNalezu += nalezy.length;
});
assert.equal(celkemNalezu, 0, 'Nalezena pole vykreslovaná bez escapeHtml — viz výpis výš');
console.log('OK — žádné z ' + rizikovaPole.length + ' kontrolovaných polí se nevykresluje bez ošetření (zkontrolováno v souboru admin.html)');

console.log('\n✅ VŠECHNY XSS TESTY PROŠLY');
