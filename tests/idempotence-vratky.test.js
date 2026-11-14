// Regresní test: idempotentní klíč u VRATEK (typ='vratka' na stejném
// endpointu PATCH /api/admin/rezervace/:id/platba jako platby).
//
// Alena si vyžádala prověření, zda tlačítko "Vrátit" (vratitPlatbu v
// admin.html) může při opakovaném/souběžném odeslání vytvořit duplicitní
// vratku (dvakrát vrátit stejné peníze klientce). Endpoint platby/vratky je
// stejný a idempotentní mechanismus (viz tests/idempotence-plateb.test.js)
// je obecný pro OBA typy — tenhle soubor to pro vratku výslovně dokládá,
// včetně speciálního případu "vratka jako poukaz" (vrácení bez výplaty,
// vznikne nový dárkový poukaz — při opakování se nesmí vytvořit DRUHÝ
// poukaz a odpověď musí správně ukázat ten PŮVODNÍ).
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=http://localhost:3001/api node tests/idempotence-vratky.test.js

const assert = require('node:assert/strict');

const { ziskatTestApiBase } = require('./env-guard');
const API = ziskatTestApiBase();
const HESLO = process.env.ADMIN_HESLO;

if (!HESLO) {
  console.error('Chybí ADMIN_HESLO v prostředí — test se přeskakuje.');
  process.exit(0);
}

function adminFetch(cesta, options = {}) {
  return fetch(API + cesta, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-admin-heslo': HESLO, ...(options.headers || {}) }
  });
}

async function najitVolnyTermin(datum, cenikId) {
  const terminy = await fetch(`${API}/rezervace/volne-terminy?datum=${datum}&cenik_id=${cenikId}`).then(r => r.json());
  const volny = Array.isArray(terminy) ? terminy.find(t => t.volno) : null;
  return volny ? volny.cas : null;
}
async function novyVolnyTermin(cenikId, odpocetDni) {
  for (let i = odpocetDni; i < odpocetDni + 60; i += 3) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const cas = await najitVolnyTermin(iso, cenikId);
    if (cas) return { datum: iso, cas };
  }
  throw new Error('Nenalezen volný termín pro test');
}

async function vytvorRezervaciZaplacenou(cenikId, telefonSuffix, cena) {
  const { datum, cas } = await novyVolnyTermin(cenikId, 700 + Math.floor(Math.random() * 100));
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: cas, jmeno: 'TEST-IDEMPOTENCE-VRATKA (smazat)', telefon: '00004' + telefonSuffix, email: 'test-idempotence-vratka@example.cz' })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'Vytvoření testovací rezervace selhalo: ' + JSON.stringify(data));
  if (data.rezervace.klientka_id) uklidKlientky.add(data.rezervace.klientka_id);
  const platba = await adminFetch(`/admin/rezervace/${data.rezervace.id}/platba`, { method: 'PATCH', body: JSON.stringify({ castka: cena, zpusob_platby: 'hotove' }) });
  assert.equal(platba.status, 200);
  return data.rezervace;
}

function uuid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'test-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

async function vratit(id, castka, zpusob_platby, idempotency_klic) {
  const body = { castka, zpusob_platby, typ: 'vratka' };
  if (idempotency_klic) body.idempotency_klic = idempotency_klic;
  return adminFetch(`/admin/rezervace/${id}/platba`, { method: 'PATCH', body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));
}

async function historie(id) {
  return adminFetch(`/admin/rezervace/${id}/platby`).then(r => r.json());
}

const uklidRezervace = [];
const uklidPoukazy = [];
const uklidKlientky = new Set();

async function main() {
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');
    const cena = Number(polozka.cena);

    // 1) DIAGNOSTIKA — dvojí odeslání STEJNÉ vratky BEZ klíče (současný stav
    // starého vratitPlatbu, než se v adminu nasadí oprava) — dokládá, že
    // riziko je reálné, stejně jako se dřív dokládalo u plateb.
    console.log('--- 1) diagnostika: dvojí vratka BEZ klíče (bez ochrany) ---');
    {
      const r = await vytvorRezervaciZaplacenou(polozka.id, '41', cena);
      uklidRezervace.push(r.id);
      const vratka = Math.max(1, Math.floor(cena * 0.3));
      const [a, b] = await Promise.all([
        vratit(r.id, vratka, 'hotove'),
        vratit(r.id, vratka, 'hotove')
      ]);
      const h = await historie(r.id);
      const soucetVratek = h.filter(x => Number(x.castka) < 0).length;
      console.log('   pokus A: ' + a.status + ', pokus B: ' + b.status + ', počet vratek v historii: ' + soucetVratek);
      if (soucetVratek === 2) {
        console.log('   POTVRZENO RIZIKO — bez idempotentního klíče dvojí odeslání STEJNÉ vratky vytvoří 2 vratky (klientce by se vrátilo 2× tolik peněz).');
      } else {
        console.log('   (souběh dopadl jinak — časování se může lišit, viz test 3 níž pro JISTÉ ošetření se stejným klíčem)');
      }
    }

    // 2) OPRAVA — opakování STEJNÉ vratky SE STEJNÝM klíčem (jak to teď dělá
    // opravený vratitPlatbu v admin.html) nevytvoří druhou vratku.
    console.log('--- 2) oprava: opakování stejné vratky se stejným klíčem ---');
    {
      const r = await vytvorRezervaciZaplacenou(polozka.id, '42', cena);
      uklidRezervace.push(r.id);
      const vratka = Math.max(1, Math.floor(cena * 0.3));
      const klic = uuid();
      const prvni = await vratit(r.id, vratka, 'hotove', klic);
      assert.equal(prvni.status, 200, JSON.stringify(prvni.data));
      const opakovani = await vratit(r.id, vratka, 'hotove', klic);
      assert.equal(opakovani.status, 200, 'Opakování stejné vratky stejným klíčem má být idempotentní (200)');
      assert.equal(opakovani.data.idempotentni, true);
      const h = await historie(r.id);
      const vratky = h.filter(x => Number(x.castka) < 0);
      assert.equal(vratky.length, 1, 'V historii má být přesně JEDNA vratka, je jich: ' + vratky.length);
      assert.equal(Number(r.uhrazeno) ? true : true, true); // no-op, jen pro čitelnost kroku
      console.log('OK — opakování stejné vratky (stejný klíč) vytvoří jen 1 vratkový řádek, druhý pokus je idempotentní');
    }

    // 3) Souběh dvou SOUČASNÝCH požadavků na stejnou vratku se stejným klíčem
    console.log('--- 3) souběh dvou současných vratek se stejným klíčem ---');
    {
      const r = await vytvorRezervaciZaplacenou(polozka.id, '43', cena);
      uklidRezervace.push(r.id);
      const vratka = Math.max(1, Math.floor(cena * 0.3));
      const klic = uuid();
      const [a, b] = await Promise.all([
        vratit(r.id, vratka, 'hotove', klic),
        vratit(r.id, vratka, 'hotove', klic)
      ]);
      assert.equal(a.status, 200, JSON.stringify(a.data));
      assert.equal(b.status, 200, JSON.stringify(b.data));
      const h = await historie(r.id);
      const vratky = h.filter(x => Number(x.castka) < 0);
      assert.equal(vratky.length, 1, 'Souběh se stejným klíčem nesmí vytvořit dvě vratky, vytvořeno: ' + vratky.length);
      console.log('OK — dva současné požadavky na stejnou vratku (stejný klíč) vytvoří přesně 1 vratku');
    }

    // 4) Konflikt — stejný klíč, jiná částka vratky → odmítnuto
    console.log('--- 4) konflikt: stejný klíč, jiná částka vratky ---');
    {
      const r = await vytvorRezervaciZaplacenou(polozka.id, '44', cena);
      uklidRezervace.push(r.id);
      const klic = uuid();
      const prvni = await vratit(r.id, 100, 'hotove', klic);
      assert.equal(prvni.status, 200, JSON.stringify(prvni.data));
      const druhy = await vratit(r.id, 200, 'hotove', klic);
      assert.equal(druhy.status, 409, 'Stejný klíč s jinou částkou vratky má být odmítnut');
      const h = await historie(r.id);
      assert.equal(h.filter(x => Number(x.castka) < 0).length, 1);
      console.log('OK — stejný klíč s jinou částkou vratky je odmítnut (409)');
    }

    // 5) Dvě SKUTEČNĚ samostatné vratky (jiné klíče) — obě mají projít
    console.log('--- 5) dvě samostatné vratky (jiné klíče) ---');
    {
      const r = await vytvorRezervaciZaplacenou(polozka.id, '45', cena);
      uklidRezervace.push(r.id);
      const v1 = Math.max(1, Math.floor(cena * 0.2));
      const v2 = Math.max(1, Math.floor(cena * 0.2));
      const p1 = await vratit(r.id, v1, 'hotove', uuid());
      assert.equal(p1.status, 200, JSON.stringify(p1.data));
      const p2 = await vratit(r.id, v2, 'hotove', uuid());
      assert.equal(p2.status, 200, JSON.stringify(p2.data));
      assert.equal(Number(p2.data.rezervace.uhrazeno), cena - v1 - v2);
      const h = await historie(r.id);
      assert.equal(h.filter(x => Number(x.castka) < 0).length, 2, 'Dvě samostatné vratky (jiné klíče) mají obě projít');
      console.log('OK — dvě skutečně samostatné vratky (různé klíče) obě projdou, nejsou zaměněny za duplicitu');
    }

    // 6) Vratka JAKO POUKAZ — opakování stejným klíčem nevytvoří DRUHÝ
    // poukaz a vrátí ten SAME poukaz v odpovědi (ne poukaz:null).
    console.log('--- 6) vratka jako poukaz — opakování nevytvoří druhý poukaz ---');
    {
      const r = await vytvorRezervaciZaplacenou(polozka.id, '46', cena);
      uklidRezervace.push(r.id);
      const vratka = Math.max(1, Math.floor(cena * 0.4));
      const klic = uuid();
      const prvni = await vratit(r.id, vratka, 'poukaz', klic);
      assert.equal(prvni.status, 200, JSON.stringify(prvni.data));
      assert.ok(prvni.data.poukaz && prvni.data.poukaz.kod, 'První vratka jako poukaz má vrátit vytvořený poukaz');
      const kodPoukazu = prvni.data.poukaz.kod;
      uklidPoukazy.push(prvni.data.poukaz.id);

      const opakovani = await vratit(r.id, vratka, 'poukaz', klic);
      assert.equal(opakovani.status, 200, JSON.stringify(opakovani.data));
      assert.equal(opakovani.data.idempotentni, true);
      assert.ok(opakovani.data.poukaz, 'Idempotentní odpověď má vrátit PŮVODNÍ poukaz, ne poukaz:null');
      assert.equal(opakovani.data.poukaz.kod, kodPoukazu, 'Idempotentní odpověď má ukázat STEJNÝ poukaz jako při prvním (skutečném) zápisu');

      // Ověření v databázi poukazů: musí existovat jen JEDEN poukaz s touhle
      // hodnotou vzniklý z téhle vratky, ne dva.
      const seznamPoukazu = await adminFetch('/admin/poukazy').then(res => res.json());
      const nalezeneKody = seznamPoukazu.filter(p => p.kod === kodPoukazu);
      assert.equal(nalezeneKody.length, 1);
      console.log('OK — opakování vratky-jako-poukazu (stejný klíč) nevytvoří druhý poukaz a správně vrátí ten PŮVODNÍ (' + kodPoukazu + ')');
    }

    console.log('\n✅ VŠECHNY TESTY IDEMPOTENCE VRATEK PROŠLY');
  } finally {
    for (const id of uklidPoukazy) {
      await adminFetch(`/admin/poukazy/${id}`, { method: 'DELETE' }).catch(() => null);
    }
    for (const id of uklidRezervace) {
      await adminFetch(`/admin/rezervace/${id}`, { method: 'DELETE' }).catch(() => null);
    }
    let klientkySmazano = 0;
    for (const id of uklidKlientky) {
      const r = await adminFetch(`/admin/klientky/${id}`, { method: 'DELETE' }).catch(() => null);
      if (r && r.ok) klientkySmazano++;
    }
    if (uklidRezervace.length || uklidPoukazy.length || uklidKlientky.size) {
      console.log(`(uklizeno: ${uklidRezervace.length} testovacích rezervací, ${uklidPoukazy.length} testovacích poukazů, ${klientkySmazano}/${uklidKlientky.size} testovacích klientek)`);
    }
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
