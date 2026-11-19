// Krok 3d — jednotkové testy pro overitOverovaciOdpoved() (eet/odpoved-parser.js).
// Nezávislé na síti i na certifikátu — pracuje jen s připravenými (mock)
// odpověďmi, aby šlo samotnou kontrolní logiku ověřit ještě PŘED tím, než
// přijde skutečná odpověď z Playgroundu.
//
// Spuštění:  node tests/eet-krok3d-validace-odpovedi.test.js
const assert = require('node:assert/strict');
const { rozebratOdpoved, overitOverovaciOdpoved } = require('../eet/odpoved-parser');

const UUID = '93f6c1f9-4c5c-4b1b-9c98-bf9a0a3884f1';
const JINE_UUID = '00000000-0000-4000-8000-000000000000';

function potvrzeni({ uuid = UUID, pok = 'b3a09b52-7c87-4014-a496-4c7a53cf9125-ff', test = 'true' } = {}) {
  return rozebratOdpoved(
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:eet="http://fs.gov.cz/eet/schema/v4">` +
    `<soapenv:Body><eet:Odpoved><eet:Hlavicka uuid_zpravy="${uuid}" dat_prij="2026-11-19T22:00:00+01:00"/>` +
    `<eet:Potvrzeni pok="${pok}" test="${test}"/></eet:Odpoved></soapenv:Body></soapenv:Envelope>`
  );
}

function chyba({ uuid = UUID, kod = 4, test = 'true' } = {}) {
  return rozebratOdpoved(
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:eet="http://fs.gov.cz/eet/schema/v4">` +
    `<soapenv:Body><eet:Odpoved><eet:Hlavicka uuid_zpravy="${uuid}" dat_odmit="2026-11-19T22:00:00+01:00"/>` +
    `<eet:Chyba kod="${kod}" test="${test}">neplatny podpis</eet:Chyba></eet:Odpoved></soapenv:Body></soapenv:Envelope>`
  );
}

function main() {
  console.log('--- Krok 3d: jednotkové testy validace očekávané odpovědi (overeni=false) ---');

  assert.equal(overitOverovaciOdpoved(potvrzeni(), { uuidZpravyOdeslane: UUID }).ok, true);
  console.log('OK 1 — platná odpověď (potvrzeni, test=true, POK -ff, shoda uuid) je přijata');

  const r2 = overitOverovaciOdpoved(chyba(), { uuidZpravyOdeslane: UUID });
  assert.equal(r2.ok, false);
  assert.ok(r2.duvody.some((d) => d.includes('chyba')));
  console.log('OK 2 — chybová odpověď (ne POK) je odmítnuta');

  const r3 = overitOverovaciOdpoved(potvrzeni({ test: 'false' }), { uuidZpravyOdeslane: UUID });
  assert.equal(r3.ok, false);
  assert.ok(r3.duvody.some((d) => d.includes('test=true')));
  console.log('OK 3 — odpověď bez test=true je odmítnuta (i kdyby byla jinak validní)');

  const r4 = overitOverovaciOdpoved(potvrzeni({ uuid: JINE_UUID }), { uuidZpravyOdeslane: UUID });
  assert.equal(r4.ok, false);
  assert.ok(r4.duvody.some((d) => d.includes('uuid_zpravy')));
  console.log('OK 4 — odpověď s cizím uuid_zpravy (nesprávné přiřazení) je odmítnuta');

  const r5 = overitOverovaciOdpoved(potvrzeni({ pok: 'nejaky-pok-bez-spravne-koncovky' }), { uuidZpravyOdeslane: UUID });
  assert.equal(r5.ok, false);
  assert.ok(r5.duvody.some((d) => d.includes('-ff')));
  console.log('OK 5 — POK, který nekončí "-ff", je na neprodukčním prostředí odmítnut');

  const r6 = overitOverovaciOdpoved(potvrzeni(), { uuidZpravyOdeslane: undefined });
  assert.equal(r6.ok, false);
  console.log('OK 6 — bez známého odeslaného uuid_zpravy nelze přiřazení potvrdit (odmítnuto)');

  console.log('\n✅ VŠECHNY TESTY VALIDACE OČEKÁVANÉ ODPOVĚDI PROŠLY');
}

main();
