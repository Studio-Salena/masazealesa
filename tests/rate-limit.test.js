// Regresní test: rate limit na admin heslo (Fáze 8A.3, návrh 8A.1/8A.2).
// Jeden sdílený in-memory čítač pro celý proces, společný pro POST /api/login
// i pro vyzadovatAdmina (/api/admin/*) — ověřuje se, že:
//   - správné heslo NIKDY neblokuje limiter a vždy čítač resetuje,
//   - 10 neúspěšných pokusů v okně projde jako 401, 11. je 429,
//   - limit je sdílený (nejde ho obejít přepnutím mezi /api/login a /api/admin/*),
//   - po úspěchu lze znovu "od nuly" vyčerpat dalších 10 pokusů.
//
// Běží proti izolovanému testovacímu prostředí (env-guard.js — fail-closed,
// žádný produkční fallback).
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=... node tests/rate-limit.test.js

const assert = require('node:assert/strict');

const { ziskatTestApiBase } = require('./env-guard');
const API = ziskatTestApiBase();
const HESLO = process.env.ADMIN_HESLO;

if (!HESLO) {
  console.error('Chybí ADMIN_HESLO v prostředí — test se přeskakuje.');
  process.exit(0);
}

async function login(heslo) {
  const r = await fetch(API + '/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ heslo })
  });
  return { status: r.status, data: await r.json() };
}
async function adminPokus(heslo) {
  // GET /api/admin/klientky jako reprezentativní admin endpoint — stejný
  // middleware (vyzadovatAdmina) chrání všechny /api/admin/*.
  const r = await fetch(API + '/admin/klientky', { headers: { 'x-admin-heslo': heslo } });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

let scenaru = 0, uspesnych = 0;
function ok(popis) { scenaru++; uspesnych++; console.log('OK — ' + popis); }

async function main() {
  console.log('=== Rate limit na admin heslo (Fáze 8A.3) ===');

  // Čistý start: nezávisle na předchozím stavu procesu správné heslo čítač
  // vždy vynuluje — odsud začínáme z jistého nulového stavu.
  {
    const r = await login(HESLO);
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
  }

  // ================= A) /api/login =================
  console.log('--- A) /api/login ---');

  // A1) správné heslo → 200
  {
    const r = await login(HESLO);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { ok: true });
    ok('A1) správné heslo → 200 { ok: true }');
  }

  // A2) jedno špatné heslo → 401
  {
    const r = await login('spatne-heslo');
    assert.equal(r.status, 401);
    assert.deepEqual(r.data, { ok: false });
    ok('A2) jedno špatné heslo → 401 { ok: false }');
  }

  // A3) celkem 10 špatných pokusů → všech 10 = 401 (A2 byl 1., tady dalších 9)
  {
    for (let i = 0; i < 9; i++) {
      const r = await login('spatne-heslo');
      assert.equal(r.status, 401, `pokus č. ${i + 2} z 10 musí být 401`);
    }
    ok('A3) celkem 10 špatných pokusů → všech 10× 401');
  }

  // A4) 11. špatný pokus → 429
  {
    const r = await login('spatne-heslo');
    assert.equal(r.status, 429, '11. špatný pokus musí být 429');
    ok('A4) 11. špatný pokus → 429');
  }

  // A5) správné heslo ihned po dosažení limitu → 200 (klíčový test self-lockout)
  {
    const r = await login(HESLO);
    assert.equal(r.status, 200, 'správné heslo musí projít i po dosažení limitu');
    assert.deepEqual(r.data, { ok: true });
    ok('A5) správné heslo ihned po dosažení limitu → 200 (limiter správné heslo nikdy nezablokuje)');
  }

  // A6) po tomto úspěchu nový špatný pokus → 401 (ne 429 — čítač se skutečně vynuloval)
  {
    const r = await login('spatne-heslo');
    assert.equal(r.status, 401, 'po resetu musí být další špatný pokus zase jen 401, ne 429');
    ok('A6) po úspěchu (reset) je další špatný pokus znovu jen 401');
  }

  // A7) ověřit, že po resetu lze znovu provést celých 10 neúspěšných pokusů
  {
    // nejdřív čistý reset (A6 už nechal čítač na 1, dorovnáme korektním heslem)
    const reset = await login(HESLO);
    assert.equal(reset.status, 200);

    for (let i = 0; i < 10; i++) {
      const r = await login('spatne-heslo');
      assert.equal(r.status, 401, `po resetu pokus č. ${i + 1} z 10 musí být 401`);
    }
    const jedenactyPoResetu = await login('spatne-heslo');
    assert.equal(jedenactyPoResetu.status, 429, 'po resetu musí 11. pokus být znovu 429');
    ok('A7) po resetu lze znovu vyčerpat celých 10 pokusů (401) a 11. je znovu 429');
  }

  // A8) expirace okna (15 minut) — POUZE STATICKY. Živé čekání 15 minut by
  // bylo v testovací sadě nepraktické a 8A.3 explicitně zakazuje zavádět
  // jakoukoli produkční env proměnnou nebo API-dostupný mechanismus pro
  // "posun času" (viz zadání — stejný princip jako "POUZE STATICKY" sekce
  // v tests/retence.test.js pro jinak nedosažitelné časové hranice). Proto se
  // tady jen zrcadlí STEJNÁ aritmetika okna, jakou má server.js u
  // rateLimitAktualizovatOkno (RATE_LIMIT_MAX=10, RATE_LIMIT_OKNO_MS=900000):
  // pokud se tyto konstanty v server.js změní, je třeba je zde ručně
  // synchronizovat.
  {
    const MIRROR_OKNO_MS = 15 * 60 * 1000;
    function jeOknoExpirovane(oknoOd, ted) {
      return oknoOd !== null && (ted - oknoOd) >= MIRROR_OKNO_MS;
    }
    const T = Date.now();
    assert.equal(jeOknoExpirovane(null, T), false, 'bez běžícího okna není co expirovat');
    assert.equal(jeOknoExpirovane(T, T + MIRROR_OKNO_MS - 1), false, '1 ms před hranicí okno ještě neplatí jako expirované');
    assert.equal(jeOknoExpirovane(T, T + MIRROR_OKNO_MS), true, 'přesně na hranici (>=) už je okno expirované a čítač se resetuje');
    assert.equal(jeOknoExpirovane(T, T + MIRROR_OKNO_MS + 1), true, 'po hranici je okno expirované');
    ok('A8) [POUZE STATICKY — zrcadlená logika] expirace 15minutového okna (hranice, před/po)');
  }

  // Reset do čistého stavu před sekcí B
  { const r = await login(HESLO); assert.equal(r.status, 200); }

  // ================= B) /api/admin/* (sdílený limiter) =================
  console.log('--- B) /api/admin/* — sdílený limiter ---');

  // B9) správné heslo → běžný úspěšný response
  {
    const r = await adminPokus(HESLO);
    assert.equal(r.status, 200, 'správné heslo na admin endpointu musí projít');
    ok('B9) správné heslo na /api/admin/klientky → 200');
  }

  // B10) špatné heslo → 401
  {
    const r = await adminPokus('spatne-heslo');
    assert.equal(r.status, 401);
    ok('B10) špatné heslo na /api/admin/klientky → 401');
  }

  // B11) opakované špatné heslo, STŘÍDAVĚ přes /api/login i /api/admin/* →
  // sdílený limit (útočník nezíská nový prostor obejitím /api/login)
  {
    // B10 byl 1. z 10. Dalších 9 rozdělíme: 4 přes admin endpoint, 5 přes /api/login.
    for (let i = 0; i < 4; i++) {
      const r = await adminPokus('spatne-heslo');
      assert.equal(r.status, 401, `admin pokus ${i + 2}/10 musí být 401`);
    }
    for (let i = 0; i < 5; i++) {
      const r = await login('spatne-heslo');
      assert.equal(r.status, 401, `login pokus ${i + 6}/10 (jiný endpoint, sdílený čítač) musí být 401`);
    }
    ok('B11) 10 neúspěchů rozdělených mezi /api/login a /api/admin/klientky → sdílený čítač, všech 10× 401');
  }

  // B12) po dosažení limitu další špatné heslo (na admin endpointu) → 429
  {
    const r = await adminPokus('spatne-heslo');
    assert.equal(r.status, 429, '11. pokus (na admin endpointu, limit vyčerpán přes oba endpointy) musí být 429');
    ok('B12) 11. pokus na /api/admin/klientky po sdíleném vyčerpání limitu → 429');
  }

  // B13) správné heslo po dosažení limitu → normálně projde i na admin endpointu
  {
    const r = await adminPokus(HESLO);
    assert.equal(r.status, 200, 'správné heslo musí projít i na admin endpointu po dosažení limitu');
    ok('B13) správné heslo na /api/admin/klientky ihned po limitu → 200');
  }

  // B14) správné heslo resetuje sdílený čítač — ověřeno nepřímo bodem B15
  // (pokud by čítač nebyl resetován, další špatný pokus by byl 429, ne 401)

  // B15) po resetu opět počítání od nuly
  {
    const r = await adminPokus('spatne-heslo');
    assert.equal(r.status, 401, 'po resetu (B13) musí být další špatný pokus zase jen 401, ne 429 — potvrzuje B14');
    ok('B14+B15) správné heslo (B13) skutečně resetovalo sdílený čítač — další špatný pokus je znovu jen 401');
  }

  // Úklid: necháme limiter v čistém (nulovém) stavu pro ostatní testy/provoz
  { const r = await login(HESLO); assert.equal(r.status, 200); }

  console.log(`\n${uspesnych}/${scenaru} scénářů OK.`);
  if (uspesnych !== scenaru) process.exit(1);
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
