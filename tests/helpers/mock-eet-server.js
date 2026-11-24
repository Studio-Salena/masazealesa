// Lokální MOCK server pro ofline testování HTTP vrstvy EET klienta
// (eet/playground-klient.js) — NENÍ Playground, NENÍ Finanční správa, běží
// VÝHRADNĚ na 127.0.0.1 na portu, který si OS zvolí sám. Napodobuje tvar
// odpovědí systému EET tím, že na přijatou zprávu skutečně aplikuje stejné
// kontroly, jaké popisuje specifikace (XSD validace přes eet/xsd-validace.js,
// ověření podpisu přes eet/podpis.js) — není to tedy jen "echo", ale reálné
// (byť lokální) ověření toho, co klient odeslal.
//
// Marker pro simulaci timeoutu: pokud odeslaná tržba má porad_cis
// "MOCK-TIMEOUT", server odpověď NIKDY nepošle (test musí mít krátký
// klientský timeoutMs, aby test neběžel zbytečně dlouho).
const http = require('node:http');
const { validovatProtiXsd } = require('../../eet/xsd-validace');
const { extrahovatTrzbu, extrahovatBstBase64Der, base64DerNaPem, sestavitNepodepsanouObalku } = require('../../eet/soap-obalka');
const { overitPodpisObalky, podepsatObalku } = require('../../eet/podpis');
const { vygenerovatFiktivniPok, CHYBOVE_KODY } = require('../../eet/simulator');

// "podepisovatOdpovedi" (nepovinné, Krok 3d): { certificatePem, privateKeyPem }
// — pokud dodáno, mock server odpovědi skutečně XML-DSig podepíše (stejným
// eet/podpis.js jako naše odchozí zprávy), aby šlo testovat
// eet/overeni-odpovedi-fs.js na opravdu podepsané odpovědi. Bez tohoto
// parametru (výchozí, zpětně kompatibilní se všemi staršími testy) odpovědi
// zůstávají nepodepsané, přesně jako dřív (jen prostý SOAP XML).
function obalitOdpoved(odpovedFragmentXml, podepisovatOdpovedi) {
  if (!podepisovatOdpovedi) {
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
      `<soapenv:Body>${odpovedFragmentXml}</soapenv:Body></soapenv:Envelope>`
    );
  }
  const { certificatePem, privateKeyPem } = podepisovatOdpovedi;
  const nepodepsana = sestavitNepodepsanouObalku(odpovedFragmentXml, { certificatePem });
  return podepsatObalku(nepodepsana, { privateKeyPem, certificatePem });
}

function sestavitPotvrzeniXml(uuidZpravy, podepisovatOdpovedi) {
  const fragment = (
    `<tns:Odpoved xmlns:tns="http://fs.gov.cz/eet/schema/v4">` +
    `<tns:Hlavicka uuid_zpravy="${uuidZpravy}" dat_prij="${new Date().toISOString()}"/>` +
    `<tns:Potvrzeni pok="${vygenerovatFiktivniPok()}" test="true"/>` +
    `</tns:Odpoved>`
  );
  return obalitOdpoved(fragment, podepisovatOdpovedi);
}

function sestavitChybaXml(uuidZpravy, kod, text, podepisovatOdpovedi) {
  const fragment = (
    `<tns:Odpoved xmlns:tns="http://fs.gov.cz/eet/schema/v4">` +
    `<tns:Hlavicka ${uuidZpravy ? `uuid_zpravy="${uuidZpravy}"` : ''} dat_odmit="${new Date().toISOString()}"/>` +
    `<tns:Chyba kod="${kod}" test="true">${text}</tns:Chyba>` +
    `</tns:Odpoved>`
  );
  return obalitOdpoved(fragment, podepisovatOdpovedi);
}

function ziskatUuidZpravy(soapXml) {
  const m = soapXml.match(/uuid_zpravy="([^"]+)"/);
  return m ? m[1] : null;
}

async function obsluhaPozadavku(req, res, podepisovatOdpovedi, predKazdymPozadavkem) {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  // Nepovinný test-only hák (Krok 3d — ověření přepínačů uprostřed dávky):
  // zavolá se PŘED zpracováním KAŽDÉHO požadavku, čistě pro deterministické
  // řízení pořadí v testu (např. "mezi prvním a druhým řádkem dávky změň
  // nastavení v DB"), žádný vliv na produkční chování.
  if (predKazdymPozadavkem) await predKazdymPozadavkem();
  const kusy = [];
  for await (const kus of req) kusy.push(kus);
  const telo = Buffer.concat(kusy).toString('utf8');
  const uuidZpravy = ziskatUuidZpravy(telo);

  if (/porad_cis="[^"]*MOCK-TIMEOUT[^"]*"/.test(telo)) {
    // Nikdy neodpovíme — klient musí vyhodnotit timeout sám (AbortController).
    return;
  }

  let trzbaXml;
  try {
    trzbaXml = extrahovatTrzbu(telo);
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    res.end(sestavitChybaXml(uuidZpravy, CHYBOVE_KODY.XSD.kod, CHYBOVE_KODY.XSD.text, podepisovatOdpovedi));
    return;
  }

  const xsdVysledek = await validovatProtiXsd(trzbaXml);
  if (!xsdVysledek.valid) {
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    res.end(sestavitChybaXml(uuidZpravy, CHYBOVE_KODY.XSD.kod, CHYBOVE_KODY.XSD.text, podepisovatOdpovedi));
    return;
  }

  const bstBase64 = extrahovatBstBase64Der(telo);
  if (!bstBase64) {
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    res.end(sestavitChybaXml(uuidZpravy, CHYBOVE_KODY.PODPIS.kod, CHYBOVE_KODY.PODPIS.text, podepisovatOdpovedi));
    return;
  }
  const certificatePem = base64DerNaPem(bstBase64);
  const overeniPodpisu = overitPodpisObalky(telo, { certificatePem });
  if (!overeniPodpisu.valid) {
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    res.end(sestavitChybaXml(uuidZpravy, CHYBOVE_KODY.PODPIS.kod, CHYBOVE_KODY.PODPIS.text, podepisovatOdpovedi));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
  res.end(sestavitPotvrzeniXml(uuidZpravy, podepisovatOdpovedi));
}

function spustitMockEetServer({ podepisovatOdpovedi = null, predKazdymPozadavkem = null } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      obsluhaPozadavku(req, res, podepisovatOdpovedi, predKazdymPozadavkem).catch((e) => {
        res.writeHead(500).end(String(e));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/eet/services/EETServiceSOAP/v4`,
        zastavit: () => new Promise((r) => server.close(r))
      });
    });
  });
}

module.exports = { spustitMockEetServer };
