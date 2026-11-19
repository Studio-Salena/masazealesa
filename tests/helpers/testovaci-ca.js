// POUZE PRO TESTY. Vygeneruje čerstvou, nijak důvěryhodnou dvojici
// "root CA" + "leaf certifikát vydaný touto CA" do nového OS temp adresáře
// (MIMO git repozitář), pro testování eet/overeni-odpovedi-fs.js (ověření
// podpisu ODPOVĚDI proti důvěryhodné kotvě). Analogie k
// eet/podpis.js:vytvoritTestovaciKlic(), jen o úroveň hlubší (potřebujeme
// root → leaf, ne jen samopodepsaný list). Volající MUSÍ zavolat cleanup().
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// "leafNotAfter"/"leafNotBefore" (nepovinné, Date) — pro testování platnosti
// certifikátu (eet/overeni-odpovedi-fs.js): nastaví konec/začátek platnosti
// LEAF certifikátu na konkrétní okamžik (např. v minulosti, aby šlo
// otestovat odmítnutí již PROŠLÉHO certifikátu), místo výchozího "1 den od
// teď".
function opensslCas(d) {
  // formát openssl -not_after/-not_before: YYYYMMDDHHMMSSZ (vždy UTC)
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '');
}

function vytvoritTestovaciCaARetezec({ cnRoot = 'TEST Root CA (NEdůvěryhodná)', cnLeaf = 'TEST FS Response Signer', leafNotAfter = null, leafNotBefore = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eet-test-ca-'));
  const rootKey = path.join(dir, 'root-key.pem');
  const rootCert = path.join(dir, 'root-cert.pem');
  const leafKey = path.join(dir, 'leaf-key.pem');
  const leafCsr = path.join(dir, 'leaf.csr');
  const leafCert = path.join(dir, 'leaf-cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', rootKey, '-out', rootCert,
      '-days', '1', '-nodes', '-subj', `/CN=${cnRoot}`
    ], { stdio: 'pipe' });
    execFileSync('openssl', [
      'req', '-newkey', 'rsa:2048', '-keyout', leafKey, '-out', leafCsr,
      '-nodes', '-subj', `/CN=${cnLeaf}`
    ], { stdio: 'pipe' });
    const leafArgs = ['x509', '-req', '-in', leafCsr, '-CA', rootCert, '-CAkey', rootKey, '-CAcreateserial', '-out', leafCert, '-sha256'];
    if (leafNotAfter) {
      leafArgs.push('-not_after', opensslCas(leafNotAfter));
      leafArgs.push('-not_before', opensslCas(leafNotBefore || new Date(leafNotAfter.getTime() - 86400000)));
    } else {
      leafArgs.push('-days', '1');
    }
    execFileSync('openssl', leafArgs, { stdio: 'pipe' });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Nepodařilo se vygenerovat testovací CA/leaf (je "openssl" v PATH?): ${e.message}`);
  }
  const vysledek = {
    kotvaPem: fs.readFileSync(rootCert, 'utf8'),
    leafCertificatePem: fs.readFileSync(leafCert, 'utf8'),
    leafPrivateKeyPem: fs.readFileSync(leafKey, 'utf8')
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return vysledek;
}

module.exports = { vytvoritTestovaciCaARetezec };
