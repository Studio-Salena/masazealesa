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

function vytvoritTestovaciCaARetezec({ cnRoot = 'TEST Root CA (NEdůvěryhodná)', cnLeaf = 'TEST FS Response Signer' } = {}) {
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
    execFileSync('openssl', [
      'x509', '-req', '-in', leafCsr, '-CA', rootCert, '-CAkey', rootKey, '-CAcreateserial',
      '-out', leafCert, '-days', '1', '-sha256'
    ], { stdio: 'pipe' });
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
