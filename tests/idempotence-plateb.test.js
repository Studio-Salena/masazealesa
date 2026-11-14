// Regresní test: idempotentní klíč u PATCH /api/admin/rezervace/:id/platba
// (ochrana proti duplicitnímu zápisu při opakování STEJNÉHO požadavku —
// viz tests/provedene-masaze-obdobi.test.js, bod 2, kde byl problém poprvé
// doložený: kontrola "částka ≤ zbývající dluh" dvojí odeslání ČÁSTEČNÉ
// platby nezachytí, protože dvě menší částky zbývající dluh nemusí
// přesáhnout).
//
// Pokrývá přesně body zadané Alenou:
//  1) sloupec platby.idempotency_klic (nullable, unikátní index) — ověřeno
//     nepřímo přes chování API, ne přímým dotazem do schématu (to už udělal
//     migrační skript).
//  2) opakování se stejným klíčem nevytvoří druhou platbu
//  3) stejný klíč s jinou rezervací/částkou/způsobem platby → odmítnuto
//  4) dva SOUČASNĚ přijaté požadavky se stejným klíčem → jen jeden zápis
//  5)+7) částečné platby, zálohy, plné platby, souběžné požadavky
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=http://localhost:3001/api node tests/idempotence-plateb.test.js

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

async function vytvorRezervaci(cenikId, telefonSuffix) {
  const { datum, cas } = await novyVolnyTermin(cenikId, 600 + Math.floor(Math.random() * 100));
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: cas, jmeno: 'TEST-IDEMPOTENCE (smazat)', telefon: '00003' + telefonSuffix, email: 'test-idempotence@example.cz' })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'Vytvoření testovací rezervace selhalo: ' + JSON.stringify(data));
  if (data.rezervace.klientka_id) uklidKlientky.add(data.rezervace.klientka_id);
  return data.rezervace;
}

function uuid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'test-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

async function zaplatit(id, castka, zpusob_platby, idempotency_klic, typ) {
  const body = { castka, zpusob_platby };
  if (idempotency_klic) body.idempotency_klic = idempotency_klic;
  if (typ) body.typ = typ;
  return adminFetch(`/admin/rezervace/${id}/platba`, { method: 'PATCH', body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));
}

async function historie(id) {
  return adminFetch(`/admin/rezervace/${id}/platby`).then(r => r.json());
}

async function dokoncit(id) {
  const res = await adminFetch(`/admin/rezervace/${id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'dokoncena' }) });
  const data = await res.json();
  assert.equal(res.status, 200, 'Dokončení rezervace selhalo: ' + JSON.stringify(data));
  return data;
}

const uklidRezervace = [];
const uklidKlientky = new Set();

async function main() {
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');
    const cena = Number(polozka.cena);

    // 1) Opakování se STEJNÝM klíčem a STEJNÝMI parametry nevytvoří druhou platbu
    console.log('--- 1) opakování stejného požadavku (stejný klíč) ---');
    {
      const r = await vytvorRezervaci(polozka.id, '31');
      uklidRezervace.push(r.id);
      const castka = Math.max(1, Math.floor(cena * 0.3)); // "300 Kč z 1050 Kč" ze zadání
      const klic = uuid();

      const prvni = await zaplatit(r.id, castka, 'hotove', klic);
      assert.equal(prvni.status, 200, JSON.stringify(prvni.data));
      assert.equal(Number(prvni.data.rezervace.uhrazeno), castka);

      const opakovani = await zaplatit(r.id, castka, 'hotove', klic);
      assert.equal(opakovani.status, 200, 'Opakování se stejným klíčem má vrátit 200 (idempotentní odpověď), ne chybu: ' + JSON.stringify(opakovani.data));
      assert.equal(opakovani.data.idempotentni, true, 'Odpověď na opakování má být označená jako idempotentní');
      assert.equal(Number(opakovani.data.rezervace.uhrazeno), castka, 'Opakování nesmí zvýšit uhrazeno — pořád má být jen ta JEDNA platba');

      const h = await historie(r.id);
      assert.equal(h.length, 1, 'V historii má být přesně JEDEN platební řádek, je jich: ' + h.length);
      console.log('OK — dvojí odeslání STEJNÉHO požadavku (300 Kč, stejný klíč) vytvoří jen 1 platbu, druhý pokus vrátí idempotentní odpověď');
    }

    // 2) Stejný klíč, ale JINÁ ČÁSTKA → odmítnuto (409), nic se nezapíše
    console.log('--- 2) stejný klíč s jinou částkou → odmítnuto ---');
    {
      const r = await vytvorRezervaci(polozka.id, '32');
      uklidRezervace.push(r.id);
      const klic = uuid();
      const prvni = await zaplatit(r.id, 100, 'hotove', klic);
      assert.equal(prvni.status, 200, JSON.stringify(prvni.data));
      const druhy = await zaplatit(r.id, 200, 'hotove', klic);
      assert.equal(druhy.status, 409, 'Stejný klíč s jinou částkou má být odmítnut (409), dostáno: ' + druhy.status);
      const h = await historie(r.id);
      assert.equal(h.length, 1);
      assert.equal(Number(h[0].castka), 100, 'Zápis s konfliktním klíčem nesmí nic změnit — zůstává jen první platba');
      console.log('OK — stejný klíč s jinou částkou je odmítnut (409), druhá platba se nezapíše');
    }

    // 3) Stejný klíč, ale JINÝ ZPŮSOB PLATBY → odmítnuto
    console.log('--- 3) stejný klíč s jiným způsobem platby → odmítnuto ---');
    {
      const r = await vytvorRezervaci(polozka.id, '33');
      uklidRezervace.push(r.id);
      const klic = uuid();
      await zaplatit(r.id, 100, 'hotove', klic);
      const druhy = await zaplatit(r.id, 100, 'kartou', klic);
      assert.equal(druhy.status, 409, 'Stejný klíč s jiným způsobem platby má být odmítnut, dostáno: ' + druhy.status);
      const h = await historie(r.id);
      assert.equal(h.length, 1);
      console.log('OK — stejný klíč s jiným způsobem platby (hotove → kartou) je odmítnut');
    }

    // 3b) Stejný klíč, ale JINÁ REZERVACE → odmítnuto
    console.log('--- 3b) stejný klíč na jiné rezervaci → odmítnuto ---');
    {
      const rA = await vytvorRezervaci(polozka.id, '34');
      const rB = await vytvorRezervaci(polozka.id, '35');
      uklidRezervace.push(rA.id, rB.id);
      const klic = uuid();
      const a = await zaplatit(rA.id, 100, 'hotove', klic);
      assert.equal(a.status, 200, JSON.stringify(a.data));
      const b = await zaplatit(rB.id, 100, 'hotove', klic);
      assert.equal(b.status, 409, 'Stejný klíč použitý na JINÉ rezervaci má být odmítnut, dostáno: ' + b.status);
      const hB = await historie(rB.id);
      assert.equal(hB.length, 0, 'Na rezervaci B nesmí vzniknout žádná platba, když klíč patří rezervaci A');
      console.log('OK — stejný klíč použitý na jiné rezervaci je odmítnut, cizí rezervaci nic nepřipíše');
    }

    // 4) Dva SOUČASNĚ přijaté požadavky se stejným klíčem → jen jeden zápis
    console.log('--- 4) souběh dvou požadavků se stejným klíčem ---');
    {
      const r = await vytvorRezervaci(polozka.id, '36');
      uklidRezervace.push(r.id);
      const castka = Math.max(1, Math.floor(cena * 0.3));
      const klic = uuid();
      const [a, b] = await Promise.all([
        zaplatit(r.id, castka, 'hotove', klic),
        zaplatit(r.id, castka, 'hotove', klic)
      ]);
      // Obě odpovědi musí vyjadřovat ÚSPĚCH (jde o stejnou logickou platbu) —
      // buď přímý zápis, nebo idempotentní odpověď druhého, co prohrál závod.
      assert.equal(a.status, 200, 'Odpověď A má být 200: ' + JSON.stringify(a.data));
      assert.equal(b.status, 200, 'Odpověď B má být 200 (idempotentní), ne chyba: ' + JSON.stringify(b.data));
      const h = await historie(r.id);
      assert.equal(h.length, 1, 'Souběh se stejným klíčem nesmí vytvořit dva řádky, vytvořeno: ' + h.length);
      assert.equal(Number(h[0].castka), castka);
      console.log('OK — dva SOUČASNÉ požadavky se stejným klíčem vytvoří přesně 1 platbu, oba vrátí úspěch (unikátní index v databázi, ne jen časování)');
    }

    // 5) Dvě SKUTEČNĚ samostatné částečné platby (jiné klíče) — obě mají projít
    console.log('--- 5) dvě samostatné částečné platby (jiné klíče) ---');
    {
      const r = await vytvorRezervaci(polozka.id, '37');
      uklidRezervace.push(r.id);
      const cast1 = Math.max(1, Math.floor(cena * 0.3));
      const cast2 = Math.max(1, Math.floor(cena * 0.2));
      const p1 = await zaplatit(r.id, cast1, 'hotove', uuid());
      assert.equal(p1.status, 200, JSON.stringify(p1.data));
      const p2 = await zaplatit(r.id, cast2, 'hotove', uuid());
      assert.equal(p2.status, 200, JSON.stringify(p2.data));
      assert.equal(Number(p2.data.rezervace.uhrazeno), cast1 + cast2);
      const h = await historie(r.id);
      assert.equal(h.length, 2, 'Dvě SAMOSTATNÉ platby (jiné klíče) mají obě projít a vytvořit 2 řádky');
      console.log('OK — dvě skutečně samostatné částečné platby (různé klíče) obě projdou, nejsou zaměněny za duplicitu');
    }

    // 6) Záloha + doplatek (jiné klíče) až do plné úhrady — plné účetnictví sedí
    console.log('--- 6) záloha + doplatek do plné úhrady ---');
    {
      const r = await vytvorRezervaci(polozka.id, '38');
      uklidRezervace.push(r.id);
      const zaloha = Math.max(1, Math.floor(cena / 3));
      const doplatek = cena - zaloha;
      const p1 = await zaplatit(r.id, zaloha, 'hotove', uuid());
      assert.equal(p1.status, 200);
      assert.equal(p1.data.rezervace.stav_platby, 'castecne_zaplaceno');
      const p2 = await zaplatit(r.id, doplatek, 'kartou', uuid());
      assert.equal(p2.status, 200);
      assert.equal(p2.data.rezervace.stav_platby, 'zaplaceno');
      assert.equal(Number(p2.data.rezervace.uhrazeno), cena);
      const h = await historie(r.id);
      assert.equal(h.length, 2);
      assert.equal(h.reduce((s, x) => s + Number(x.castka), 0), cena, 'Součet historie plateb musí přesně odpovídat ceně');
      console.log('OK — záloha + doplatek (různé klíče) dají dohromady přesně cenu, účetnictví (uhrazeno/stav_platby) sedí');
    }

    // 7) Plná platba jedním klíčem, opakování stejným klíčem je idempotentní
    console.log('--- 7) plná platba, opakování stejným klíčem ---');
    {
      const r = await vytvorRezervaci(polozka.id, '39');
      uklidRezervace.push(r.id);
      const klic = uuid();
      const p1 = await zaplatit(r.id, cena, 'hotove', klic);
      assert.equal(p1.status, 200);
      assert.equal(p1.data.rezervace.stav_platby, 'zaplaceno');
      const p2 = await zaplatit(r.id, cena, 'hotove', klic);
      assert.equal(p2.status, 200, 'Opakování stejné plné platby stejným klíčem má být idempotentní (200), ne chyba');
      assert.equal(p2.data.idempotentni, true);
      const h = await historie(r.id);
      assert.equal(h.length, 1, 'Plná platba + opakování stejným klíčem nesmí vytvořit druhý řádek');
      console.log('OK — plná platba + opakování stejným klíčem: jen 1 řádek, žádné přeplacení');
    }

    // 7b) Síťová chyba PO úspěšném uložení platby — přesně scénář dialogu
    // "Dokončit masáž": krok 1 (platba) na serveru uspěje, ale admin (resp.
    // test tady) o tom neví jistě (odpověď se ztratila / krok 2 selhal) a
    // zkusí přesně TEN SAME požadavek (stejný klíč) znovu, PAK pokračuje
    // krokem 2 (dokončení). Ověřuje celý tok, ne jen izolovaný PATCH platba.
    console.log('--- 7b) síťová chyba/nejistota PO úspěšném uložení platby (celý tok dialogu) ---');
    {
      const r = await vytvorRezervaci(polozka.id, '3b1');
      uklidRezervace.push(r.id);
      const castka = Math.max(1, Math.floor(cena * 0.3));
      const klic = uuid();

      // Krok 1 proběhne na serveru úspěšně...
      const prvni = await zaplatit(r.id, castka, 'hotove', klic);
      assert.equal(prvni.status, 200, JSON.stringify(prvni.data));

      // ...ale klient si (modelově) nebyl jistý výsledkem (ztracená odpověď /
      // chyba spojení) a zopakuje STEJNÝ požadavek se STEJNÝM klíčem —
      // přesně to, co dělá dokoncitMasazOdeslat() v admin.html při retry.
      const opakovani = await zaplatit(r.id, castka, 'hotove', klic);
      assert.equal(opakovani.status, 200, 'Opakování po nejisté/síťové chybě má vrátit 200 (idempotentní), ne chybu');
      assert.equal(opakovani.data.idempotentni, true);

      // Krok 2 (dokončení) teď proběhne — jako by šlo o úspěšný retry celého
      // dialogu po dřívější nejistotě/chybě.
      await dokoncit(r.id);

      const h = await historie(r.id);
      assert.equal(h.length, 1, 'Po "síťové chybě po úspěšném uložení" a opakování nesmí v historii přibyla druhá platba, řádků: ' + h.length);
      assert.equal(Number(h[0].castka), castka);
      const seznam = await adminFetch('/admin/rezervace').then(res => res.json());
      const aktualni = seznam.find(x => x.id === r.id);
      assert.equal(aktualni.stav, 'dokoncena');
      assert.equal(Number(aktualni.uhrazeno), castka);
      console.log('OK — celý tok "platba → nejistota/síťová chyba → opakování stejným klíčem → dokončení" skončí s přesně 1 platbou a správným stavem');
    }

    // 8) Volání BEZ klíče (zpětná kompatibilita) — chová se přesně jako dřív,
    // žádná regrese pro případné jiné volající, co klíč neposílají.
    console.log('--- 8) volání bez idempotency_klic (zpětná kompatibilita) ---');
    {
      const r = await vytvorRezervaci(polozka.id, '3a');
      uklidRezervace.push(r.id);
      const castka = Math.max(1, Math.floor(cena / 2));
      const p1 = await zaplatit(r.id, castka, 'hotove'); // bez klíče
      assert.equal(p1.status, 200);
      assert.equal(p1.data.idempotentni, undefined, 'Odpověď bez klíče nemá mít příznak "idempotentni"');
      console.log('OK — volání bez idempotency_klic funguje přesně jako dřív (zpětně kompatibilní)');
    }

    console.log('\n✅ VŠECHNY TESTY IDEMPOTENCE PLATEB PROŠLY');
  } finally {
    for (const id of uklidRezervace) {
      await adminFetch(`/admin/rezervace/${id}`, { method: 'DELETE' }).catch(() => null);
    }
    let klientkySmazano = 0;
    for (const id of uklidKlientky) {
      const r = await adminFetch(`/admin/klientky/${id}`, { method: 'DELETE' }).catch(() => null);
      if (r && r.ok) klientkySmazano++;
    }
    if (uklidRezervace.length || uklidKlientky.size) {
      console.log(`(uklizeno: ${uklidRezervace.length} testovacích rezervací, ${klientkySmazano}/${uklidKlientky.size} testovacích klientek)`);
    }
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
