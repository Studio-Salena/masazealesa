// Jednosměrná synchronizace rezervací do osobního Google kalendáře uživatelky.
// Výhradně zápis (insert/update/delete události) — ze čtení se tu NIKDY nic
// nevrací zpět do appky, takže zpětná propagace (Google -> admin/web) fyzicky
// neexistuje. Sync se týká jen rezervace.stav IN ('cekajici','potvrzena') —
// jiný stav znamená "smazat událost, pokud existuje".
//
// Bez GOOGLE_CALENDAR_SA_KEY/GOOGLE_CALENDAR_ID (lokální vývoj, testy, nebo
// prostě dokud si to uživatelka nenastaví) je celý modul tiché no-op — nic
// jiného v appce na něm nesmí záviset.

const { google } = require('googleapis');

const TIMEZONE = 'Europe/Prague';

let klientCache = undefined; // undefined = ještě nezjištěno, false = nejde použít, jinak klient

function ziskatKalendarClient() {
  if (klientCache !== undefined) return klientCache;
  const klicJson = process.env.GOOGLE_CALENDAR_SA_KEY;
  if (!klicJson || !process.env.GOOGLE_CALENDAR_ID) {
    klientCache = false;
    return klientCache;
  }
  try {
    const klic = JSON.parse(klicJson);
    const auth = new google.auth.JWT(klic.client_email, null, klic.private_key, ['https://www.googleapis.com/auth/calendar']);
    klientCache = google.calendar({ version: 'v3', auth });
  } catch (e) {
    console.error('Google Kalendář: neplatný GOOGLE_CALENDAR_SA_KEY —', e.message);
    klientCache = false;
  }
  return klientCache;
}

function udalostZRezervace(r) {
  const znacka = r.stav === 'cekajici' ? '❓ Čeká na potvrzení: ' : '';
  const popis = [
    r.telefon ? 'Tel.: ' + r.telefon : null,
    r.email ? 'E-mail: ' + r.email : null,
    r.poznamka ? 'Poznámka: ' + r.poznamka : null
  ].filter(Boolean).join('\n');
  return {
    summary: znacka + r.masaz + ' – ' + r.jmeno,
    description: popis || undefined,
    start: { dateTime: `${r.datum}T${String(r.cas_od).slice(0, 5)}:00`, timeZone: TIMEZONE },
    end: { dateTime: `${r.datum}T${String(r.cas_do).slice(0, 5)}:00`, timeZone: TIMEZONE }
  };
}

// db = instance pg.Pool (nebo klient s kompatibilním .query) — pro zápis
// nově přiděleného/vynulovaného google_event_id po insertu/mazání.
async function synchronizovatKalendar(db, rezervace) {
  const kalendar = ziskatKalendarClient();
  if (!kalendar) return;
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const maBytVKalendari = rezervace.stav === 'cekajici' || rezervace.stav === 'potvrzena';

  try {
    if (!maBytVKalendari) {
      if (rezervace.google_event_id) {
        await kalendar.events.delete({ calendarId, eventId: rezervace.google_event_id }).catch(e => {
          if (e.code !== 404 && e.code !== 410) throw e; // už smazaná/neexistující = v pořádku
        });
        await db.query('UPDATE rezervace SET google_event_id = NULL WHERE id = $1', [rezervace.id]);
      }
      return;
    }

    const udalost = udalostZRezervace(rezervace);
    if (rezervace.google_event_id) {
      try {
        await kalendar.events.update({ calendarId, eventId: rezervace.google_event_id, requestBody: udalost });
      } catch (e) {
        if (e.code !== 404 && e.code !== 410) throw e;
        // Událost v Google kalendáři mezitím zmizela (smazána ručně) — založit novou namísto ní.
        const { data } = await kalendar.events.insert({ calendarId, requestBody: udalost });
        await db.query('UPDATE rezervace SET google_event_id = $1 WHERE id = $2', [data.id, rezervace.id]);
      }
    } else {
      const { data } = await kalendar.events.insert({ calendarId, requestBody: udalost });
      await db.query('UPDATE rezervace SET google_event_id = $1 WHERE id = $2', [data.id, rezervace.id]);
    }
  } catch (e) {
    console.error('Google Kalendář: synchronizace rezervace #' + rezervace.id + ' selhala —', e.message);
  }
}

// Nepodmíněné smazání události (pro trvalé smazání rezervace z DB) — řádek
// už v tu chvíli nemusí v databázi existovat, proto se tu google_event_id
// nikam nezapisuje zpátky.
async function odstranitUdalost(rezervace) {
  const kalendar = ziskatKalendarClient();
  if (!kalendar || !rezervace.google_event_id) return;
  try {
    await kalendar.events.delete({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: rezervace.google_event_id });
  } catch (e) {
    if (e.code !== 404 && e.code !== 410) {
      console.error('Google Kalendář: smazání události rezervace #' + rezervace.id + ' selhalo —', e.message);
    }
  }
}

module.exports = { synchronizovatKalendar, odstranitUdalost };
