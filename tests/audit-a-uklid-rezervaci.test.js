// Regresní test: audit ochrany mazání rezervací PŘESUNUTÝ do databázových
// triggerů (viz schema.sql — rezervace_audit_smazani, rezervace_audit_zmena_stavu)
// + potvrzovací dialog v admin.html u přechodu pryč z "dokoncena" + bezpečný
// a konzistentní úklid testovacích fixtur (tests/test-helpers.js).
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=http://localhost:3001/api DATABASE_URL=... node tests/audit-a-uklid-rezervaci.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const { ziskatTestApiBase, ziskatTestDatabaseUrl } = require('./env-guard');
const { smazatRezervaciNatvrdo } = require('./test-helpers');
const API = ziskatTestApiBase();
const DB_URL = ziskatTestDatabaseUrl();
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
  const { datum, cas } = await novyVolnyTermin(cenikId, 1500 + Math.floor(Math.random() * 100));
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: cas, jmeno: 'TEST-AUDIT-UKLID (smazat)', telefon: '00009' + telefonSuffix, email: 'test-audit-uklid@example.cz' })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'Vytvoření testovací rezervace selhalo: ' + JSON.stringify(data));
  if (data.rezervace.klientka_id) uklidKlientky.add(data.rezervace.klientka_id);
  return data.rezervace;
}
async function dokoncit(id) {
  const r = await adminFetch(`/admin/rezervace/${id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'dokoncena' }) });
  assert.equal(r.status, 200);
}
async function zmenitStav(id, stav) {
  return adminFetch(`/admin/rezervace/${id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav }) }).then(async r => ({ status: r.status, data: await r.json() }));
}
async function smazat(id) {
  return adminFetch(`/admin/rezervace/${id}`, { method: 'DELETE' }).then(async r => ({ status: r.status, data: await r.json() }));
}
async function auditZaznamy(rezervaceId) {
  const vse = await adminFetch('/admin/rezervace-ochrana-udalosti').then(r => r.json());
  return vse.filter(u => u.rezervace_id === rezervaceId);
}

const pgClient = () => {
  const { Client } = require('pg');
  return new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
};

const uklidRezervace = [];
const uklidKlientky = new Set();

async function main() {
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');
    const cena = Number(polozka.cena);

    // 1) Audit při změně PŘES API — právě jeden záznam pro DELETE (povolené)
    // a právě jeden pro přechod pryč z "dokoncena".
    console.log('--- 1) audit přes API: právě jeden záznam na jednu změnu ---');
    {
      const r1 = await vytvorRezervaci(polozka.id, '1');
      const s1 = await smazat(r1.id);
      assert.equal(s1.status, 200, JSON.stringify(s1.data));
      const audit1 = await auditZaznamy(r1.id);
      assert.equal(audit1.length, 1, 'Povolené smazání přes API musí zapsat přesně 1 auditní záznam');
      assert.equal(audit1[0].udalost, 'smazana');

      const r2 = await vytvorRezervaci(polozka.id, '2');
      uklidRezervace.push(r2.id);
      await dokoncit(r2.id);
      const z2 = await zmenitStav(r2.id, 'potvrzena');
      assert.equal(z2.status, 200, JSON.stringify(z2.data));
      const audit2 = await auditZaznamy(r2.id);
      assert.equal(audit2.length, 1, 'Přechod pryč z "dokoncena" přes API musí zapsat přesně 1 auditní záznam');
      assert.equal(audit2[0].udalost, 'stav_zmenen_z_dokoncena');
      console.log('OK — API: právě jeden auditní záznam na smazání i na přechod pryč z "dokoncena"');
    }

    // 2) Audit při PŘÍMÉM SQL UPDATE a DELETE — appka se úplně obejde.
    console.log('--- 2) audit přes přímý SQL UPDATE/DELETE (appka obejita) ---');
    {
      const pg = pgClient();
      await pg.connect();
      try {
        const r3 = await vytvorRezervaci(polozka.id, '3');
        await dokoncit(r3.id);
        await pg.query(`UPDATE rezervace SET stav = 'nedostavila_se' WHERE id = $1`, [r3.id]);
        const audit3 = await auditZaznamy(r3.id);
        assert.equal(audit3.length, 1, 'Přímý SQL UPDATE pryč z "dokoncena" musí zapsat přesně 1 auditní záznam (trigger)');
        assert.equal(audit3[0].udalost, 'stav_zmenen_z_dokoncena');
        assert.equal(audit3[0].stav_po, 'nedostavila_se');
        await pg.query('DELETE FROM rezervace WHERE id = $1', [r3.id]); // teď nedokončená, bez platby → SQL DELETE projde
        const audit3b = await auditZaznamy(r3.id);
        assert.equal(audit3b.length, 2, 'Přímý SQL DELETE musí přidat druhý (vlastní) auditní záznam, ne jen ten z UPDATE');
        assert.equal(audit3b.filter(a => a.udalost === 'smazana').length, 1);
        console.log('OK — přímý SQL UPDATE i DELETE (appka úplně obejita) zapíší audit přes databázový trigger, žádná duplicita');
      } finally {
        await pg.end();
      }
    }

    // 3) Rollback při selhání auditu — uměle rozbijeme INSERT do auditu a
    // ověříme, že se DELETE rezervace vrátí zpět beze stopy.
    console.log('--- 3) rollback při selhání zápisu auditu ---');
    {
      const r4 = await vytvorRezervaci(polozka.id, '4');
      uklidRezervace.push(r4.id);
      const pg = pgClient();
      await pg.connect();
      try {
        await pg.query(`alter table rezervace_ochrana_udalosti add constraint test_rollback_audit check (false) not valid`);
        let chyba = null;
        try { await pg.query('DELETE FROM rezervace WHERE id = $1', [r4.id]); }
        catch (e) { chyba = e; }
        assert.ok(chyba, 'DELETE musí selhat, když zápis auditu selže');
        await pg.query(`alter table rezervace_ochrana_udalosti drop constraint test_rollback_audit`);
        const existuje = await pg.query('SELECT id, stav FROM rezervace WHERE id = $1', [r4.id]);
        assert.equal(existuje.rows.length, 1, 'Rezervace musí po neúspěšném DELETE (selhání auditu) stále existovat — ROLLBACK proběhl');
        const auditPocet = await pg.query('SELECT count(*) FROM rezervace_ochrana_udalosti WHERE rezervace_id = $1', [r4.id]);
        assert.equal(Number(auditPocet.rows[0].count), 0, 'Nesmí vzniknout žádný částečný/osiřelý auditní záznam');
        console.log('OK — selhání zápisu auditu vrátí zpět i samotné DELETE (atomicita), žádný částečný stav');
      } finally {
        await pg.end();
      }
    }

    // 4) Potvrzovací dialog v admin.html — spouštíme PŘÍMO zdrojový kód
    // funkce zmenitStavRez() z živého admin.html (žádná duplikace logiky,
    // žádná nová závislost typu jsdom — jen vestavěný Node "vm").
    console.log('--- 4) potvrzovací dialog u přechodu pryč z "dokoncena" (admin.html) ---');
    {
      const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
      const shoda = html.match(/async function zmenitStavRez\([\s\S]*?\n\}/);
      assert.ok(shoda, 'Funkce zmenitStavRez nebyla v admin.html nalezena (změnil se zdrojový kód?)');
      const zdrojFunkce = shoda[0];

      function zavolatSPotvrzenim(odpovedConfirm) {
        const zavolanaFetch = [];
        const sandbox = {
          confirm: () => odpovedConfirm,
          alert: () => {},
          adminFetch: (url, opts) => { zavolanaFetch.push({ url, opts }); return Promise.resolve({ json: async () => ({}) }); },
          loadRezervace: () => {},
          API: 'https://X',
          console
        };
        vm.createContext(sandbox);
        vm.runInContext(zdrojFunkce + '\nthis.__zavolat = zmenitStavRez;', sandbox);
        return sandbox.__zavolat(123, 'potvrzena', 'dokoncena').then(() => zavolanaFetch);
      }

      const priOdmitnuti = await zavolatSPotvrzenim(false);
      assert.equal(priOdmitnuti.length, 0, 'Při odmítnutí potvrzení se nesmí odeslat ŽÁDNÝ požadavek na změnu stavu');
      console.log('OK — odmítnutí potvrzovacího dialogu u přechodu pryč z "dokoncena" neodešle žádný požadavek');

      const priPotvrzeni = await zavolatSPotvrzenim(true);
      assert.equal(priPotvrzeni.length, 1, 'Při potvrzení se musí odeslat přesně jeden požadavek na změnu stavu');
      assert.match(priPotvrzeni[0].url, /\/rezervace\/123\/stav$/);
      console.log('OK — potvrzení dialogu odešle požadavek na změnu stavu (legitimní oprava zůstává možná)');
    }

    // 5) Konzistentní úklid poukazových plateb — poukaz s VÝHRADNÍM využitím
    // (jen touhle rezervací) se smaže CELÝ; poukaz se SDÍLENÝM využitím (i
    // jinde) se zachová a vrátí se mu jen odpovídající díl zůstatku.
    console.log('--- 5) konzistentní úklid poukazových plateb ---');
    {
      // 5a) výhradní využití → poukaz zmizí celý
      const r5 = await vytvorRezervaci(polozka.id, '5');
      const poukaz5 = await adminFetch('/admin/poukazy', {
        method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-AUDIT-UKLID-POUKAZ-A (smazat)', zaplaceno: true, zpusob_platby: 'hotove' })
      }).then(r => r.json());
      await adminFetch(`/admin/poukazy/${poukaz5.poukaz.id}/uplatnit`, { method: 'POST', body: JSON.stringify({ castka: cena, rezervace_id: r5.id }) });
      await smazatRezervaciNatvrdo(r5.id);
      const stavPoukaz5 = await adminFetch('/admin/poukazy').then(r => r.json()).then(vse => vse.find(p => p.id === poukaz5.poukaz.id));
      assert.equal(stavPoukaz5, undefined, '5a) poukaz s výhradním využitím touhle rezervací musí po úklidu zcela zmizet');
      const historie5 = await adminFetch(`/admin/poukazy/${poukaz5.poukaz.id}/historie`).then(r => r.json()).catch(() => []);
      assert.equal(Array.isArray(historie5) ? historie5.length : 0, 0, '5a) historie smazaného poukazu nesmí osiřele přežívat');
      console.log('OK — 5a) poukaz s výhradním (jen testovacím) využitím se po úklidu smaže celý, beze stopy');

      // 5b) sdílené využití (i přes Rychlý prodej) → poukaz zůstane, jen se mu vrátí díl zůstatku
      // platnost_mesicu náhodné (1-200, mimo běžné hodnoty jiných testů) —
      // UNIQUE(hodnota, platnost_mesicu) by jinak při opakovaném běhu testu
      // (typ z předchozího běhu občas zůstane neuklizený) kolidovalo.
      const platnostNahodna = 20 + Math.floor(Math.random() * 180);
      const typ5bRes = await adminFetch('/admin/poukazy/typy', { method: 'POST', body: JSON.stringify({ hodnota: 2000, platnost_mesicu: platnostNahodna }) });
      const typ5b = await typ5bRes.json();
      assert.equal(typ5bRes.status, 200, JSON.stringify(typ5b));
      const poukaz5b = await adminFetch('/admin/poukazy', { method: 'POST', body: JSON.stringify({ poukaz_typ_id: typ5b.typ.id, zaplaceno: true, zpusob_platby: 'hotove' }) }).then(r => r.json());
      const prodejna5b = await adminFetch('/admin/prodejna', { method: 'POST', body: JSON.stringify({ masaz: 'TEST-AUDIT-UKLID jiné čerpání', cena: 500, poukaz_kod: poukaz5b.poukaz.kod }) }).then(r => r.json());
      const r5b = await vytvorRezervaci(polozka.id, '5b2');
      await adminFetch(`/admin/poukazy/${poukaz5b.poukaz.id}/uplatnit`, { method: 'POST', body: JSON.stringify({ castka: 300, rezervace_id: r5b.id }) });
      const poPlatbe5b = await adminFetch('/admin/poukazy').then(r => r.json()).then(vse => vse.find(p => p.id === poukaz5b.poukaz.id));
      assert.equal(Number(poPlatbe5b.zustatek), 1200, '5b) test předpoklad: 2000 − 500 (prodejna) − 300 (rezervace) = 1200');

      await smazatRezervaciNatvrdo(r5b.id);
      const poUklidu5b = await adminFetch('/admin/poukazy').then(r => r.json()).then(vse => vse.find(p => p.id === poukaz5b.poukaz.id));
      assert.ok(poUklidu5b, '5b) poukaz se SDÍLENÝM využitím nesmí po úklidu zmizet');
      assert.equal(Number(poUklidu5b.zustatek), 1500, '5b) úklid musí vrátit jen těch 300, co čerpala smazaná rezervace (1200+300=1500), ne víc, a nesmí smazat poukaz');
      console.log('OK — 5b) poukaz se sdíleným využitím (i Rychlý prodej) zůstává, vrátí se mu jen odpovídající díl zůstatku (1500 Kč)');

      // Úklid vlastní fixtury scénáře 5b
      await adminFetch(`/admin/poukazy/${poukaz5b.poukaz.id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zruseny' }) }).catch(() => {});
      await adminFetch(`/admin/prodejna/${prodejna5b.prodej.id}`, { method: 'DELETE' }).catch(() => {});
      await adminFetch(`/admin/poukazy/typy/${typ5b.typ.id}`, { method: 'DELETE' }).catch(() => {});
    }

    // 6) Opakovaný úklid stejné (už uklizené) rezervace — bezpečný no-op.
    console.log('--- 6) opakovaný úklid je bezpečný no-op ---');
    {
      const r6 = await vytvorRezervaci(polozka.id, '6');
      await zaplatitPresApi(r6.id, cena);
      await smazatRezervaciNatvrdo(r6.id);
      // Druhé spuštění na STEJNÉ (už neexistující) id nesmí spadnout ani nic změnit.
      await smazatRezervaciNatvrdo(r6.id);
      const existuje6 = await adminFetch('/admin/rezervace').then(r => r.json()).then(vse => vse.some(x => x.id === r6.id));
      assert.equal(existuje6, false);
      console.log('OK — opakovaný úklid stejné rezervace neselže a nic dalšího nezmění');
    }

    // 7) Odmítnutí produkční DATABASE_URL pro úklidovou funkci — ve
    // SAMOSTATNÉM procesu (tenhle proces už má DB_URL ověřené na TEST).
    console.log('--- 7) smazatRezervaciNatvrdo odmítne produkční DATABASE_URL ---');
    {
      // ziskatTestDatabaseUrl() volá process.exit(1) (ne throw) — dítě proto
      // skončí nenulovým kódem, execFileSync to vyhodí jako chybu s .status
      // a .stderr (console.error jde na stderr, ne stdout).
      const skript = `
        const { smazatRezervaciNatvrdo } = require(${JSON.stringify(path.join(__dirname, 'test-helpers.js'))});
        smazatRezervaciNatvrdo(1).then(() => console.log('PROSLO-NEOCEKAVANE')).catch(e => console.log('CHYBA:' + e.message));
      `;
      let vyhozenaChyba = null;
      try {
        execFileSync(process.execPath, ['-e', skript], {
          env: { ...process.env, DATABASE_URL: 'postgresql://user:pass@aws-1-eu-west-1.pooler.supabase.com:5432/postgres' },
          timeout: 10000
        });
      } catch (e) {
        vyhozenaChyba = e;
      }
      assert.ok(vyhozenaChyba, 'smazatRezervaciNatvrdo s produkční DATABASE_URL musí proces ukončit nenulovým kódem (process.exit(1))');
      assert.equal(vyhozenaChyba.status, 1);
      const stderr = vyhozenaChyba.stderr.toString();
      assert.match(stderr, /PRODUKČNÍ databázi/, 'Hláška na stderr musí jasně zmínit produkční databázi: ' + stderr);
      const stdout = (vyhozenaChyba.stdout || Buffer.from('')).toString();
      assert.doesNotMatch(stdout, /PROSLO-NEOCEKAVANE/, 'smazatRezervaciNatvrdo nesmí s produkční DATABASE_URL nic provést');
      console.log('OK — smazatRezervaciNatvrdo s produkční DATABASE_URL odmítne spuštění ještě před připojením (samostatný proces, exit 1)');
    }

    console.log('\n✅ VŠECHNY TESTY AUDITU A ÚKLIDU REZERVACÍ PROŠLY');
  } finally {
    for (const id of uklidRezervace) {
      await smazatRezervaciNatvrdo(id).catch(() => {});
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

async function zaplatitPresApi(id, castka) {
  const r = await adminFetch(`/admin/rezervace/${id}/platba`, { method: 'PATCH', body: JSON.stringify({ castka, zpusob_platby: 'hotove' }) });
  assert.equal(r.status, 200);
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
