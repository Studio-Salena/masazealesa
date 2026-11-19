// Lokální validace vygenerovaného XML proti oficiálnímu EETXMLSchema.xsd
// (viz eet_specifikace/MANIFEST.md). Čistě ofline — xmllint-wasm běží jako
// WebAssembly uvnitř Node, žádné síťové volání, žádný systémový xmllint
// binární soubor potřeba.
const fs = require('fs');
const { validateXML } = require('xmllint-wasm');
const { PODKLADY } = require('./specifikace');

let xsdObsahCache = null;
function nacistXsd() {
  if (!xsdObsahCache) {
    xsdObsahCache = fs.readFileSync(PODKLADY.xsd.soubor, 'utf8');
  }
  return xsdObsahCache;
}

// Ověří, že soubor na disku pořád odpovídá kontrolnímu součtu z manifestu —
// kdyby se XSD omylem přepsalo/aktualizovalo bez aktualizace manifestu,
// validace by tiše běžela proti jiné verzi rozhraní, než je zaznamenaná.
function overitKontrolniSoucet() {
  const crypto = require('crypto');
  const obsah = fs.readFileSync(PODKLADY.xsd.soubor);
  const sha256 = crypto.createHash('sha256').update(obsah).digest('hex');
  if (sha256 !== PODKLADY.xsd.sha256) {
    throw new Error(
      `EETXMLSchema.xsd na disku neodpovídá kontrolnímu součtu v eet/specifikace.js ` +
      `(očekáváno ${PODKLADY.xsd.sha256}, nalezeno ${sha256}). Aktualizujte manifest, nebo obnovte původní soubor.`
    );
  }
}

// Validuje libovolný XML fragment (očekává se kořenový element <tns:Trzba>)
// proti EETXMLSchema.xsd. Vrací { valid, errors } — chyby jsou lidsky
// čitelné zprávy z xmllint, ne jen true/false.
async function validovatProtiXsd(xml) {
  overitKontrolniSoucet();
  const vysledek = await validateXML({
    xml: { fileName: 'zprava.xml', contents: xml },
    schema: { fileName: 'EETXMLSchema.xsd', contents: nacistXsd() }
  });
  return { valid: vysledek.valid, errors: vysledek.errors.map((e) => e.message) };
}

module.exports = { validovatProtiXsd, overitKontrolniSoucet };
