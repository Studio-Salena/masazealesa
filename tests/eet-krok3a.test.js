// Regresní test: Krok 3a přípravy na EET 2.0 — databázový základ
// (evidované tržby). Testuje výhradně nové DB funkce/tabulky přímým SQL —
// Krok 3a záměrně NENÍ napojený na žádný HTTP endpoint (to až Krok 3b),
// takže tenhle test nepoužívá adminFetch/TEST_API_BASE, jen přímé
// připojení k TEST databázi (ziskatTestDatabaseUrl — fail-closed, nikdy
// produkce).
//
// Cíl testu:
//  1) Idempotence: opakované zaevidování TÉHOŽ zdroje nikdy nepřičte částku
//     dvakrát (ani sekvenčně, ani při skutečném souběhu).
//  2) Sloučení podle pokladni_udalost_id: různé zdroje se stejným UUID se
//     sečtou do jedné evidované tržby; jiné UUID = jiná evidovaná tržba —
//     ŽÁDNÁ heuristika podle data/rezervace.
//  3) Deduplikační klíč (id_jednotky, id_pokl, porad_cis, dat_trzby) je
//     vynucen na úrovni DB, ne jen aplikací.
//  4) Fronta: SELECT...FOR UPDATE SKIP LOCKED nikdy nepřidělí stejný řádek
//     dvěma souběžným workerům; "stale" claim (>5 min) jde převzít znovu.
//  5) Zápis výsledku je chráněný proti dokončení starým/zpožděným pokusem
//     (compare-and-swap podle aktualni_pokus_id).
//  6) Identifikační údaje evidované tržby jsou neměnné PO prvním odeslání,
//     ale provozní pole (stav_evidence, poznámka) se měnit smí.
//  7) Záznamy v eet_odeslani se nikdy nemažou.
//  8) eet_pripojeni_test je strukturálně oddělené od reálných dat (žádná
//     vazba na evidovana_trzba) a chrání si vlastní "prostredi".
//  9) Migrace nic automaticky nezaeviduje ze starých dat (ověřeno i tady,
//     ne jen v migračním skriptu).
//
// Spuštění:  DATABASE_URL=... node tests/eet-krok3a.test.js

const assert = require('node:assert/strict');
const { Client } = require('pg');
const { ziskatTestDatabaseUrl } = require('./env-guard');

const DB_URL = ziskatTestDatabaseUrl();

function novyKlient() {
  return new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
}

async function dotaz(client, sql, params) {
  const { rows } = await client.query(sql, params);
  return rows;
}

// Úklid — mažeme jen řádky vytvořené TÍMHLE testem (podle vlastních ID), ne
// celé tabulky. eet_odeslani má ochranný trigger proti mazání — úklid proto
// jde přímo přes DELETE FROM eet_odeslani jen tehdy, když to trigger dovolí
// (nedovolí nikdy) — takže testovací eet_odeslani řádky se NEMAŽOU, zůstanou
// v TEST DB jako běžná auditní historie (stejný princip jako "poukazy_historie"
// jinde v projektu — má to i produkční chování ověřit).
const uklidTrzby = [];
const uklidZdroje = [];
let c1 = null; // uzavírá se v .finally() níž, aby chyba/assert uprostřed testu nenechala proces viset

async function main() {
  c1 = novyKlient();
  await c1.connect();

  console.log('--- Krok 3a EET: databázový základ ---');

  // 0) Migrace nic automaticky nezaeviduje
  {
    const existujiciPlatby = await dotaz(c1, 'SELECT count(*)::int AS pocet FROM platby');
    const existujiciZdroje = await dotaz(c1, 'SELECT count(*)::int AS pocet FROM evidovana_trzba_zdroje WHERE zdroj_typ = $1', ['platba']);
    // Pokud existují historické platby, žádná z nich nesmí mít automaticky
    // vytvořený zdrojový záznam — Krok 3a na platby vůbec nesahá.
    if (Number(existujiciPlatby[0].pocet) > 0) {
      assert.equal(Number(existujiciZdroje[0].pocet), 0, '0) žádná historická platba nesmí mít automaticky založený zdrojový záznam EET');
    }
    console.log('OK — 0) migrace nic automaticky nezaeviduje ze starých dat');
  }

  const idJednotky = 'TEST-EET3A-JEDNOTKA';
  const idPokl = 'TEST-EET3A-POKL';

  // 1) Idempotence — opakované zaevidování téhož zdroje (sekvenčně)
  {
    const udalost = randomUUID();
    const r1 = (await dotaz(c1,
      `SELECT * FROM eet_zaevidovat_zdroj($1,'prijem','platba',$2,100,$3,$4,now())`,
      [udalost, 999001, idJednotky, idPokl]))[0];
    assert.equal(r1.nove_zapocitano, true, '1a) první zaevidování musí nahlásit nove_zapocitano=true');
    uklidTrzby.push(r1.trzba_id);
    uklidZdroje.push(['platba', 999001]);

    const r2 = (await dotaz(c1,
      `SELECT * FROM eet_zaevidovat_zdroj($1,'prijem','platba',$2,100,$3,$4,now())`,
      [udalost, 999001, idJednotky, idPokl]))[0];
    assert.equal(r2.nove_zapocitano, false, '1b) OPAKOVANÉ zaevidování STEJNÉHO zdroje musí nahlásit nove_zapocitano=false');
    assert.equal(r2.trzba_id, r1.trzba_id, '1b) opakování musí ukázat na STEJNOU evidovanou tržbu');

    const trzba = (await dotaz(c1, 'SELECT celk_trzba FROM evidovana_trzba WHERE id = $1', [r1.trzba_id]))[0];
    assert.equal(Number(trzba.celk_trzba), 100, '1c) celk_trzba nesmí být připočtena dvakrát — musí zůstat přesně 100, ne 200');
    console.log('OK — 1) idempotence: opakované zaevidování téhož zdroje nikdy nepřičte částku dvakrát');
  }

  // 1d) Idempotence při SKUTEČNÉM souběhu (10 souběžných pokusů o TENTÝŽ zdroj, z 5 různých DB spojení)
  {
    const udalost = randomUUID();
    const kliency = await Promise.all(Array.from({ length: 5 }, async () => { const c = novyKlient(); await c.connect(); return c; }));
    const pokusy = [];
    for (let i = 0; i < 10; i++) {
      const klient = kliency[i % kliency.length];
      pokusy.push(dotaz(klient, `SELECT * FROM eet_zaevidovat_zdroj($1,'prijem','platba',$2,50,$3,$4,now())`, [udalost, 999002, idJednotky, idPokl]));
    }
    const vysledky = (await Promise.all(pokusy)).map(r => r[0]);
    await Promise.all(kliency.map(k => k.end()));

    const uspesnych = vysledky.filter(r => r.nove_zapocitano === true).length;
    assert.equal(uspesnych, 1, `1d) při 10 SOUBĚŽNÝCH pokusech o zaevidování téhož zdroje smí uspět (nove_zapocitano=true) přesně JEDEN, ne ${uspesnych}`);
    const trzbaId = vysledky[0].trzba_id;
    uklidTrzby.push(trzbaId);
    uklidZdroje.push(['platba', 999002]);
    const trzba = (await dotaz(c1, 'SELECT celk_trzba FROM evidovana_trzba WHERE id = $1', [trzbaId]))[0];
    assert.equal(Number(trzba.celk_trzba), 50, '1e) i při souběhu musí celk_trzba zůstat přesně 50, ne násobek');
    console.log('OK — 1d-e) idempotence je bezpečná i při skutečném databázovém souběhu (10 souběžných pokusů, 1 se započítal)');
  }

  // 2) Sloučení podle pokladni_udalost_id (žádná heuristika podle data/rezervace)
  {
    const udalost = randomUUID();
    const zaloha = (await dotaz(c1, `SELECT * FROM eet_zaevidovat_zdroj($1,'prijem','platba',$2,300,$3,$4,now())`, [udalost, 999003, idJednotky, idPokl]))[0];
    const doplatek = (await dotaz(c1, `SELECT * FROM eet_zaevidovat_zdroj($1,'prijem','poukaz_historie',$2,200,$3,$4,now())`, [udalost, 999004, idJednotky, idPokl]))[0];
    uklidTrzby.push(zaloha.trzba_id, doplatek.trzba_id);
    uklidZdroje.push(['platba', 999003], ['poukaz_historie', 999004]);

    assert.equal(zaloha.trzba_id, doplatek.trzba_id, '2a) dva RŮZNÉ zdroje se STEJNÝM pokladni_udalost_id se musí sloučit do JEDNÉ evidované tržby');
    const spojena = (await dotaz(c1, 'SELECT celk_trzba FROM evidovana_trzba WHERE id = $1', [zaloha.trzba_id]))[0];
    assert.equal(Number(spojena.celk_trzba), 500, '2b) sloučená evidovaná tržba musí mít součet obou zdrojů (300+200=500)');

    // Jiný pokladni_udalost_id = jiná evidovaná tržba, I KDYBY šlo o stejný
    // den a stejnou "rezervaci" (tady simulováno jen tím, že žádná heuristika
    // o datu/rezervaci nikde v kódu funkce vůbec neexistuje).
    const jinaUdalost = randomUUID();
    const nezavisly = (await dotaz(c1, `SELECT * FROM eet_zaevidovat_zdroj($1,'prijem','platba',$2,300,$3,$4,now())`, [jinaUdalost, 999005, idJednotky, idPokl]))[0];
    uklidTrzby.push(nezavisly.trzba_id);
    uklidZdroje.push(['platba', 999005]);
    assert.notEqual(nezavisly.trzba_id, zaloha.trzba_id, '2c) jiný pokladni_udalost_id musí vždy založit SAMOSTATNOU evidovanou tržbu, bez ohledu na čas/datum');
    console.log('OK — 2) sloučení řídí výhradně explicitní pokladni_udalost_id, žádná heuristika podle data ani rezervace');
  }

  // 3) Deduplikační klíč (id_jednotky, id_pokl, porad_cis, dat_trzby) vynucený na úrovni DB
  {
    const datumTrzby = new Date();
    const udalost1 = randomUUID();
    const prvni = (await dotaz(c1, `SELECT * FROM eet_zaevidovat_zdroj($1,'prijem','platba',$2,10,$3,$4,$5)`, [udalost1, 999006, idJednotky, idPokl, datumTrzby]))[0];
    uklidTrzby.push(prvni.trzba_id);
    uklidZdroje.push(['platba', 999006]);
    const porad = (await dotaz(c1, 'SELECT porad_cis FROM evidovana_trzba WHERE id = $1', [prvni.trzba_id]))[0].porad_cis;

    // Přímý pokus vložit DRUHOU evidovanou tržbu se STEJNOU čtveřicí
    // (id_jednotky, id_pokl, porad_cis, dat_trzby) — musí selhat na UNIQUE,
    // bez ohledu na to, že jde o jiný pokladni_udalost_id.
    let chyba = null;
    try {
      await c1.query(
        `INSERT INTO evidovana_trzba (pokladni_udalost_id, smer, celk_trzba, id_jednotky, id_pokl, porad_cis, dat_trzby) VALUES ($1,'prijem',10,$2,$3,$4,$5)`,
        [randomUUID(), idJednotky, idPokl, porad, datumTrzby]
      );
    } catch (e) { chyba = e; }
    assert.ok(chyba && chyba.code === '23505', '3) duplicitní (id_jednotky, id_pokl, porad_cis, dat_trzby) musí být odmítnuté UNIQUE constraintem na úrovni DB');
    console.log('OK — 3) deduplikační klíč (id_jednotky, id_pokl, porad_cis, dat_trzby) je vynucený databází, ne jen aplikací');
  }

  // 4) Fronta — SKIP LOCKED nikdy nepřidělí stejný řádek dvěma workerům
  {
    const idy = [];
    for (let i = 0; i < 6; i++) {
      const udalost = randomUUID();
      const r = (await dotaz(c1, `SELECT * FROM eet_zaevidovat_zdroj($1,'prijem','platba',$2,1,$3,$4,now())`, [udalost, 999100 + i, idJednotky, idPokl]))[0];
      idy.push(r.trzba_id);
      uklidTrzby.push(r.trzba_id);
      uklidZdroje.push(['platba', 999100 + i]);
    }

    // Filtr "WHERE id = ANY($1)" MUSÍ být uvnitř CTE funkce (ne až na
    // výsledku) — jinak by starší 'nova' řádky z předchozích scénářů (ty
    // mají nižší id, takže je "ORDER BY id LIMIT" vybere dřív) vyčerpaly
    // limit dřív, než se dostane na těchhle 6 testovacích řádků.
    const cA = novyKlient(); await cA.connect();
    const cB = novyKlient(); await cB.connect();
    await cA.query('BEGIN');
    await cB.query('BEGIN');
    const [davkaA, davkaB] = await Promise.all([
      dotaz(cA, `WITH davka AS (SELECT * FROM eet_zamknout_dalsi_davku('worker-A', 50)) SELECT id FROM davka WHERE id = ANY($1)`, [idy]),
      dotaz(cB, `WITH davka AS (SELECT * FROM eet_zamknout_dalsi_davku('worker-B', 50)) SELECT id FROM davka WHERE id = ANY($1)`, [idy]),
    ]);
    await cA.query('COMMIT');
    await cB.query('COMMIT');
    await cA.end(); await cB.end();

    const idyA = davkaA.map(r => r.id);
    const idyB = davkaB.map(r => r.id);
    const prunik = idyA.filter(id => idyB.includes(id));
    assert.equal(prunik.length, 0, `4a) dva souběžní workeři nesmí NIKDY dostat stejný řádek fronty (průnik: ${JSON.stringify(prunik)})`);
    const sjednoceni = new Set([...idyA, ...idyB]);
    const pokryto = idy.every(id => sjednoceni.has(id));
    assert.ok(pokryto, `4b) dohromady musí oba workeři rozebrat všech 6 testovacích řádků (chybí: ${JSON.stringify(idy.filter(id => !sjednoceni.has(id)))})`);
    console.log('OK — 4) fronta: SELECT...FOR UPDATE SKIP LOCKED bezpečně rozděluje úlohy mezi souběžné workery, žádný duplicitní příděl');
  }

  // 4c) Stale claim (>5 minut) jde převzít znovu s NOVÝM aktualni_pokus_id
  {
    const udalost = randomUUID();
    const r = (await dotaz(c1, `SELECT * FROM eet_zaevidovat_zdroj($1,'prijem','platba',$2,1,$3,$4,now())`, [udalost, 999200, idJednotky, idPokl]))[0];
    uklidTrzby.push(r.trzba_id);
    uklidZdroje.push(['platba', 999200]);

    const prvniPrevzeti = (await dotaz(c1, `SELECT * FROM eet_zamknout_dalsi_davku('worker-stary', 50) WHERE id = $1`, [r.trzba_id]))[0];
    assert.ok(prvniPrevzeti, '4c) první převzetí musí uspět');
    const starePokusId = prvniPrevzeti.aktualni_pokus_id;

    // Simulace spadlého workera — uměle posuneme zpracovava_se_od do minulosti.
    await c1.query(`UPDATE evidovana_trzba SET zpracovava_se_od = now() - interval '10 minutes' WHERE id = $1`, [r.trzba_id]);

    const druhePrevzeti = (await dotaz(c1, `SELECT * FROM eet_zamknout_dalsi_davku('worker-novy', 50) WHERE id = $1`, [r.trzba_id]))[0];
    assert.ok(druhePrevzeti, '4d) "stale" claim (starší než 5 minut) musí jít převzít znovu');
    assert.notEqual(druhePrevzeti.aktualni_pokus_id, starePokusId, '4e) nové převzetí musí dostat NOVÉ aktualni_pokus_id, ne to staré');
    console.log('OK — 4c-e) stale claim (spadlý worker) jde bezpečně převzít znovu, s novým identifikátorem pokusu');

    // 5) Compare-and-swap: zápis výsledku STARÝM pokusem po převzetí novým musí selhat (tiše, zapsano=false)
    const starySelzeZapis = (await dotaz(c1,
      `SELECT * FROM eet_zapsat_vysledek($1,$2,'potvrzeno',$3,true,'potvrzeno','POK-TEST')`,
      [r.trzba_id, starePokusId, randomUUID()]))[0];
    assert.equal(starySelzeZapis.zapsano, false, '5a) zápis výsledku STARÝM (už nahrazeným) pokusem nesmí uspět');
    const stavPoStaremPokusu = (await dotaz(c1, 'SELECT stav_evidence, aktualni_pokus_id FROM evidovana_trzba WHERE id = $1', [r.trzba_id]))[0];
    assert.equal(stavPoStaremPokusu.aktualni_pokus_id, druhePrevzeti.aktualni_pokus_id, '5b) starý pokus nesmí ovlivnit aktuální stav — aktualni_pokus_id zůstává nové');

    const novyUspejeZapis = (await dotaz(c1,
      `SELECT * FROM eet_zapsat_vysledek($1,$2,'potvrzeno',$3,true,'potvrzeno','POK-TEST')`,
      [r.trzba_id, druhePrevzeti.aktualni_pokus_id, randomUUID()]))[0];
    assert.equal(novyUspejeZapis.zapsano, true, '5c) zápis výsledku AKTUÁLNÍM pokusem musí uspět');
    const stavFinal = (await dotaz(c1, 'SELECT stav_evidence FROM evidovana_trzba WHERE id = $1', [r.trzba_id]))[0];
    assert.equal(stavFinal.stav_evidence, 'potvrzeno', '5d) po úspěšném zápisu musí být stav_evidence přesně "potvrzeno"');
    console.log('OK — 5) zápis výsledku je chráněný proti dokončení starým/zpožděným pokusem (compare-and-swap)');

    // 6) Neměnnost identifikačních údajů PO prvním odeslání
    let chybaZmeny = null;
    try {
      await c1.query('UPDATE evidovana_trzba SET celk_trzba = 99999 WHERE id = $1', [r.trzba_id]);
    } catch (e) { chybaZmeny = e; }
    assert.ok(chybaZmeny, '6a) po prvním odeslání nesmí jít změnit celk_trzba');
    assert.match(chybaZmeny.message, /nelze měnit po prvním odeslání/, '6a) chybová zpráva musí jasně vysvětlit důvod');

    // Provozní pole (poznámka) se ale měnit smí i po odeslání.
    await c1.query(`UPDATE evidovana_trzba SET poznamka_rucniho_vyreseni = 'test poznámky' WHERE id = $1`, [r.trzba_id]);
    const poZmenePoznamky = (await dotaz(c1, 'SELECT poznamka_rucniho_vyreseni FROM evidovana_trzba WHERE id = $1', [r.trzba_id]))[0];
    assert.equal(poZmenePoznamky.poznamka_rucniho_vyreseni, 'test poznámky', '6b) provozní pole (poznámka) se po odeslání měnit smí');
    console.log('OK — 6) identifikační údaje jsou po prvním odeslání neměnné, provozní pole (poznámka, stav) se měnit smí');

    // 7) eet_odeslani se nikdy nemaže
    let chybaMazani = null;
    try {
      await c1.query('DELETE FROM eet_odeslani WHERE evidovana_trzba_id = $1', [r.trzba_id]);
    } catch (e) { chybaMazani = e; }
    assert.ok(chybaMazani, '7) záznam v eet_odeslani nesmí jít smazat');
    console.log('OK — 7) záznamy o odeslání EET se nikdy nemažou');
  }

  // 8) eet_pripojeni_test je strukturálně oddělené a chrání si prostredi
  {
    const zaznam = (await dotaz(c1,
      `INSERT INTO eet_pripojeni_test (prostredi, vysledek, detail) VALUES ('playground','ok','test spojení') RETURNING *`
    ))[0];
    assert.equal(zaznam.prostredi, 'playground');
    let chybaProstredi = null;
    try {
      await c1.query(`INSERT INTO eet_pripojeni_test (prostredi, vysledek) VALUES ('neplatne','ok')`);
    } catch (e) { chybaProstredi = e; }
    assert.ok(chybaProstredi && chybaProstredi.code === '23514', '8a) neplatná hodnota "prostredi" musí být odmítnutá CHECK constraintem');
    // Strukturální oddělenost: tabulka nemá žádný sloupec odkazující na evidovana_trzba.
    const sloupce = await dotaz(c1, `SELECT column_name FROM information_schema.columns WHERE table_name = 'eet_pripojeni_test'`);
    assert.ok(!sloupce.some(s => s.column_name.includes('trzba')), '8b) eet_pripojeni_test nesmí mít žádnou vazbu na evidovana_trzba (čistě diagnostická tabulka)');
    await c1.query('DELETE FROM eet_pripojeni_test WHERE id = $1', [zaznam.id]);
    console.log('OK — 8) eet_pripojeni_test je strukturálně oddělené od reálných dat a chrání si vlastní "prostredi"');
  }

  // 9) Nastavení — obě páčky existují a jsou nezávislé
  {
    const nastaveni = await dotaz(c1, `SELECT klic, hodnota FROM nastaveni WHERE klic IN ('eet_aktivovano_od','eet_odesilani_pozastaveno') ORDER BY klic`);
    assert.equal(nastaveni.length, 2, '9a) obě nové páčky musí po migraci existovat');
    const aktivovanoOd = nastaveni.find(n => n.klic === 'eet_aktivovano_od');
    assert.equal(aktivovanoOd.hodnota, '', '9b) eet_aktivovano_od musí být po Kroku 3a prázdné (nic se zatím nezakládá)');
    console.log('OK — 9) obě nezávislé páčky (aktivace zakládání vs. pozastavení odesílání) existují ve správném výchozím stavu');
  }

  console.log('\n✅ VŠECHNY TESTY KROKU 3A (EET — databázový základ) PROŠLY');
}

function randomUUID() {
  return require('node:crypto').randomUUID();
}

main()
  .catch(e => { console.error('❌ CHYBA TESTU:', e.message); process.exitCode = 1; })
  .finally(async () => {
    if (c1) await c1.end().catch(() => {});
    // Úklid: evidovana_trzba_zdroje a evidovana_trzba jdou smazat přímo
    // (nemají ochranný trigger proti mazání — jen eet_odeslani ho má,
    // a ten se záměrně NEuklízí, zůstává jako běžná auditní historie).
    const c = novyKlient();
    await c.connect();
    try {
      for (const [zdrojTyp, zdrojId] of uklidZdroje) {
        await c.query('DELETE FROM evidovana_trzba_zdroje WHERE zdroj_typ = $1 AND zdroj_id = $2', [zdrojTyp, zdrojId]);
      }
      const jedinecneIdy = [...new Set(uklidTrzby)];
      if (jedinecneIdy.length) {
        // evidovana_trzba, co mají záznam v eet_odeslani, se nemažou (jsou
        // to jen 1-2 testovací řádky ze scénářů 4c-7, zůstanou jako
        // neškodná historie — smazat evidovanou tržbu PO odeslání by ostatně
        // nedávalo smysl ani v produkci).
        await c.query(`DELETE FROM evidovana_trzba WHERE id = ANY($1) AND id NOT IN (SELECT evidovana_trzba_id FROM eet_odeslani)`, [jedinecneIdy]);
      }
    } catch (e) {
      console.error('Úklid Kroku 3a selhal:', e.message);
    } finally {
      await c.end();
    }
  });
