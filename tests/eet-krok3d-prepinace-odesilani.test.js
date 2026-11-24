// Krok 3d — kontrola OBOU přepínačů (eet_evidence_zapnuta/eet_odesilani_pozastaveno)
// PŘÍMO uvnitř eet/odesilaci-sluzba.js, ne jen u volajícího (viz revize
// 2026-11-24 — dřív to kontrolovalo jen server.js u okamžitého odeslání po
// platbě, worker/dávka a ruční znovu-zařazení na to nebyly vůbec napojené).
//
// Cíl testu:
//  1) Oba přepínače vypnuté (výchozí stav po migraci) → odeslatIhned
//     odmítne, zámek se uvolní beze zápisu výsledku, stav_evidence i počet
//     pokusů zůstávají nedotčené.
//  2) Jen jeden přepínač ve správném stavu (druhý ne) → stále odmítnuto.
//  3) Nejasná/neplatná hodnota (ne přesně 'true'/'false') → odmítnuto
//     (fail-closed), ne akceptováno jako "nejspíš OK".
//  4) Změna přepínače UPROSTŘED dávky (zpracovatDavku): řádek zamčený před
//     flipnutím se zpracuje normálně, řádek zamčený ve stejné dávce ale
//     zpracovávaný AŽ PO flipnutí se bezpečně odmítne a jeho zámek se ihned
//     uvolní (ne až po 5minutovém "stale" okně) — zbytek dávky dál běží,
//     nepadá na výjimce jednoho řádku.
//
// Spuštění:  DATABASE_URL=... node tests/eet-krok3d-prepinace-odesilani.test.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { ziskatTestDatabaseUrl } = require('./env-guard');
const { vytvoritTestovaciKlic } = require('../eet/podpis');
const { REZIM } = require('../eet/playground-klient');
const { odeslatIhned, zpracovatDavku, zkontrolovatPrepinaceOdesilani } = require('../eet/odesilaci-sluzba');
const { TESTOVACI_EIC } = require('../eet/specifikace');
const { spustitMockEetServer } = require('./helpers/mock-eet-server');
const { vytvoritTestovaciCaARetezec } = require('./helpers/testovaci-ca');

const DB_URL = ziskatTestDatabaseUrl();
function novyKlient() { return new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } }); }
async function dotaz(c, sql, params) { const { rows } = await c.query(sql, params); return rows; }

const ID_JEDNOTKY = '303';
const ID_POKL = 'TEST-EET3D-PREPINACE';
let dalsiZdrojId = 700000000 + (Date.now() % 90000000);

async function zaevidovat(client, { castka = 50, pokladniUdalostId = crypto.randomUUID() } = {}) {
  const zdrojId = ++dalsiZdrojId;
  const [vysledek] = await dotaz(client,
    `SELECT * FROM eet_zaevidovat_zdroj($1,'prijem','prodej_produktu',$2,$3,$4,$5,now())`,
    [pokladniUdalostId, zdrojId, castka, ID_JEDNOTKY, ID_POKL]
  );
  return vysledek;
}

// UPSERT, ne prosté UPDATE — scénář 3) níž řádek "eet_evidence_zapnuta"
// výslovně MAŽE (test chybějícího klíče), takže obnova původního stavu v
// "finally" musí řádek i znovu VLOŽIT, pokud už neexistuje, jinak by holé
// UPDATE tiše neudělalo nic a klíč by zůstal navždy smazaný pro VŠECHNY
// další soubory regresní sady (přesně tohle se stalo při prvním běhu).
async function nastavPrepinace(c, evidence, pozastaveno) {
  await c.query(`INSERT INTO nastaveni (klic, hodnota) VALUES ('eet_evidence_zapnuta', $1) ON CONFLICT (klic) DO UPDATE SET hodnota = $1`, [evidence]);
  await c.query(`INSERT INTO nastaveni (klic, hodnota) VALUES ('eet_odesilani_pozastaveno', $1) ON CONFLICT (klic) DO UPDATE SET hodnota = $1`, [pozastaveno]);
}

async function main() {
  const c1 = novyKlient();
  await c1.connect();
  const { rows: [puvodniEvidence] } = await c1.query(`SELECT hodnota FROM nastaveni WHERE klic = 'eet_evidence_zapnuta'`);
  const { rows: [puvodniPozastaveno] } = await c1.query(`SELECT hodnota FROM nastaveni WHERE klic = 'eet_odesilani_pozastaveno'`);
  const puvodniHodnotaEvidence = puvodniEvidence ? puvodniEvidence.hodnota : 'false';
  const puvodniHodnotaPozastaveno = puvodniPozastaveno ? puvodniPozastaveno.hodnota : 'true';

  const ca = vytvoritTestovaciCaARetezec({ cnRoot: 'TEST Root CA — Krok 3d přepínače' });
  const klicOdesilatele = vytvoritTestovaciKlic();
  const opts = (mock) => ({
    rezim: REZIM.LOCAL_MOCK, mockUrl: mock.url, timeoutMs: 2000,
    certificatePem: klicOdesilatele.certificatePem, privateKeyPem: klicOdesilatele.privateKeyPem,
    eicPopl: TESTOVACI_EIC.pravnickaOsoba, duveryhodneKotvyPem: [ca.kotvaPem], maxPokusu: 3
  });

  console.log('--- Krok 3d: kontrola přepínačů odesílání přímo v odesilaci-sluzba.js ---');

  try {
    // 1) Oba přepínače ve výchozím (vypnutém) stavu → odmítnuto
    {
      await nastavPrepinace(c1, 'false', 'true');
      const z = await zaevidovat(c1);
      const mock = await spustitMockEetServer({ podepisovatOdpovedi: { certificatePem: ca.leafCertificatePem, privateKeyPem: ca.leafPrivateKeyPem } });
      try {
        await assert.rejects(
          () => odeslatIhned(c1, z.trzba_id, opts(mock), 'test-prepinace-1'),
          /eet_evidence_zapnuta|eet_odesilani_pozastaveno/,
          '1) výchozí (vypnutý) stav obou přepínačů musí odeslání odmítnout'
        );
      } finally { await mock.zastavit(); }
      const [trzba] = await dotaz(c1, 'SELECT stav_evidence, zpracovava_se_od FROM evidovana_trzba WHERE id = $1', [z.trzba_id]);
      assert.equal(trzba.stav_evidence, 'nova', '1a) odmítnutí nesmí změnit stav_evidence');
      assert.equal(trzba.zpracovava_se_od, null, '1b) zámek se musí uvolnit ihned, ne zůstat zamčený 5 minut');
      const pokusy = await dotaz(c1, 'SELECT * FROM eet_odeslani WHERE evidovana_trzba_id = $1', [z.trzba_id]);
      assert.equal(pokusy.length, 0, '1c) odmítnutí se nesmí zapsat jako pokus (nejde o chybu dat tržby)');
      // Úklid HNED, ne až na konci souboru — jinak by tenhle řádek (zůstává
      // 'nova', nikdy odeslaný) zůstal v obecné frontě a scénář 4) níž
      // (zpracovatDavku, který si zamyká NEJSTARŠÍ čekající řádky bez ohledu
      // na to, z kterého scénáře pochází) by ho vyzvedl JAKO PRVNÍ místo
      // vlastních z1/z2 — přesně to způsobilo první (chybný) běh téhle sady.
      await c1.query('DELETE FROM evidovana_trzba_zdroje WHERE evidovana_trzba_id = $1', [z.trzba_id]);
      await c1.query('DELETE FROM evidovana_trzba WHERE id = $1', [z.trzba_id]);
      console.log('OK — 1) oba přepínače vypnuté (výchozí stav) → odeslání odmítnuto, zámek uvolněn beze zápisu');
    }

    // 2) Jen evidence zapnutá, odesílání stále pozastavené → stále odmítnuto
    {
      await nastavPrepinace(c1, 'true', 'true');
      const z = await zaevidovat(c1);
      const mock = await spustitMockEetServer({ podepisovatOdpovedi: { certificatePem: ca.leafCertificatePem, privateKeyPem: ca.leafPrivateKeyPem } });
      try {
        await assert.rejects(
          () => odeslatIhned(c1, z.trzba_id, opts(mock), 'test-prepinace-2'),
          /eet_odesilani_pozastaveno/,
          '2) eet_odesilani_pozastaveno=true musí odeslání odmítnout, i když evidence je zapnutá'
        );
      } finally { await mock.zastavit(); }
      // Stejný důvod úklidu jako u scénáře 1) výš.
      await c1.query('DELETE FROM evidovana_trzba_zdroje WHERE evidovana_trzba_id = $1', [z.trzba_id]);
      await c1.query('DELETE FROM evidovana_trzba WHERE id = $1', [z.trzba_id]);
      console.log('OK — 2) jen jeden přepínač ve správném stavu nestačí, musí platit OBA najednou');
    }

    // 3) Nejasná/neplatná hodnota → odmítnuto (fail-closed), ne akceptováno
    {
      await c1.query(`UPDATE nastaveni SET hodnota = 'ano' WHERE klic = 'eet_evidence_zapnuta'`);
      await c1.query(`UPDATE nastaveni SET hodnota = 'false' WHERE klic = 'eet_odesilani_pozastaveno'`);
      const stav = await zkontrolovatPrepinaceOdesilani(c1);
      assert.equal(stav.povoleno, false, '3a) hodnota mimo přesně "true"/"false" se musí považovat za nejasnou a odmítnout');
      await c1.query(`DELETE FROM nastaveni WHERE klic = 'eet_evidence_zapnuta'`);
      const stavChybejici = await zkontrolovatPrepinaceOdesilani(c1);
      assert.equal(stavChybejici.povoleno, false, '3b) chybějící řádek (smazaný klíč) se musí považovat za nejasný a odmítnout, ne za "vypnuto = bezpečné"');
      console.log('OK — 3) nejasné/neplatné/chybějící nastavení přepínače = odmítnuto (fail-closed)');
    }

    // 4) Změna přepínače UPROSTŘED dávky — řádek zpracovaný před flipnutím
    //    uspěje, řádek zpracovaný AŽ PO flipnutí se bezpečně odmítne a hned
    //    uvolní zámek, zbytek dávky neskončí na výjimce.
    {
      // eet_zamknout_dalsi_davku vybírá čekající řádky "order by id" (nejstarší
      // nejdřív) z CELÉ tabulky, bez ohledu na to, z kterého souboru/scénáře
      // pocházejí — jakýkoli starší nezpracovaný řádek (typicky osamělý
      // zbytek po přerušeném běhu testu) by se vyzvedl PŘED z1/z2 a posunul
      // by je z pozice "první v dávce" tam, kam se už flip dostal. Proto se
      // fronta těsně před scénářem nejdřív vyprázdní — bezpečně, protože
      // mažeme jen řádky BEZ eet_odeslani historie (nikdy nic odeslaného).
      const cizi = await dotaz(c1, `SELECT id FROM evidovana_trzba WHERE stav_evidence IN ('nova','nejiste') AND (zpracovava_se_od IS NULL OR zpracovava_se_od < now() - interval '5 minutes')`);
      if (cizi.length) {
        const idy = cizi.map(r => r.id);
        await c1.query('DELETE FROM evidovana_trzba_zdroje WHERE evidovana_trzba_id = ANY($1)', [idy]);
        await c1.query('DELETE FROM evidovana_trzba WHERE id = ANY($1) AND NOT EXISTS (SELECT 1 FROM eet_odeslani WHERE evidovana_trzba_id = evidovana_trzba.id)', [idy]);
      }
      await nastavPrepinace(c1, 'true', 'false');
      const z1 = await zaevidovat(c1, { castka: 111 });
      const z2 = await zaevidovat(c1, { castka: 222 });
      // Hák mock serveru se spustí hned na ZAČÁTKU obsluhy PRVNÍHO HTTP
      // požadavku (tedy ještě PŘED tím, než se dávka ve smyčce dostane na
      // druhý řádek) — simuluje admina, co uprostřed běhu dávky pozastaví
      // odesílání.
      let prepnuto = false;
      const mock = await spustitMockEetServer({
        podepisovatOdpovedi: { certificatePem: ca.leafCertificatePem, privateKeyPem: ca.leafPrivateKeyPem },
        predKazdymPozadavkem: async () => {
          if (!prepnuto) { prepnuto = true; await c1.query(`UPDATE nastaveni SET hodnota = 'true' WHERE klic = 'eet_odesilani_pozastaveno'`); }
        }
      });
      try {
        const davka = await zpracovatDavku(c1, opts(mock), 50, 'test-prepinace-4');
        const vysledekZ1 = davka.find(d => d.trzbaId === z1.trzba_id);
        const vysledekZ2 = davka.find(d => d.trzbaId === z2.trzba_id);
        assert.ok(vysledekZ1, '4a) první řádek dávky musí být zpracován');
        assert.ok(vysledekZ2, '4b) druhý řádek dávky musí být v odpovědi dávky (ne vynechaný beze stopy), i když byl odmítnut');
        const [trzba1] = await dotaz(c1, 'SELECT stav_evidence, zpracovava_se_od FROM evidovana_trzba WHERE id = $1', [z1.trzba_id]);
        const [trzba2] = await dotaz(c1, 'SELECT stav_evidence, zpracovava_se_od FROM evidovana_trzba WHERE id = $1', [z2.trzba_id]);
        // eet_zamknout_dalsi_davku sice VYBÍRÁ řádky "order by id" (nejstarší
        // nejdřív), ale PostgreSQL nezaručuje, že UPDATE...RETURNING vrátí
        // výsledek ve STEJNÉM pořadí — proto se tu neověřuje KONKRÉTNĚ "z1
        // uspěje, z2 ne", ale obecná vlastnost: přepínač se flipne během
        // zpracování PRVNÍHO HTTP požadavku dávky, takže přesně JEDEN z
        // [z1, z2] (ten, co se zpracoval jako první, bez ohledu na to, který
        // to byl) uspěje a druhý se bezpečně odmítne.
        const stavy = [trzba1, trzba2];
        const potvrzene = stavy.filter(t => t.stav_evidence === 'potvrzeno');
        const odmitnute = stavy.filter(t => t.stav_evidence === 'nova');
        assert.equal(potvrzene.length, 1, '4c) přesně JEDEN řádek (zpracovaný PŘED flipnutím) musí uspět normálně');
        assert.equal(odmitnute.length, 1, '4d) přesně JEDEN řádek (zpracovaný AŽ PO flipnutí) nesmí změnit stav_evidence');
        assert.equal(odmitnute[0].zpracovava_se_od, null, '4e) zámek odmítnutého řádku se musí uvolnit IHNED, ne zůstat zamčený do vypršení "stale" okna');
      } finally { await mock.zastavit(); }
      // Úklid: z1/z2 (ten potvrzený má eet_odeslani historii a zůstává
      // navždy jako audit — stejný princip jako v eet-krok3a.test.js; ten
      // odmítnutý žádnou historii nemá, smaže se úplně).
      for (const z of [z1, z2]) {
        await c1.query('DELETE FROM evidovana_trzba_zdroje WHERE evidovana_trzba_id = $1', [z.trzba_id]);
        await c1.query('DELETE FROM evidovana_trzba WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM eet_odeslani WHERE evidovana_trzba_id = $1)', [z.trzba_id]);
      }
      console.log('OK — 4) přepnutí přepínače uprostřed dávky: rozpracovaný řádek uspěje, zbytek se bezpečně odmítne a hned uvolní zámek, dávka neskončí na výjimce');
    }

    console.log('\n✅ VŠECHNY TESTY KONTROLY PŘEPÍNAČŮ (KROK 3D) PROŠLY');
  } finally {
    await nastavPrepinace(c1, puvodniHodnotaEvidence, puvodniHodnotaPozastaveno).catch(() => {});
    await c1.end();
  }
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
