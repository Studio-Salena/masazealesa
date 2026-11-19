// CLI spouštěč pro tests/helpers/mock-eet-server.js — pro end-to-end test,
// kde "server.js" běží jako SAMOSTATNÝ proces (potřebuje adresu mocku v
// prostředí ještě PŘED startem), ne jako import v tomtéž testovacím procesu.
// Čte volitelně EET_MOCK_SIGN_CERT_PEM/EET_MOCK_SIGN_KEY_PEM (cesty k
// souborům) — pokud jsou nastavené, odpovědi mocku se skutečně podepisují.
// Vypíše "MOCK_URL=<adresa>" na stdout a zůstává běžet, dokud není ukončen.
const fs = require('fs');
const { spustitMockEetServer } = require('./mock-eet-server');

(async () => {
  let podepisovatOdpovedi = null;
  if (process.env.EET_MOCK_SIGN_CERT_PEM && process.env.EET_MOCK_SIGN_KEY_PEM) {
    podepisovatOdpovedi = {
      certificatePem: fs.readFileSync(process.env.EET_MOCK_SIGN_CERT_PEM, 'utf8'),
      privateKeyPem: fs.readFileSync(process.env.EET_MOCK_SIGN_KEY_PEM, 'utf8')
    };
  }
  const mock = await spustitMockEetServer({ podepisovatOdpovedi });
  console.log(`MOCK_URL=${mock.url}`);
})();
