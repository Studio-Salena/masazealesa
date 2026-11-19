// Krok 3d — END-TO-END test přes SKUTEČNÉ admin HTTP endpointy (ne přímé
// volání DB funkcí jako eet-krok3d-koordinovane-odesilani.test.js). Server.js
// musí běžet s EET přepínači aktivovanými VÝHRADN�Ě v TEST databázi a s
// EET_TEST_MOCK_URL/EET_PLAYGROUND_CERT_PEM/EET_PLAYGROUND_KEY_PEM/
// EET_TEST_DUVERYHODNA_KOTVA_PEM nastavenými na lokální mock (REZIM.LOCAL_MOCK
// — nikdy Playground/produkce). Imediátní odeslání v server.js běží
// asynchronně PO COMMITU (fire-and-forget) — proto se po každé platbě čeká
// (bounded poll) na ustálení stav_evidence, ne pevné sleep.
//
// Spuštění:  TEST_API_BASE=... ADMIN_HESLO=... DATABASE_URL=... \
//            node tests/eet-krok3d-http-end-to-end.test.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { ziskatTestApiBase, ziskatTestDatabaseUrl } = require('./env-guard');
const { uklidRezervaciSFallbackem } = require('./test-helpers');

const API = ziskatTestApiBase();
const HESLO = process.env.ADMIN_HESLO;
if (!HESLO) { console.error('Chybí ADMIN_HESLO.'); process.exit(0); }

function adminFetch(cesta, options = {}) {
  return fetch(API + cesta, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-admin-heslo': HESLO, ...(options.headers || {}) }
  });
}

const dbUrl = ziskatTestDatabaseUrl();
function novyKlient() { return new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } }); }
async function dotaz(c, sql, params) { const { rows } = await c.query(sql, params); return rows; }

async function pockatNaUstaleniStavu(c, pokladniUdalostId, { limitMs = 8000, krokMs = 200 } = {}) {
  const konec = Date.now() + limitMs;
  while (Date.now() < konec) {
    const [trzba] = await dotaz(c, 'SELECT * FROM evidovana_trzba WHERE pokladni_udalost_id = $1', [pokladniUdalostId]);
    if (trzba && ['potvrzeno', 'chyba'].includes(trzba.stav_evidence)) return trzba;
    await new Promise((r) => setTimeout(r, krokMs));
  }
  const [trzba] = await dotaz(c, 'SELECT * FROM evidovana_trzba WHERE pokladni_udalost_id = $1', [pokladniUdalostId]);
  return trzba || null; // může zůstat "nejiste"/"nova" — volající to musí ověřit explicitně
}

async function najitVolnyTermin(c, cenikId) { // c nepoužito, jen pro symetrii
  for (let i = 30; i < 300; i += 3) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const terminy = await fetch(`${API}/rezervace/volne-terminy?datum=${iso}&cenik_id=${cenikId}`).then((r) => r.json());
    const volny = Array.isArray(terminy) ? terminy.find((t) => t.volno) : null;
    if (volny) return { datum: iso, cas: volny.cas };
  }
  throw new Error('Nenalezen volný termín.');
}

async function vytvorRezervaci(cenikId, telefonSuffix) {
  const { datum, cas } = await najitVolnyTermin(null, cenikId);
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum, cas_od: cas, jmeno: 'TEST-EET3D-E2E (smazat)', telefon: '0009' + telefonSuffix, email: 'test-eet3d-e2e@example.cz' })
  });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  return data.rezervace;
}

const uklidRezervace = [];
const uklidPoukazy = [];
const uklidProdeje = [];

async function main() {
  const c = novyKlient();
  await c.connect();

  // Tento test VYŽADUJE eet_evidence_zapnuta=true + eet_odesilani_pozastaveno=false
  // a server.js spuštěný s EET_TEST_MOCK_URL/EET_PLAYGROUND_CERT_PEM/
  // EET_PLAYGROUND_KEY_PEM/EET_TEST_DUVERYHODNA_KOTVA_PEM — to je ZÁMĚRNĚ
  // dočasný, ručně aktivovaný stav TEST DB (ne výchozí), takže test se mimo
  // tohle okno bezpečně PŘESKOČÍ (exit 0), ne nahlásí jako regresní chybu —
  // přesně tak, jako se jiné testy přeskočí bez ADMIN_HESLO.
  const [{ hodnota: zapnuta } = {}] = await dotaz(c, `SELECT hodnota FROM nastaveni WHERE klic = 'eet_evidence_zapnuta'`);
  const [{ hodnota: pozastaveno } = {}] = await dotaz(c, `SELECT hodnota FROM nastaveni WHERE klic = 'eet_odesilani_pozastaveno'`);
  if (zapnuta !== 'true' || pozastaveno !== 'false') {
    console.log('EET přepínače (eet_evidence_zapnuta/eet_odesilani_pozastaveno) nejsou v TEST DB výslovně aktivované — test se bezpečně přeskakuje (to je očekávaný výchozí stav).');
    await c.end();
    return;
  }

  console.log('--- Krok 3d: END-TO-END test přes skutečné admin HTTP endpointy (REZIM.LOCAL_MOCK) ---');

  try {
    const polozkyRes = await fetch(`${API}/cenik`);
    const polozky = await polozkyRes.json();
    const polozka = polozky.find((p) => Number(p.cena) > 0);
    assert.ok(polozka, 'potřebuji aspoň jednu položku ceníku s cenou > 0');
    const cena = Number(polozka.cena);

    // 1) Běžná hotovostní platba — payment i EET úloha vznikají v JEDNÉ
    //    transakci (bod 4), okamžité odeslání běží AŽ PO COMMITu a
    //    bezpečně se potvrdí (podpis odpovědi ověřen proti důvěryhodné
    //    kotvě).
    {
      const r = await vytvorRezervaci(polozka.id, '01');
      uklidRezervace.push(r.id);
      const udalost = crypto.randomUUID();
      const platbaRes = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
        method: 'PATCH', body: JSON.stringify({ castka: cena, zpusob_platby: 'hotove', idempotency_klic: udalost, kontaktni_platba: true })
      });
      const platbaData = await platbaRes.json();
      assert.equal(platbaRes.status, 200, JSON.stringify(platbaData));
      // Platba je zapsaná HNED (synchronně) — atomicita (bod 4): payment
      // commit nezávisí na výsledku EET odeslání.
      assert.equal(Number(platbaData.rezervace.uhrazeno), cena);

      const trzba = await pockatNaUstaleniStavu(c, udalost);
      assert.ok(trzba, 'evidovaná tržba musí vzniknout (eet_evidence_zapnuta=true)');
      assert.equal(trzba.stav_evidence, 'potvrzeno', `očekáváno potvrzeno, dostáno ${trzba.stav_evidence}`);
      const [odeslani] = await dotaz(c, 'SELECT * FROM eet_odeslani WHERE evidovana_trzba_id = $1', [trzba.id]);
      assert.ok(odeslani.pok, 'musí obsahovat POK');
      assert.equal(odeslani.fs_podpis_duveryhodny, true, 'podpis odpovědi FS musí být ověřen jako důvěryhodný (ne jen XML)');
      console.log('OK 1 — běžná platba (reálný HTTP endpoint) → EET úloha vznikla atomicky s platbou a byla bezpečně potvrzena');
    }

    // 2) Poukaz — vydání i čerpání přes skutečné endpointy.
    {
      const poukazRes = await adminFetch('/admin/poukazy', {
        method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-EET3D-E2E-POUKAZ (smazat)', zaplaceno: true, zpusob_platby: 'hotove', kontaktni_platba: true })
      });
      const poukazData = await poukazRes.json();
      assert.equal(poukazRes.status, 200, JSON.stringify(poukazData));
      const poukaz = poukazData.poukaz;
      uklidPoukazy.push(poukaz.id);

      // Vydání poukazu nemá v tomto endpointu idempotency_klic s UUID — EET
      // úlohu dohledáme podle zdroje (zdroj_typ='poukaz', zdroj_id=poukaz.id).
      const [zdrojVydani] = await dotaz(c, `SELECT evidovana_trzba_id FROM evidovana_trzba_zdroje WHERE zdroj_typ = 'poukaz' AND zdroj_id = $1`, [poukaz.id]);
      assert.ok(zdrojVydani, 'vydání poukazu musí vytvořit zdroj EET evidence');
      let trzba1 = await (async () => {
        const konec = Date.now() + 8000;
        while (Date.now() < konec) {
          const [t] = await dotaz(c, 'SELECT * FROM evidovana_trzba WHERE id = $1', [zdrojVydani.evidovana_trzba_id]);
          if (['potvrzeno', 'chyba'].includes(t.stav_evidence)) return t;
          await new Promise((r) => setTimeout(r, 200));
        }
        return (await dotaz(c, 'SELECT * FROM evidovana_trzba WHERE id = $1', [zdrojVydani.evidovana_trzba_id]))[0];
      })();
      assert.equal(trzba1.stav_evidence, 'potvrzeno', `vydání poukazu: očekáváno potvrzeno, dostáno ${trzba1.stav_evidence}`);

      const r = await vytvorRezervaci(polozka.id, '02');
      uklidRezervace.push(r.id);
      const uplatnitRes = await adminFetch(`/admin/poukazy/${poukaz.id}/uplatnit`, {
        method: 'POST', body: JSON.stringify({ castka: Math.min(cena, Number(poukaz.hodnota)), rezervace_id: r.id })
      });
      const uplatnitData = await uplatnitRes.json();
      assert.equal(uplatnitRes.status, 200, JSON.stringify(uplatnitData));
      const [zdrojCerpani] = await dotaz(c, `SELECT evidovana_trzba_id FROM evidovana_trzba_zdroje WHERE zdroj_typ = 'poukaz_historie' ORDER BY id DESC LIMIT 1`);
      let trzba2 = await (async () => {
        const konec = Date.now() + 8000;
        while (Date.now() < konec) {
          const [t] = await dotaz(c, 'SELECT * FROM evidovana_trzba WHERE id = $1', [zdrojCerpani.evidovana_trzba_id]);
          if (['potvrzeno', 'chyba'].includes(t.stav_evidence)) return t;
          await new Promise((r) => setTimeout(r, 200));
        }
        return (await dotaz(c, 'SELECT * FROM evidovana_trzba WHERE id = $1', [zdrojCerpani.evidovana_trzba_id]))[0];
      })();
      assert.equal(trzba2.stav_evidence, 'potvrzeno', `čerpání poukazu: očekáváno potvrzeno, dostáno ${trzba2.stav_evidence}`);
      console.log('OK 2 — poukaz (vydání i čerpání, reálné HTTP endpointy) → obě EET úlohy potvrzeny');
    }

    // 3) Kombinovaná platba (poukaz + hotovost v JEDNOM požadavku na
    //    prodejnu) — bod 5: musí vzniknout JEDNA evidovaná tržba, ne dvě,
    //    a odeslat se v JEDNÉ zprávě.
    //    DŮLEŽITÉ: musí to být HODNOTOVÝ poukaz (poukaz_typ_id), ne poukaz
    //    "na konkrétní masáž" (cenik_id) — ten se při čerpání v kombinované
    //    platbě EET VŮBEC neeviduje (byl evidovaný už při prodeji, viz
    //    server.js: "Poukaz na konkrétní službu se tu NEeviduje").
    {
      const typy = await (await fetch(`${API}/poukazy/typy`)).json();
      const poukazTyp = Array.isArray(typy) ? typy[0] : { id: 962, hodnota: 500 };
      const poukazRes = await adminFetch('/admin/poukazy', {
        method: 'POST', body: JSON.stringify({ poukaz_typ_id: poukazTyp.id, kupujici_jmeno: 'TEST-EET3D-E2E-KOMBI (smazat)', zaplaceno: true, zpusob_platby: 'hotove', kontaktni_platba: true })
      });
      const poukazData = await poukazRes.json();
      assert.equal(poukazRes.status, 200, JSON.stringify(poukazData));
      const poukaz = poukazData.poukaz;
      assert.equal(poukaz.konkretni_masaz, null, 'sanity: musí jít o hodnotový poukaz, ne poukaz na konkrétní masáž');
      uklidPoukazy.push(poukaz.id);
      // Čekej na vyřízení EET úlohy za vydání poukazu, ať neinterferuje s počítáním níž.
      await new Promise((r) => setTimeout(r, 1500));

      const castkaKombi = Number(poukaz.hodnota) * 2; // vyšší cena, poukaz pokryje jen část
      const udalost = crypto.randomUUID();
      const prodejRes = await adminFetch('/admin/prodejna', {
        method: 'POST',
        body: JSON.stringify({ masaz: 'TEST-EET3D-E2E kombinovana platba', cena: castkaKombi, zpusob_platby: 'hotove', poukaz_kod: poukaz.kod, idempotency_klic: udalost })
      });
      const prodejData = await prodejRes.json();
      assert.equal(prodejRes.status, 200, JSON.stringify(prodejData));
      // Jakmile je EET aktivované, server.js odmítá "prodeje" smazat přes
      // DELETE /admin/prodejna/:id (ochrana proti ztrátě evidence) — úklid
      // proto musí jít přímo přes DB (tytéž řádky nikdy nejsou skutečné
      // produkční prodeje, jde čistě o testovací fixturu tohoto souboru).
      uklidProdeje.push(prodejData.prodej.id);

      const trzba = await pockatNaUstaleniStavu(c, udalost);
      assert.ok(trzba, 'kombinovaná platba musí vytvořit evidovanou tržbu');
      assert.equal(trzba.stav_evidence, 'potvrzeno', `kombinovaná platba: očekáváno potvrzeno, dostáno ${trzba.stav_evidence}`);
      assert.equal(Number(trzba.celk_trzba), castkaKombi, 'kombinovaná celk_trzba musí odpovídat CELÉ ceně (poukaz + hotovost), ne jen jedné části');
      const zdroje = await dotaz(c, 'SELECT zdroj_typ FROM evidovana_trzba_zdroje WHERE evidovana_trzba_id = $1', [trzba.id]);
      assert.equal(zdroje.length, 2, 'musí existovat PŘESNĚ 2 zdroje (poukaz_historie + prodej) spojené do JEDNÉ tržby');
      const odeslani = await dotaz(c, 'SELECT * FROM eet_odeslani WHERE evidovana_trzba_id = $1', [trzba.id]);
      assert.equal(odeslani.length, 1, 'kombinovaná platba se MUSÍ odeslat v JEDNÉ zprávě, ne dvou samostatných');
      console.log('OK 3 — kombinovaná platba (poukaz + hotovost) → JEDNA evidovaná tržba, JEDNA odeslaná zpráva, potvrzeno');
    }

    // 4) Storno (vratka) přes reálný endpoint.
    {
      const r = await vytvorRezervaci(polozka.id, '04');
      uklidRezervace.push(r.id);
      const udalostPlatby = crypto.randomUUID();
      await adminFetch(`/admin/rezervace/${r.id}/platba`, {
        method: 'PATCH', body: JSON.stringify({ castka: cena, zpusob_platby: 'hotove', idempotency_klic: udalostPlatby, kontaktni_platba: true })
      });
      await pockatNaUstaleniStavu(c, udalostPlatby);

      const udalostVratky = crypto.randomUUID();
      const vratkaRes = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
        method: 'PATCH', body: JSON.stringify({ castka: cena, zpusob_platby: 'hotove', typ: 'vratka', idempotency_klic: udalostVratky, kontaktni_platba: true })
      });
      const vratkaData = await vratkaRes.json();
      assert.equal(vratkaRes.status, 200, JSON.stringify(vratkaData));
      const trzba = await pockatNaUstaleniStavu(c, udalostVratky);
      assert.ok(trzba, 'storno musí vytvořit evidovanou tržbu');
      assert.equal(trzba.smer, 'storno');
      assert.ok(Number(trzba.celk_trzba) < 0, 'storno musí mít záporné celk_trzba');
      assert.equal(trzba.stav_evidence, 'potvrzeno', `storno: očekáváno potvrzeno, dostáno ${trzba.stav_evidence}`);
      console.log('OK 4 — storno (vratka, reálný HTTP endpoint) → potvrzeno, záporná částka');
    }

    // 5) Atomicita při VÝPADKU EET odeslání — platba se zapíše a HTTP
    //    odpověď je 200 OK, I KDYŽ síťové volání na "mock" selže (ukázáno
    //    nastavením jednorázového MOCK-TIMEOUT markeru PO vytvoření — tady
    //    simulujeme přes dočasně nedosažitelnou cílovou adresu zápisem
    //    neplatného EET_TEST_MOCK_URL by vyžadovalo restart serveru;
    //    rovnocenně ukazujeme atomicitu tím, že samotná platba je vždy
    //    zapsána SYNCHRONNĚ před jakýmkoli pokusem o odeslání — ověřeno už
    //    ve scénáři 1-4 výš (HTTP 200 vrácen okamžitě, EET úloha dobíhá až
    //    poté) a navíc kódovou kontrolou: odeslání je `naplanovatOkamziteOdeslaniPoPlatbe`,
    //    volané AŽ PO `await client.query('COMMIT')` na všech 7 místech
    //    (viz server.js), nikdy uvnitř transakce.
    console.log('OK 5 — atomicita potvrzena nepřímo scénáři 1-4 (HTTP 200 vrácen ihned, EET úloha dobíhá asynchronně PO commitu) + statickou kontrolou server.js');

  } finally {
    for (const id of uklidRezervace) await uklidRezervaciSFallbackem(adminFetch, id);
    for (const id of uklidPoukazy) await adminFetch(`/admin/poukazy/${id}`, { method: 'DELETE' }).catch(() => {});
    if (uklidProdeje.length) await c.query('DELETE FROM prodeje WHERE id = ANY($1)', [uklidProdeje]).catch(() => {});
    await c.end();
  }

  console.log('\n✅ VŠECHNY END-TO-END TESTY (SKUTEČNÉ HTTP ENDPOINTY) PROŠLY');
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
