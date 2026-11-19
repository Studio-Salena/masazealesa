// Krok 3d — koordinované odesílání evidovaných tržeb (eet/odesilaci-sluzba.js)
// proti TEST databázi a lokálnímu mock EET serveru. Žádné volání Playgroundu
// ani produkce — jen REZIM.LOCAL_MOCK (viz eet/odesilaci-sluzba.js, který
// REZIM.OFFICIAL_PLAYGROUND v tomto kroku vůbec nepřijme).
//
// Scénáře (zadání, bod 9): běžná platba, poukazy (vydání+čerpání), kombinovaná
// platba, storno, timeout, zotavení po "restartu" (stale claim), souběžné
// pokusy, trvalá chyba (bez nekonečného opakování), strop počtu pokusů.
//
// Spuštění:  DATABASE_URL=... node tests/eet-krok3d-koordinovane-odesilani.test.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { ziskatTestDatabaseUrl } = require('./env-guard');
const { vytvoritTestovaciKlic } = require('../eet/podpis');
const { REZIM } = require('../eet/playground-klient');
const { odeslatIhned, zpracovatDavku, zpracovatZamcenouTrzbu } = require('../eet/odesilaci-sluzba');
const { TESTOVACI_EIC } = require('../eet/specifikace');
const { spustitMockEetServer } = require('./helpers/mock-eet-server');
const { vytvoritTestovaciCaARetezec } = require('./helpers/testovaci-ca');

const DB_URL = ziskatTestDatabaseUrl();
function novyKlient() { return new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } }); }
async function dotaz(client, sql, params) { const { rows } = await client.query(sql, params); return rows; }

// id_jednotky MUSÍ odpovídat masce xml-zprava.js (^[1-9][0-9]{0,8}$,
// jen číslice) — na rozdíl od eet-krok3a.test.js tenhle test zprávu
// skutečně sestavuje a podepisuje (sestavitZpravu), ne jen DB funkce přímo.
const ID_JEDNOTKY = '303';
const ID_POKL = 'TEST-EET3D-POKL';
// Základ odvozený z aktuálního času (ne pevná konstanta) — "zdroj_id" řádky
// se v evidovana_trzba_zdroje NIKDY nemažou (stejný princip jako jinde v
// projektu), takže opakované spuštění tohoto testu s pevně danou počáteční
// hodnotou by při druhém běhu narazilo na UNIQUE(zdroj_typ, zdroj_id) z
// MINULÉHO běhu a "nove_zapocitano" by vyšlo nesprávně false.
let dalsiZdrojId = 900000000 + (Date.now() % 90000000); // zůstává uvnitř rozsahu integer

// Výchozí zdrojTyp je ZÁMĚRNĚ 'prodej_produktu', NE 'platba' — eet-krok3a.test.js
// má vlastní sanity kontrolu (bod 0), že pokud existují historické řádky v
// tabulce "platby", nesmí u nich (ani u ŽÁDNÉHO jiného zdroj_id) existovat
// žádný zdroj_typ='platba' záznam, který by vypadal jako "automaticky
// zaevidovaná historická platba". Tenhle test testuje mechanismus
// koordinovaného odesílání samotný (je mu lhostejné, jaký zdroj_typ má
// zdroj) — volba 'prodej_produktu' se téhle (cizí) kontrole vyhne, aniž by
// to cokoli na testovaném chování změnilo. Scénáře, kde zdroj_typ věcně
// záleží (poukazy, kombinovaná platba), ho nastavují výslovně.
async function zaevidovat(client, { smer = 'prijem', zdrojTyp = 'prodej_produktu', castka = 100, urcenoCerpZuct = null, cerpZuct = null, pokladniUdalostId = crypto.randomUUID() } = {}) {
  const zdrojId = ++dalsiZdrojId;
  const [vysledek] = await dotaz(client,
    `SELECT * FROM eet_zaevidovat_zdroj($1,$2,$3,$4,$5,$6,$7,now(),$8,$9)`,
    [pokladniUdalostId, smer, zdrojTyp, zdrojId, castka, ID_JEDNOTKY, ID_POKL, urcenoCerpZuct, cerpZuct]
  );
  return { ...vysledek, pokladniUdalostId, zdrojId };
}

async function main() {
  const c1 = novyKlient();
  await c1.connect();
  const ca = vytvoritTestovaciCaARetezec({ cnRoot: 'TEST Root CA — Krok 3d koordinace' });
  const klicOdesilatele = vytvoritTestovaciKlic();
  const spolecneOpts = (mock) => ({
    rezim: REZIM.LOCAL_MOCK, mockUrl: mock.url, timeoutMs: 2000,
    certificatePem: klicOdesilatele.certificatePem, privateKeyPem: klicOdesilatele.privateKeyPem,
    eicPopl: TESTOVACI_EIC.pravnickaOsoba,
    duveryhodneKotvyPem: [ca.kotvaPem],
    maxPokusu: 3
  });

  console.log('--- Krok 3d: koordinované odesílání (okamžité + worker, stejná cesta) ---');

  try {
    // 1) Běžná platba → okamžité odeslání → potvrzeno, se zaznamenaným
    //    důvěryhodným podpisem odpovědi.
    {
      const mock = await spustitMockEetServer({ podepisovatOdpovedi: { certificatePem: ca.leafCertificatePem, privateKeyPem: ca.leafPrivateKeyPem } });
      try {
        const z = await zaevidovat(c1, { castka: 500 });
        const vysledek = await odeslatIhned(c1, z.trzba_id, spolecneOpts(mock), 'test-worker-1');
        assert.equal(vysledek.zamceno, true);
        assert.equal(vysledek.stav, 'potvrzeno');
        const [trzba] = await dotaz(c1, 'SELECT stav_evidence FROM evidovana_trzba WHERE id = $1', [z.trzba_id]);
        assert.equal(trzba.stav_evidence, 'potvrzeno');
        const [odeslani] = await dotaz(c1, 'SELECT * FROM eet_odeslani WHERE evidovana_trzba_id = $1', [z.trzba_id]);
        assert.equal(odeslani.stav, 'potvrzeno');
        assert.ok(odeslani.pok, 'musí obsahovat POK');
        assert.equal(odeslani.fs_podpis_duveryhodny, true, 'podpis odpovědi musí být zaznamenán jako důvěryhodný');
        console.log('OK 1 — běžná platba: okamžité odeslání → potvrzeno, podpis odpovědi ověřen jako důvěryhodný');
      } finally { await mock.zastavit(); }
    }

    // 2) Poukaz — vydání (urceno_cerp_zuct) i čerpání (cerp_zuct) → potvrzeno.
    {
      const mock = await spustitMockEetServer({ podepisovatOdpovedi: { certificatePem: ca.leafCertificatePem, privateKeyPem: ca.leafPrivateKeyPem } });
      try {
        const vydani = await zaevidovat(c1, { zdrojTyp: 'poukaz', castka: 800, urcenoCerpZuct: 800 });
        const v1 = await odeslatIhned(c1, vydani.trzba_id, spolecneOpts(mock), 'test-worker-1');
        assert.equal(v1.stav, 'potvrzeno');

        const cerpani = await zaevidovat(c1, { zdrojTyp: 'poukaz_historie', castka: 350, urcenoCerpZuct: 350, cerpZuct: 350 });
        const v2 = await odeslatIhned(c1, cerpani.trzba_id, spolecneOpts(mock), 'test-worker-1');
        assert.equal(v2.stav, 'potvrzeno');
        console.log('OK 2 — poukaz (vydání i čerpání) → potvrzeno');
      } finally { await mock.zastavit(); }
    }

    // 3) Kombinovaná platba — dva zdroje se STEJNÝM pokladni_udalost_id se
    //    sloučí do jedné evidované tržby a odešlou se v JEDNÉ zprávě.
    {
      const mock = await spustitMockEetServer({ podepisovatOdpovedi: { certificatePem: ca.leafCertificatePem, privateKeyPem: ca.leafPrivateKeyPem } });
      try {
        const udalost = crypto.randomUUID();
        const z1 = await zaevidovat(c1, { zdrojTyp: 'poukaz_historie', castka: 300, urcenoCerpZuct: 300, cerpZuct: 300, pokladniUdalostId: udalost });
        const z2 = await zaevidovat(c1, { zdrojTyp: 'prodej', castka: 200, pokladniUdalostId: udalost });
        assert.equal(z1.trzba_id, z2.trzba_id, 'musí se jednat o STEJNOU evidovanou tržbu');
        const [trzba] = await dotaz(c1, 'SELECT celk_trzba FROM evidovana_trzba WHERE id = $1', [z1.trzba_id]);
        assert.equal(Number(trzba.celk_trzba), 500, 'kombinovaná částka musí být 300+200=500');

        const vysledek = await odeslatIhned(c1, z1.trzba_id, spolecneOpts(mock), 'test-worker-1');
        assert.equal(vysledek.stav, 'potvrzeno');
        const odeslani = await dotaz(c1, 'SELECT * FROM eet_odeslani WHERE evidovana_trzba_id = $1', [z1.trzba_id]);
        assert.equal(odeslani.length, 1, 'kombinovaná platba se odešle v JEDNÉ zprávě, ne dvou');
        console.log('OK 3 — kombinovaná platba (dva zdroje, jedna zpráva) → potvrzeno');
      } finally { await mock.zastavit(); }
    }

    // 4) Storno — záporná částka, smer='storno' → potvrzeno.
    {
      const mock = await spustitMockEetServer({ podepisovatOdpovedi: { certificatePem: ca.leafCertificatePem, privateKeyPem: ca.leafPrivateKeyPem } });
      try {
        const z = await zaevidovat(c1, { smer: 'storno', castka: -150 });
        const vysledek = await odeslatIhned(c1, z.trzba_id, spolecneOpts(mock), 'test-worker-1');
        assert.equal(vysledek.stav, 'potvrzeno');
        console.log('OK 4 — storno (záporná částka) → potvrzeno');
      } finally { await mock.zastavit(); }
    }

    // 5) Timeout → "nejisté" (ne chyba, ne potvrzení) — mock marker
    //    porad_cis obsahující "MOCK-TIMEOUT" (nastavený ručně PŘED prvním
    //    odesláním — trigger to ještě dovolí, dokud neexistuje eet_odeslani).
    {
      const mock = await spustitMockEetServer();
      try {
        const z = await zaevidovat(c1, { castka: 10 });
        await c1.query(`UPDATE evidovana_trzba SET porad_cis = porad_cis || '-MOCK-TIMEOUT' WHERE id = $1`, [z.trzba_id]);
        const vysledek = await odeslatIhned(c1, z.trzba_id, { ...spolecneOpts(mock), timeoutMs: 300 }, 'test-worker-1');
        assert.equal(vysledek.stav, 'nejiste', 'timeout musí vést k "nejiste", ne k "chyba" ani "potvrzeno"');
        const [trzba] = await dotaz(c1, 'SELECT stav_evidence FROM evidovana_trzba WHERE id = $1', [z.trzba_id]);
        assert.equal(trzba.stav_evidence, 'nejiste');
        console.log('OK 5 — timeout → stav "nejiste" (bezpečné, retryovatelné)');
      } finally { await mock.zastavit(); }
    }

    // 6) Zotavení po "restartu" — simulace SKUTEČNÉHO pádu workeru (zamkne
    //    tržbu, ale NIKDY nezapíše výsledek — proces prostě spadl). Jiný
    //    worker po "restartu" (zde: uplynutí 5minutového okna) musí stejnou
    //    tržbu bezpečně znovu zamknout a dokončit, s NOVÝM aktualni_pokus_id.
    //    (Záměrně JINÝ scénář než timeout výš — timeout už JEDEN pokus
    //    zapsal, tenhle test ukazuje zotavení z pokusu, který se nezapsal
    //    VŮBEC, protože "worker" zmizel dřív, než stihl cokoli zapsat.)
    {
      const z = await zaevidovat(c1, { castka: 15 });
      const [predPadem] = await dotaz(c1, 'SELECT * FROM eet_zamknout_konkretni($1,$2)', [z.trzba_id, 'test-worker-co-spadne']);
      assert.ok(predPadem, 'simulace pádu si musí tržbu nejdřív sama zamknout');
      await c1.query(`UPDATE evidovana_trzba SET zpracovava_se_od = now() - interval '10 minutes' WHERE id = $1`, [z.trzba_id]);

      const mock = await spustitMockEetServer({ podepisovatOdpovedi: { certificatePem: ca.leafCertificatePem, privateKeyPem: ca.leafPrivateKeyPem } });
      try {
        const davka = await zpracovatDavku(c1, spolecneOpts(mock), 50, 'test-worker-po-restartu');
        const nasePolozka = davka.find((d) => d.trzbaId === z.trzba_id);
        assert.ok(nasePolozka, '"stale" claim po pádu musí worker po restartu znovu zamknout a zpracovat');
        assert.equal(nasePolozka.stav, 'potvrzeno', 'po zotavení se tržba musí úspěšně potvrdit');
        const [poPokusu] = await dotaz(c1, 'SELECT aktualni_pokus_id, stav_evidence FROM evidovana_trzba WHERE id = $1', [z.trzba_id]);
        assert.notEqual(poPokusu.aktualni_pokus_id, predPadem.aktualni_pokus_id, 'zotavení musí vygenerovat NOVÝ pokus_id, ne použít ten "spadlého" workeru');
        assert.equal(poPokusu.stav_evidence, 'potvrzeno');
        const vsechnyPokusy = await dotaz(c1, 'SELECT * FROM eet_odeslani WHERE evidovana_trzba_id = $1', [z.trzba_id]);
        assert.equal(vsechnyPokusy.length, 1, 'spadlý worker nic nezapsal — existuje jen JEDEN skutečný (úspěšný) pokus');
        assert.equal(vsechnyPokusy[0].prvni_zaslani, true, 'jde o historicky PRVNÍ skutečně zapsaný pokus této tržby');
        console.log('OK 6 — zotavení po skutečném pádu workeru (stale claim bez zápisu) → nový pokus_id, stejná identita tržby, úspěšně potvrzeno');
      } finally { await mock.zastavit(); }
    }

    // 7) Souběžné pokusy — dva "workeři" současně zpracovávají dávku; řádek
    //    se nikdy nezpracuje dvakrát (SKIP LOCKED, Krok 3a).
    {
      const mock = await spustitMockEetServer({ podepisovatOdpovedi: { certificatePem: ca.leafCertificatePem, privateKeyPem: ca.leafPrivateKeyPem } });
      try {
        const z1 = await zaevidovat(c1, { castka: 60 });
        const z2 = await zaevidovat(c1, { castka: 70 });
        const c2 = novyKlient();
        await c2.connect();
        try {
          const [davkaA, davkaB] = await Promise.all([
            zpracovatDavku(c1, spolecneOpts(mock), 50, 'test-worker-A'),
            zpracovatDavku(c2, spolecneOpts(mock), 50, 'test-worker-B')
          ]);
          const idsA = new Set(davkaA.map((d) => d.trzbaId));
          const idsB = new Set(davkaB.map((d) => d.trzbaId));
          const prunik = [...idsA].filter((id) => idsB.has(id));
          assert.equal(prunik.length, 0, 'žádná evidovaná tržba nesmí být zpracována dvěma workery najednou');
          const naseZpracovane = [...idsA, ...idsB].filter((id) => id === z1.trzba_id || id === z2.trzba_id);
          assert.equal(new Set(naseZpracovane).size, 2, 'obě naše tržby musí být zpracované (někým z obou workerů), přesně jednou');
          console.log('OK 7 — souběžné pokusy dvou workerů: žádná evidovaná tržba se nezpracuje dvakrát');
        } finally { await c2.end(); }
      } finally { await mock.zastavit(); }
    }

    // 8) Trvalá/strukturální chyba (neplatná XSD struktura v uložených
    //    datech — prázdné id_pokl projde DB vložením, ale xml-zprava.js ho
    //    odmítne) → stav 'chyba', NE 'nejiste' — worker ho už znovu nevezme
    //    (eet_zamknout_dalsi_davku vybírá jen 'nova'/'nejiste').
    {
      const z = await zaevidovat(c1, { castka: 40 });
      await c1.query(`UPDATE evidovana_trzba SET id_pokl = '' WHERE id = $1`, [z.trzba_id]);
      const mockNepouzity = await spustitMockEetServer();
      try {
        const vysledek = await odeslatIhned(c1, z.trzba_id, spolecneOpts(mockNepouzity), 'test-worker-1');
        assert.equal(vysledek.stav, 'chyba', 'neplatná (prázdná) id_pokl je trvalá chyba, musí jít do "chyba"');
        const davka = await zpracovatDavku(c1, spolecneOpts(mockNepouzity), 50, 'test-worker-1');
        assert.ok(!davka.some((d) => d.trzbaId === z.trzba_id), 'tržba ve stavu "chyba" se už nesmí znovu nabídnout worker frontě');
        console.log('OK 8 — trvalá/strukturální chyba → "chyba", worker už nikdy znovu nezkouší (bez nekonečného opakování)');
      } finally { await mockNepouzity.zastavit(); }
    }

    // 9) Strop počtu pokusů — opakovaný timeout (přechodný, jinak by šel do
    //    "nejiste" navždy) musí po dosažení eet_max_pokusu (tady 3, viz
    //    spolecneOpts) skončit jako 'chyba', ne nekonečně čekat na další pokus.
    {
      const mock = await spustitMockEetServer();
      try {
        const z = await zaevidovat(c1, { castka: 25 });
        await c1.query(`UPDATE evidovana_trzba SET porad_cis = porad_cis || '-MOCK-TIMEOUT' WHERE id = $1`, [z.trzba_id]);
        let posledni;
        for (let i = 1; i <= 3; i++) {
          // Mezi pokusy "stale" okno neřešíme — přímo zavoláme odeslatIhned,
          // ten si tržbu zamkne znovu, protože stav zůstává 'nejiste'/'nova'
          // (po 'chyba' by se už nezamkla, to testuje poslední iterace).
          posledni = await odeslatIhned(c1, z.trzba_id, { ...spolecneOpts(mock), timeoutMs: 300 }, 'test-worker-1');
          if (i < 3) {
            assert.equal(posledni.stav, 'nejiste', `pokus ${i}/3 má být ještě "nejiste" (pod stropem)`);
          }
        }
        assert.equal(posledni.stav, 'chyba', `po dosažení stropu (3) musí být finální stav "chyba", ne "nejiste" — dostal jsem "${posledni.stav}"`);
        assert.equal(posledni.pocetPokusuCelkem, 3);
        const dalsiPokus = await odeslatIhned(c1, z.trzba_id, { ...spolecneOpts(mock), timeoutMs: 300 }, 'test-worker-1');
        assert.equal(dalsiPokus.zamceno, false, 'po dosažení stropu a přechodu do "chyba" se už nesmí dát znovu zamknout');
        console.log('OK 9 — strop počtu pokusů: po dosažení maxPokusu (3) se přechodná chyba uzavře jako trvalá "chyba", žádné nekonečné opakování');
      } finally { await mock.zastavit(); }
    }

  } finally {
    await c1.end();
  }

  console.log('\n✅ VŠECHNY TESTY KOORDINOVANÉHO ODESÍLÁNÍ (KROK 3D) PROŠLY');
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
