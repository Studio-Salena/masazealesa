// Návrh podepisování SOAP zpráv dle WS-Security (Krok 3c, bod 4) — přesně
// podle požadavků v EET_popis_rozhrani_v1.2.pdf, kap. 5.2:
//   - podepisuje se JEN <soap:Body> (nic jiného, žádné Timestamp apod.)
//   - kanonizace: Exclusive C14N (http://www.w3.org/2001/10/xml-exc-c14n#)
//   - digest: SHA-256 (http://www.w3.org/2001/04/xmlenc#sha256)
//   - podpis: RSA-SHA256 (http://www.w3.org/2001/04/xmldsig-more#rsa-sha256)
//   - certifikát je v BinarySecurityToken (X509v3/Base64Binary), podpis na
//     něj odkazuje standardní referencí (SecurityTokenReference), ne tím,
//     že by X509Certificate byl vložen přímo do KeyInfo
//
// DŮLEŽITÉ OMEZENÍ (dle zadání): tento modul NIKDY nepracuje se skutečným
// produkčním certifikátem ani ho nikam neukládá. Jediný certifikát, se
// kterým se v tomhle kroku reálně pracuje, je `vytvoritTestovaciKlic()` —
// čerstvě vygenerovaný, nepoužitelný "self-signed" klíč/certifikát, který se
// píše VÝHRADNĚ do OS temp adresáře MIMO git repozitář a po testu se maže.
// Žádný .pem/.key/.p12 soubor se tímto modulem neukládá do projektu.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { SignedXml } = require('xml-crypto');
const { pemNaBase64Der } = require('./soap-obalka');

const ALG = {
  podpis: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  kanonizace: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  digest: 'http://www.w3.org/2001/04/xmlenc#sha256'
};

// Vlastní obsah <KeyInfo> — odkaz na BinarySecurityToken referencí (WS-Security
// X.509 Direct Reference profil), ne vložení certifikátu přímo do KeyInfo.
function sestavitKeyInfoContent(bstId) {
  return (
    `<wsse:SecurityTokenReference xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">` +
    `<wsse:Reference URI="#${bstId}" ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"/>` +
    `</wsse:SecurityTokenReference>`
  );
}

// Ověří, že privateKeyPem skutečně patří k certificatePem — bez tohohle by
// šlo nechtěně podepsat obálku JINÝM klíčem, než jaký je uveden v jejím
// BinarySecurityToken, a výsledná zpráva by při doručení finanční správě
// (nebo v našem vlastním overitPodpisObalky) vždy spadla na neplatném
// podpisu — chceme tuhle chybu konfigurace odhalit HNED, ne až při pokusu
// o odeslání. Čistě matematická kontrola (podpis/ověření nad náhodnými
// daty), nemá nic společného s XML ani se sítí.
function overitShoduKlicACertifikatu(privateKeyPem, certificatePem) {
  const testovaciData = crypto.randomBytes(32);
  let podpis;
  try {
    podpis = crypto.sign('sha256', testovaciData, privateKeyPem);
  } catch (e) {
    throw new Error(`privateKeyPem se nepodařilo použít k podpisu (neplatný formát klíče?): ${e.message}`);
  }
  let verejnyKlic;
  try {
    verejnyKlic = new crypto.X509Certificate(certificatePem).publicKey;
  } catch (e) {
    throw new Error(`certificatePem se nepodařilo zpracovat jako X.509 certifikát: ${e.message}`);
  }
  const shoda = crypto.verify('sha256', testovaciData, verejnyKlic, podpis);
  if (!shoda) {
    throw new Error('privateKeyPem neodpovídá veřejnému klíči v certificatePem — podepsání by vytvořilo trvale neplatnou zprávu.');
  }
}

// Podepíše NEPODEPSANOU SOAP obálku (ze soap-obalka.js) — podepisuje se jen
// <soap:Body> (element s wsu:Id=bodyId), podpis se vloží do <wsse:Security>.
// "privateKeyPem"/"certificatePem" dostává volající zvenčí (env proměnná,
// soubor mimo repo, HSM...) — tento modul si je nikdy nenačítá sám z pevné
// cesty v projektu, aby nehrozilo omylem je zapsat/commitnout.
//
// "certificatePem" MUSÍ být tentýž certifikát, který je už v obálce uložen
// jako BinarySecurityToken (soap-obalka.js) — ověřujeme to na dvou úrovních:
// (1) že BST s daným bstId v obálce vůbec existuje, (2) že privateKeyPem k
// němu matematicky patří (overitShoduKlicACertifikatu výš). Bez téhle
// kontroly by šlo omylem podepsat obálku klíčem, který nepatří k
// certifikátu, jenž je v ní vložený — výsledek by vypadal jako platně
// podepsaná zpráva, ale ověření (u finanční správy i u nás) by vždy selhalo.
function podepsatObalku(nepodepsanaObalkaXml, { privateKeyPem, certificatePem, bstId = 'X509Token', bodyId = 'Body' }) {
  if (!privateKeyPem) {
    throw new Error('Chybí privateKeyPem — bez něj se nedá nic podepsat (a to je záměrně vyžadováno explicitně, ne implicitně z disku).');
  }
  if (!certificatePem) {
    throw new Error('Chybí certificatePem — bez něj nelze ověřit, že podepisujeme klíčem patřícím k certifikátu v obálce.');
  }
  if (!nepodepsanaObalkaXml.includes(`wsu:Id="${bstId}"`)) {
    throw new Error(`Obálka neobsahuje BinarySecurityToken s wsu:Id="${bstId}" — podepsat bez něj by vytvořilo odkaz na neexistující element.`);
  }
  overitShoduKlicACertifikatu(privateKeyPem, certificatePem);
  const sig = new SignedXml({
    privateKey: privateKeyPem,
    signatureAlgorithm: ALG.podpis,
    canonicalizationAlgorithm: ALG.kanonizace,
    getKeyInfoContent: () => sestavitKeyInfoContent(bstId)
  });
  sig.addReference({
    xpath: `//*[local-name(.)='Body']`,
    digestAlgorithm: ALG.digest,
    transforms: [ALG.kanonizace]
  });
  sig.computeSignature(nepodepsanaObalkaXml, {
    location: { reference: `//*[local-name(.)='Security']`, action: 'append' }
  });
  return sig.getSignedXml();
}

// Ověří podpis podepsané obálky (pro test round-tripu signing→verify).
function overitPodpisObalky(podepsanaObalkaXml, { certificatePem }) {
  const { DOMParser } = require('@xmldom/xmldom');
  const xpath = require('xpath');
  const doc = new DOMParser().parseFromString(podepsanaObalkaXml, 'text/xml');
  const signatureNode = xpath.select1(
    "//*[local-name(.)='Signature' and namespace-uri(.)='http://www.w3.org/2000/09/xmldsig#']",
    doc
  );
  if (!signatureNode) {
    return { valid: false, duvod: 'V dokumentu nebyl nalezen žádný <Signature> element.' };
  }
  const sig = new SignedXml({ publicCert: certificatePem });
  sig.loadSignature(signatureNode);
  // checkSignature u neplatného podpisu/certifikátu v této verzi xml-crypto
  // VYHAZUJE výjimku (nevrací jen false) — zachytáváme ji a převádíme na
  // stejný tvar výsledku jako u úspěchu, ať to volající nemusí řešit dvěma
  // různými způsoby (try/catch i návratová hodnota).
  try {
    const valid = sig.checkSignature(podepsanaObalkaXml);
    return { valid, duvod: valid ? null : 'Podpis se nepotvrdil proti danému certifikátu.' };
  } catch (e) {
    return { valid: false, duvod: e.message };
  }
}

// POUZE PRO TESTY. Vygeneruje čerstvý, nijak důvěryhodný self-signed
// klíč+certifikát (RSA 2048, SHA-256, CN=testovací EIČ) do nového OS temp
// adresáře (fs.mkdtempSync — MIMO git repozitář). Volající MUSÍ zavolat
// vrácenou funkci cleanup() po použití. Vyžaduje openssl v PATH (stejně
// jako zbytek projektu už používá pro zálohy produkční DB).
function vytvoritTestovaciKlic({ eic = 'CZ00000019' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eet-test-cert-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-nodes', '-subj', `/C=CZ/CN=${eic}`
    ], { stdio: 'pipe' });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Nepodařilo se vygenerovat testovací certifikát (je "openssl" v PATH?): ${e.message}`);
  }
  const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
  const certificatePem = fs.readFileSync(certPath, 'utf8');
  // Klíč v paměti procesu smažeme z disku hned po načtení — i jako testovací
  // artefakt nemá důvod přežívat na disku déle, než je nutné.
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    privateKeyPem,
    certificatePem,
    certificateDerBase64: pemNaBase64Der(certificatePem)
  };
}

module.exports = { ALG, podepsatObalku, overitPodpisObalky, overitShoduKlicACertifikatu, vytvoritTestovaciKlic };
