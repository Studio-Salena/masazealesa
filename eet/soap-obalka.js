// Sestavení SOAP obálky okolo <tns:Trzba> podle kap. 5 technické specifikace
// (EET_popis_rozhrani_v1.2.pdf): WS-Security hlavička s BinarySecurityToken
// (X509v3/Base64Binary), podpis odkazující na <soap:Body> přes wsu:Id.
// Tento modul SÁM O SOBĚ nic nepodepisuje (to dělá podpis.js) — jen sestaví
// nepodepsanou kostru, do které podpis.js vloží <Signature> na správné místo.
const NS = {
  soap: 'http://schemas.xmlsoap.org/soap/envelope/',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  x509v3: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3',
  base64bin: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary'
};

// Base64 DER (bez PEM hlaviček/zalomení řádků) — formát, ve kterém WS-Security
// BinarySecurityToken certifikát vyžaduje.
function pemNaBase64Der(certPem) {
  return certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
}

// Opak pemNaBase64Der výš — z holého base64 DER (jak je uložen v
// BinarySecurityToken) složí standardní PEM s hlavičkami a zalomením na 64
// znaků (vyžaduje to crypto.X509Certificate i xml-crypto). Používá to jen
// přijímací/testovací strana (mock server), ne samotné podepisování.
function base64DerNaPem(base64Der) {
  const radky = base64Der.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${radky.join('\n')}\n-----END CERTIFICATE-----\n`;
}

// Vytáhne base64 DER obsah <wsse:BinarySecurityToken> ze SOAP obálky.
function extrahovatBstBase64Der(soapXml, bstId = 'X509Token') {
  const shoda = soapXml.match(new RegExp(`<wsse:BinarySecurityToken[^>]*wsu:Id="${bstId}"[^>]*>([^<]+)</wsse:BinarySecurityToken>`));
  return shoda ? shoda[1] : null;
}

// bstId/bodyId: hodnoty atributu wsu:Id — výchozí "X509Token"/"Body" jsou
// jen konvence téhle implementace, spec konkrétní jména nepředepisuje (jde o
// "relativní odkaz v rámci SOAP zprávy").
function sestavitNepodepsanouObalku(trzbaXml, { certificatePem = null, bstId = 'X509Token', bodyId = 'Body' } = {}) {
  const bst = certificatePem
    ? `<wsse:BinarySecurityToken wsu:Id="${bstId}" ValueType="${NS.x509v3}" EncodingType="${NS.base64bin}">${pemNaBase64Der(certificatePem)}</wsse:BinarySecurityToken>`
    : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="${NS.soap}" xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}">` +
    `<soapenv:Header>` +
    `<wsse:Security soapenv:mustUnderstand="1">${bst}</wsse:Security>` +
    `</soapenv:Header>` +
    `<soapenv:Body wsu:Id="${bodyId}">${trzbaXml}</soapenv:Body>` +
    `</soapenv:Envelope>`
  );
}

// Vytáhne zpět jen <tns:Trzba> fragment ze SOAP obálky (pro samostatnou XSD
// validaci business obsahu nezávisle na SOAP/WS-Security vrstvě).
function extrahovatTrzbu(soapXml) {
  const shoda = soapXml.match(/<tns:Trzba[^]*?<\/tns:Trzba>/);
  if (!shoda) {
    throw new Error('V SOAP obálce nebyl nalezen element <tns:Trzba>.');
  }
  return shoda[0];
}

module.exports = { NS, pemNaBase64Der, base64DerNaPem, extrahovatBstBase64Der, sestavitNepodepsanouObalku, extrahovatTrzbu };
