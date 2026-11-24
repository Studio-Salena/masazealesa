// Krok 3d — zpevnění po druhém kole ověření: bezpečné ruční znovu-zařazení
// po dosažení stropu pokusů (bod 6), hranice timeoutMs vs. "stale" okno
// zámku (bod 7), a oddělení INFRASTRUKTURNÍ chyby certifikátu od chyby dat
// konkrétní tržby (bod 8). Vše proti TEST DB a REZIM.LOCAL_MOCK.
//
// Spuštění:  DATABASE_URL=... node tests/eet-krok3d-zpevneni.test.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { ziskatTestDatabaseUrl } = require('./env-guard');
const { vytvoritTestovaciKlic } = require('../eet/podpis');
const { REZIM } = require('../eet/playground-klient');
const { odeslatIhned, zpracovatZamcenouTrzbu, znovuZaraditDoFronty, MAX_BEZPECNY_TIMEOUT_MS } = require('../eet/odesilaci-sluzba');
const { TESTOVACI_EIC } = require('../eet/specifikace');
const { spustitMockEetServer } = require('./helpers/mock-eet-server');
const { vytvoritTestovaciCaARetezec } = require('./helpers/testovaci-ca');

const DB_URL = ziskatTestDatabaseUrl();
function novyKlient() { return new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } }); }
async function dotaz(c, sql, params) { const { rows } = await c.query(sql, params); return rows; }

const ID_JEDNOTKY = '303';
const ID_POKL = 'TEST-EET3D-ZPEVNENI';
let dalsiZdrojId = 800000000 + (Date.now() % 90000000);

async function zaevidovat(client, { castka = 50, pokladniUdalostId = crypto.randomUUID() } = {}) {
  const zdrojId = ++dalsiZdrojId;
  const [vysledek] = await dotaz(client,
    `SELECT * FROM eet_zaevidovat_zdroj($1,'prijem','prodej_produktu',$2,$3,$4,$5,now())`,
    [pokladniUdalostId, zdrojId, castka, ID_JEDNOTKY, ID_POKL]
  );
  return vysledek;
}

async function main() {
  const c1 = novyKlient();
  await c1.connect();
  // Viz stejná poznámka v eet-krok3d-koordinovane-odesilani.test.js — od
  // revize 2026-11-24 kontroluje eet/odesilaci-sluzba.js oba přepínače sama,
  // tenhle test je proto musí mít po dobu běhu výslovně v odesílatelném
  // stavu (a vrátit zpět v "finally" níž).
  const { rows: [puvodniEvidence] } = await c1.query(`SELECT hodnota FROM nastaveni WHERE klic = 'eet_evidence_zapnuta'`);
  const { rows: [puvodniPozastaveno] } = await c1.query(`SELECT hodnota FROM nastaveni WHERE klic = 'eet_odesilani_pozastaveno'`);
  const puvodniHodnotaEvidence = puvodniEvidence ? puvodniEvidence.hodnota : 'false';
  const puvodniHodnotaPozastaveno = puvodniPozastaveno ? puvodniPozastaveno.hodnota : 'true';
  await c1.query(`UPDATE nastaveni SET hodnota = 'true' WHERE klic = 'eet_evidence_zapnuta'`);
  await c1.query(`UPDATE nastaveni SET hodnota = 'false' WHERE klic = 'eet_odesilani_pozastaveno'`);
  const ca = vytvoritTestovaciCaARetezec({ cnRoot: 'TEST Root CA — Krok 3d zpevnění' });
  const klicOdesilatele = vytvoritTestovaciKlic();
  const opts = (mock, extra = {}) => ({
    rezim: REZIM.LOCAL_MOCK, mockUrl: mock ? mock.url : 'http://127.0.0.1:1/x', timeoutMs: 2000,
    certificatePem: klicOdesilatele.certificatePem, privateKeyPem: klicOdesilatele.privateKeyPem,
    eicPopl: TESTOVACI_EIC.pravnickaOsoba, duveryhodneKotvyPem: [ca.kotvaPem], maxPokusu: 2,
    ...extra
  });

  console.log('--- Krok 3d: zpevnění (ruční re-queue, timeout/zámek, infrastruktura vs. data) ---');

  try {
    // 1) Bod 6 — po dosažení stropu pokusů tržba zůstává viditelná jako
    //    'chyba' (nezmizí, není mylně 'potvrzeno'); bezpečné ruční
    //    znovu-zařazení (znovuZaraditDoFronty) jí dá NOVÝ rozpočet pokusů a
    //    nechá uspět, aniž by se stará historie (eet_odeslani) ztratila.
    {
      // Přechodné selhání simulujeme NEDOSTUPNOU adresou (ECONNREFUSED,
      // ne "MOCK-TIMEOUT" markerem v porad_cis) — porad_cis je po prvním
      // pokusu neměnná identita tržby (schema.sql trigger), takže marker
      // zapsaný do ní by blokoval i BUDOUCÍ úspěšné zotavení přes JAKÝKOLI
      // mock server (marker platí pro všechny instance). Nedostupnost cíle
      // je naopak vnější, časově proměnná okolnost — přesně to, co má
      // "nejiste"/retry opravit.
      const z = await zaevidovat(c1, { castka: 11 });
      let posledni;
      for (let i = 1; i <= 2; i++) {
        posledni = await odeslatIhned(c1, z.trzba_id, opts(null, { timeoutMs: 500 }), 'test-zpevneni-1');
      }
      assert.equal(posledni.stav, 'chyba', `po dosažení stropu (2) musí být 'chyba', dostal jsem ${posledni.stav}`);

      const [trzba] = await dotaz(c1, 'SELECT * FROM evidovana_trzba WHERE id = $1', [z.trzba_id]);
      assert.equal(trzba.stav_evidence, 'chyba');
      assert.notEqual(trzba, null, 'tržba nesmí zmizet z evidence');
      const pokusyPred = await dotaz(c1, 'SELECT * FROM eet_odeslani WHERE evidovana_trzba_id = $1', [z.trzba_id]);
      assert.equal(pokusyPred.length, 2, 'historie starých pokusů musí zůstat (nic se nemaže)');

      // Administrátor "opraví příčinu" (tady: opraví poradatí problém —
      // v reálu by šlo o konfiguraci/data) a znovu zařadí do fronty.
      const reset = await znovuZaraditDoFronty(c1, z.trzba_id, 'TEST: ověřeno, že FS je zpět dostupná, zkouším znovu.');
      assert.equal(reset, true);
      const [trzbaPoResetu] = await dotaz(c1, 'SELECT * FROM evidovana_trzba WHERE id = $1', [z.trzba_id]);
      assert.equal(trzbaPoResetu.stav_evidence, 'nova');
      assert.ok(trzbaPoResetu.rucni_reset_kdy, 'reset musí být zaznamenán (kdy)');
      assert.ok(trzbaPoResetu.rucni_reset_poznamka, 'reset musí mít poznámku (audit, proč)');

      // Teď uspěje (mock odpovídá normálně) — a smí dostat další 2 pokusy
      // (nový rozpočet), i když historicky má dohromady už 3+.
      const mockOk = await spustitMockEetServer({ podepisovatOdpovedi: { certificatePem: ca.leafCertificatePem, privateKeyPem: ca.leafPrivateKeyPem } });
      try {
        const vysledek = await odeslatIhned(c1, z.trzba_id, opts(mockOk), 'test-zpevneni-1');
        assert.equal(vysledek.stav, 'potvrzeno', `po ručním re-queue musí další pokus uspět, dostal jsem ${vysledek.stav}`);
        assert.equal(vysledek.pocetPokusuCelkem, 1, 'počet pokusů OD RESETU musí být 1, ne historický součet všech pokusů');
      } finally {
        await mockOk.zastavit();
      }
      const vsechnyPokusyCelkem = await dotaz(c1, 'SELECT * FROM eet_odeslani WHERE evidovana_trzba_id = $1', [z.trzba_id]);
      assert.equal(vsechnyPokusyCelkem.length, 3, 'VŠECHNY pokusy (před i po resetu) zůstávají navždy v historii');
      console.log('OK 1 — bod 6: tržba po dosažení stropu zůstává viditelná jako "chyba", bezpečný ruční re-queue dá nový rozpočet pokusů a historie se nemaže');
    }

    // 1b) znovuZaraditDoFronty nesmí fungovat na tržbě, která NENÍ 'chyba'
    //     (např. 'potvrzeno') — ochrana proti nechtěnému "rozházení" už
    //     uzavřené, úspěšné evidence.
    {
      const mock = await spustitMockEetServer({ podepisovatOdpovedi: { certificatePem: ca.leafCertificatePem, privateKeyPem: ca.leafPrivateKeyPem } });
      const z = await zaevidovat(c1, { castka: 5 });
      await odeslatIhned(c1, z.trzba_id, opts(mock), 'test-zpevneni-1');
      await mock.zastavit();
      const reset = await znovuZaraditDoFronty(c1, z.trzba_id, 'pokus o reset potvrzené tržby');
      assert.equal(reset, false, 'reset potvrzené tržby se musí tiše odmítnout (ne přepsat uzavřenou evidenci)');
      console.log('OK 1b — ruční re-queue odmítne tržbu, která není ve stavu "chyba" (nerozhází potvrzenou evidenci)');
    }

    // 2) Bod 7 — timeoutMs blízko/nad 5minutovým "stale" oknem se odmítá
    //    hned, ne až by způsobil dvojí odeslání.
    {
      const z = await zaevidovat(c1, { castka: 1 });
      const zamceno = (await dotaz(c1, 'SELECT * FROM eet_zamknout_konkretni($1,$2)', [z.trzba_id, 'test-zpevneni-2']))[0];
      await assert.rejects(
        () => zpracovatZamcenouTrzbu(c1, zamceno, opts(null, { timeoutMs: MAX_BEZPECNY_TIMEOUT_MS + 1 })),
        /timeoutMs/i
      );
      await assert.rejects(
        () => zpracovatZamcenouTrzbu(c1, zamceno, opts(null, { timeoutMs: 6 * 60 * 1000 })), // 6 minut > 5minutové okno
        /timeoutMs/i
      );
      console.log(`OK 2 — bod 7: timeoutMs nad bezpečnou hranicí (${MAX_BEZPECNY_TIMEOUT_MS} ms, polovina 5min okna) je vždy odmítnut`);
    }

    // 3) Bod 8 — chybějící/neplatný certifikát je INFRASTRUKTURNÍ problém:
    //    zámek se uvolní BEZ zápisu výsledku, stav_evidence se NEMĚNÍ a
    //    pokus se NEPOČÍTÁ do eet_max_pokusu.
    {
      const z = await zaevidovat(c1, { castka: 2 });
      const zamceno1 = (await dotaz(c1, 'SELECT * FROM eet_zamknout_konkretni($1,$2)', [z.trzba_id, 'test-zpevneni-3']))[0];
      await assert.rejects(
        () => zpracovatZamcenouTrzbu(c1, zamceno1, opts(null, { certificatePem: null, privateKeyPem: null })),
        /certificatePem|privateKeyPem/
      );
      const [poChybeCertifikatu] = await dotaz(c1, 'SELECT * FROM evidovana_trzba WHERE id = $1', [z.trzba_id]);
      assert.equal(poChybeCertifikatu.stav_evidence, 'nova', 'chybějící certifikát nesmí změnit stav_evidence');
      assert.equal(poChybeCertifikatu.zpracovava_se_od, null, 'zámek se musí uvolnit (ne zůstat "zamčený" dalších 5 minut)');
      const pokusyPoChybeCertifikatu = await dotaz(c1, 'SELECT * FROM eet_odeslani WHERE evidovana_trzba_id = $1', [z.trzba_id]);
      assert.equal(pokusyPoChybeCertifikatu.length, 0, 'chyba certifikátu se NESMÍ zapsat jako pokus (netýká se dat této tržby)');

      // Nesouhlasící pár klíč/certifikát (jiný klíč, než odpovídá
      // certifikátu) — stejná kategorie (infrastrukturní), stejné chování.
      const jinyKlic = vytvoritTestovaciKlic();
      const zamceno2 = (await dotaz(c1, 'SELECT * FROM eet_zamknout_konkretni($1,$2)', [z.trzba_id, 'test-zpevneni-3']))[0];
      await assert.rejects(
        () => zpracovatZamcenouTrzbu(c1, zamceno2, opts(null, { privateKeyPem: jinyKlic.privateKeyPem })), // cizí klíč, cizí certifikát zůstává
        /Certifikát\/klíč/
      );
      const pokusyPoNesouhlasu = await dotaz(c1, 'SELECT * FROM eet_odeslani WHERE evidovana_trzba_id = $1', [z.trzba_id]);
      assert.equal(pokusyPoNesouhlasu.length, 0, 'ani nesouhlasící klíč/certifikát se nesmí započítat jako pokus této tržby');

      // Po opravě konfigurace (správný pár klíč/certifikát) tržba uspěje
      // normálně, se STEJNÝM plným rozpočtem pokusů (žádný z předchozích
      // infrastrukturních selhání se nezapočítal).
      const mockOk = await spustitMockEetServer({ podepisovatOdpovedi: { certificatePem: ca.leafCertificatePem, privateKeyPem: ca.leafPrivateKeyPem } });
      try {
        const vysledek = await odeslatIhned(c1, z.trzba_id, opts(mockOk), 'test-zpevneni-3');
        assert.equal(vysledek.stav, 'potvrzeno');
        assert.equal(vysledek.pocetPokusuCelkem, 1, 'infrastrukturní selhání se nikdy nezapočítávají do pocetPokusuCelkem');
      } finally {
        await mockOk.zastavit();
      }
      console.log('OK 3 — bod 8: chybějící/nesouhlasící certifikát je rozpoznán jako INFRASTRUKTURNÍ problém — zámek se uvolní beze zápisu, nepočítá se do stropu pokusů');
    }

  } finally {
    await c1.query(`UPDATE nastaveni SET hodnota = $1 WHERE klic = 'eet_evidence_zapnuta'`, [puvodniHodnotaEvidence]).catch(() => {});
    await c1.query(`UPDATE nastaveni SET hodnota = $1 WHERE klic = 'eet_odesilani_pozastaveno'`, [puvodniHodnotaPozastaveno]).catch(() => {});
    await c1.end();
  }

  console.log('\n✅ VŠECHNY TESTY ZPEVNĚNÍ (KROK 3D, DRUHÉ KOLO) PROŠLY');
}

main().catch((e) => { console.error('❌ CHYBA TESTU:', e); process.exitCode = 1; });
