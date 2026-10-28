// Regresní test: globální vyhledávání v adminu (GET /api/admin/hledat).
// Ověřuje: nalezení klientky/rezervace/poukazu podle jména/telefonu/e-mailu/kódu
// (vč. různých zápisů téhož telefonu), že krátký dotaz (<2 znaky) nic nehledá,
// a že endpoint vyžaduje admin heslo stejně jako zbytek /api/admin.
//
// Běží VÝHRADNĚ proti izolovanému testovacímu prostředí (viz env-guard.js —
// fail-closed, žádný produkční fallback). Všechna testovací data na konci smaže.
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=... node tests/hledani.test.js

const assert = require('node:assert/strict');

const { ziskatTestApiBase } = require('./env-guard');
const API = ziskatTestApiBase(); // Fáze 7C.6 — fail-closed, žádný produkční fallback
const HESLO = process.env.ADMIN_HESLO;

if (!HESLO) {
  console.error('Chybí ADMIN_HESLO v prostředí — test se přeskakuje (spusťte s ADMIN_HESLO=... node tests/hledani.test.js).');
  process.exit(0);
}

function adminFetch(cesta, options = {}) {
  return fetch(API + cesta, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-admin-heslo': HESLO, ...(options.headers || {}) }
  });
}
async function hledat(q) {
  return adminFetch('/admin/hledat?q=' + encodeURIComponent(q)).then(r => r.json());
}

async function main() {
  let klientkaId = null, rezervaceId = null, poukazId = null, druhaKlientkaId = null;
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');

    // Synteticky odlišné, snadno rozpoznatelné testovací hodnoty (stejná
    // konvence jako TEL1/TEL2 v klientky.test.js) — ať se nemůžou shodovat se
    // skutečnými daty ani kolidovat s jinými souběžně běžícími testy.
    const JMENO = 'TEST-HLEDANI Zrzka (smazat)';
    const TEL = '000990011'; // 9 číslic, ať se jako reálné číslo chová i vůči oříznutí předvolby +420/00420 v normalizovatTelefon()
    const EMAIL = 'test-hledani-zrzka@example.com';

    // ============= 1) KLIENTKA =============
    {
      const res = await adminFetch('/admin/klientky', {
        method: 'POST', body: JSON.stringify({ jmeno: JMENO, telefon: TEL, email: EMAIL })
      });
      assert.equal(res.status, 200, 'vytvoření testovací klientky selhalo');
      const data = await res.json();
      klientkaId = data.klientka.id;

      const podleJmena = await hledat('Zrzka');
      assert.ok(podleJmena.klientky.some(k => k.id === klientkaId), '1a) klientka nalezena podle části jména');

      const podleTelefonu = await hledat('+420 000 99 00 11');
      assert.ok(podleTelefonu.klientky.some(k => k.id === klientkaId), '1b) klientka nalezena podle telefonu i v jiném zápisu (+420, mezery)');

      const podleEmailu = await hledat('test-hledani-zrzka');
      assert.ok(podleEmailu.klientky.some(k => k.id === klientkaId), '1c) klientka nalezena podle části e-mailu');

      console.log('OK — 1) klientka nalezena podle jména, telefonu (i jinak zapsaného) a e-mailu');
    }

    // ============= 2) REZERVACE =============
    {
      let datum = null, cas = null;
      for (let i = 10; i < 100; i += 3) {
        const d = new Date(); d.setDate(d.getDate() + i);
        const iso = d.toISOString().slice(0, 10);
        const terminy = await fetch(`${API}/rezervace/volne-terminy?datum=${iso}&cenik_id=${polozka.id}`).then(r => r.json());
        const volny = Array.isArray(terminy) ? terminy.find(t => t.volno) : null;
        if (volny) { datum = iso; cas = volny.cas; break; }
      }
      assert.ok(datum, 'Nenašel se volný termín pro test rezervace');

      const res = await adminFetch('/admin/rezervace', {
        method: 'POST',
        body: JSON.stringify({ cenik_id: polozka.id, datum, cas_od: cas, jmeno: 'TEST-HLEDANI Rezervace (smazat)', telefon: '00099012', email: 'test-hledani-rez@example.com' })
      });
      assert.equal(res.status, 200, 'vytvoření testovací rezervace selhalo');
      const data = await res.json();
      rezervaceId = data.rezervace.id;

      const podleJmena = await hledat('TEST-HLEDANI Rezervace');
      assert.ok(podleJmena.rezervace.some(r => r.id === rezervaceId), '2a) rezervace nalezena podle jména');

      const podleTelefonu = await hledat('00099012');
      assert.ok(podleTelefonu.rezervace.some(r => r.id === rezervaceId), '2b) rezervace nalezena podle telefonu');

      console.log('OK — 2) rezervace nalezena podle jména i telefonu');

      // Druhá klientka vznikla automaticky spolu s rezervací (má telefon) — po
      // smazání rezervace ji na konci uklidíme zvlášť (viz finally).
      druhaKlientkaId = data.rezervace.klientka_id;
    }

    // ============= 3) POUKAZ =============
    {
      const res = await adminFetch('/admin/poukazy', {
        method: 'POST',
        body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-HLEDANI Poukaz (smazat)', kupujici_email: 'test-hledani-poukaz@example.com' })
      });
      assert.equal(res.status, 200, 'vytvoření testovacího poukazu selhalo');
      const data = await res.json();
      poukazId = data.poukaz.id;
      const kod = data.poukaz.kod;

      const podleKodu = await hledat(kod);
      assert.ok(podleKodu.poukazy.some(p => p.id === poukazId), '3a) poukaz nalezen podle kódu');

      const podleJmena = await hledat('TEST-HLEDANI Poukaz');
      assert.ok(podleJmena.poukazy.some(p => p.id === poukazId), '3b) poukaz nalezen podle jména kupujícího');

      const podleEmailu = await hledat('test-hledani-poukaz');
      assert.ok(podleEmailu.poukazy.some(p => p.id === poukazId), '3c) poukaz nalezen podle e-mailu kupujícího');

      console.log('OK — 3) poukaz nalezen podle kódu, jména i e-mailu kupujícího');
    }

    // ============= 4) OKRAJOVÉ PŘÍPADY =============
    {
      const kratky = await hledat('A');
      assert.deepEqual(kratky, { klientky: [], rezervace: [], poukazy: [] }, '4a) dotaz kratší než 2 znaky nic nehledá');

      const bezHesla = await fetch(API + '/admin/hledat?q=test');
      assert.equal(bezHesla.status, 401, '4b) bez admin hesla endpoint odmítá přístup');

      console.log('OK — 4) krátký dotaz vrací prázdno, chybějící heslo je odmítnuto (401)');
    }

    console.log('\n✅ VŠECHNY TESTY GLOBÁLNÍHO VYHLEDÁVÁNÍ PROŠLY');
  } finally {
    if (rezervaceId) await adminFetch('/admin/rezervace/' + rezervaceId, { method: 'DELETE' }).catch(() => {});
    if (poukazId) await adminFetch('/admin/poukazy/' + poukazId, { method: 'DELETE' }).catch(() => {});
    if (klientkaId) await adminFetch('/admin/klientky/' + klientkaId, { method: 'DELETE' }).catch(() => {});
    if (druhaKlientkaId) await adminFetch('/admin/klientky/' + druhaKlientkaId, { method: 'DELETE' }).catch(() => {});
    console.log('(uklizeno: testovací klientky, rezervace a poukaz)');
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
