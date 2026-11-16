// Sdílené pomocné funkce pro ÚKLID testovacích dat po běhu testů — čistě
// testovací nástroj, NENÍ součástí aplikace (server.js se nikdy nemění).
//
// Od zavedení ochrany mazání rezervací (viz schema.sql —
// rezervace_bez_mazani_dokoncene trigger + platby_rezervace_id_fkey ON
// DELETE RESTRICT) nejde dokončenou nebo zaplacenou/vrácenou testovací
// rezervaci smazat běžným DELETE /api/admin/rezervace/:id — to je ZÁMĚR
// (stejná ochrana jako v produkci, testy ji nijak neobchází přes HTTP API).
// Testy ale potřebují svoje VLASTNÍ fixtury po sobě skutečně uklidit, ne je
// hromadit v TEST databázi navždy — proto tahle funkce místo HTTP API sahá
// přímo do TEST databáze (výhradně přes ziskatTestDatabaseUrl(), fail-closed,
// nikdy produkce).
const { ziskatTestDatabaseUrl } = require('./env-guard');

async function smazatRezervaciNatvrdo(rezervaceId) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: ziskatTestDatabaseUrl(), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query('BEGIN');

    // 1) Skutečné čerpání poukazem (typ='platba', zpusob_platby='poukaz') na
    // týhle rezervaci — NE vratky-jako-poukaz (viz bod 2 níž, ty vytvořily
    // VLASTNÍ nový poukaz, nejde o čerpání existujícího). Pro každý takto
    // zasažený poukaz: pokud jeho JEDINÁ historie čerpání patří týhle
    // rezervaci (žádné jiné využití — jiná rezervace, Rychlý prodej), jde o
    // čistě testovací artefakt a smaže se CELÝ (poukaz i historie). Pokud má
    // poukaz i JINÉ využití, zůstává a jen se mu vrátí zůstatek, který
    // čerpala TATO rezervace (stejná logika, jakou dřív — před zavedením
    // ochrany mazání — dělal produkční DELETE endpoint) — ne mechanické
    // navýšení naslepo, ale přesně ten díl, co odpovídá smazané historii.
    const { rows: cerpaniPoukazem } = await c.query(
      `SELECT poukaz_id, SUM(castka) AS castka FROM platby
       WHERE rezervace_id = $1 AND zpusob_platby = 'poukaz' AND typ = 'platba' AND poukaz_id IS NOT NULL
       GROUP BY poukaz_id`,
      [rezervaceId]
    );
    for (const radek of cerpaniPoukazem) {
      const { rows: [poukaz] } = await c.query('SELECT * FROM poukazy WHERE id = $1 FOR UPDATE', [radek.poukaz_id]);
      if (!poukaz) continue;
      const { rows: [{ pocet: jineVyuziti }] } = await c.query(
        `SELECT count(*) AS pocet FROM poukazy_historie WHERE poukaz_id = $1 AND rezervace_id IS DISTINCT FROM $2`,
        [poukaz.id, rezervaceId]
      );
      if (Number(jineVyuziti) === 0) {
        // Jediné využití patří týhle (mazané) rezervaci — čistě testovací
        // poukaz, smazat celý, ne jen "opravovat" zůstatek.
        await c.query('DELETE FROM poukazy_historie WHERE poukaz_id = $1', [poukaz.id]);
        await c.query('DELETE FROM poukazy WHERE id = $1', [poukaz.id]);
      } else {
        // Poukaz má i jiné (nesouvisející) využití — zůstává, vrátí se mu
        // jen díl zůstatku, který čerpala právě tahle rezervace.
        const novyZustatek = Math.min(Number(poukaz.hodnota), Number(poukaz.zustatek) + Number(radek.castka));
        const novyStav = poukaz.stav === 'zruseny' ? 'zruseny' : (novyZustatek >= Number(poukaz.hodnota) ? 'aktivni' : 'castecne_vyuzity');
        await c.query(
          `UPDATE poukazy SET zustatek = $1, stav = $2, uzavreno_kdy = CASE WHEN $2 = 'zruseny' THEN uzavreno_kdy ELSE NULL END WHERE id = $3`,
          [novyZustatek, novyStav, poukaz.id]
        );
      }
    }

    // 2) Vratka-jako-poukaz (typ='vratka', zpusob_platby='poukaz') na týhle
    // rezervaci vytvořila VLASTNÍ nový poukaz (viz idempotentní klíč u
    // vratek) — ten je čistě testovací artefakt bez jiného užití (nemohl
    // vzniknout jinak než touhle vratkou), smaže se celý i s historií.
    const { rows: vratkyJakoPoukaz } = await c.query(
      `SELECT DISTINCT poukaz_id FROM platby
       WHERE rezervace_id = $1 AND zpusob_platby = 'poukaz' AND typ = 'vratka' AND poukaz_id IS NOT NULL`,
      [rezervaceId]
    );
    for (const radek of vratkyJakoPoukaz) {
      await c.query('DELETE FROM poukazy_historie WHERE poukaz_id = $1', [radek.poukaz_id]);
      await c.query('DELETE FROM poukazy WHERE id = $1', [radek.poukaz_id]);
    }

    // 3) Zbylá historie čerpání vázaná přímo na rezervace_id (i kdyby se
    // nekryla s bodem 1/2, např. starší/jiné cesty vzniku) — stejně jako
    // dřív dělal produkční DELETE endpoint.
    await c.query('DELETE FROM poukazy_historie WHERE rezervace_id = $1', [rezervaceId]);

    await c.query(`UPDATE rezervace SET stav = 'zrusena' WHERE id = $1 AND stav = 'dokoncena'`, [rezervaceId]);
    await c.query('DELETE FROM platby WHERE rezervace_id = $1', [rezervaceId]);
    await c.query('DELETE FROM rezervace WHERE id = $1', [rezervaceId]);

    await c.query('COMMIT');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    await c.end();
  }
}

// Drop-in náhrada za "await adminFetch('/admin/rezervace/'+id, {method:'DELETE'})"
// v úklidu testů po celém adresáři: zkusí normální (chráněné) smazání přes
// HTTP API jako dřív; pokud ho ochrana odmítne (fixtura se mezitím stala
// dokončenou a/nebo zaplacenou), spadne zpátky na přímý úklid v TEST
// databázi. Soubory, kde nic nikdy nebylo dokončené/zaplacené, se chovají
// přesně jako dřív (první pokus vždy uspěje, fallback se nikdy nespustí).
// Bezpečné zavolat i opakovaně na stejné id (druhé volání nenajde žádné
// řádky k úpravě, je to no-op) — testováno v tests/ochrana-mazani-rezervaci.test.js.
async function uklidRezervaciSFallbackem(adminFetch, id) {
  try {
    const res = await adminFetch(`/admin/rezervace/${id}`, { method: 'DELETE' });
    if (res && res.ok) return;
  } catch {}
  await smazatRezervaciNatvrdo(id).catch(() => {});
}

module.exports = { smazatRezervaciNatvrdo, uklidRezervaciSFallbackem };
