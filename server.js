// ══════════════════════════════════════════════════════════
// Masáže Alesa — backend API
// Veřejné endpointy: ceník, volné termíny, vytvoření rezervace, žádost o poukaz, newsletter
// Admin endpointy (chráněné heslem): správa rezervací, termínů, poukazů, ceníku, newsletteru
// Databáze: PostgreSQL (Supabase) — připojení přes DATABASE_URL
// ══════════════════════════════════════════════════════════
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool, types } = require('pg');

const API_URL = process.env.API_URL || 'https://masazealesa.onrender.com';

// numeric sloupce (cena, hodnota, zůstatek...) ať chodí jako číslo, ne jako řetězec
types.setTypeParser(1700, val => (val === null ? null : parseFloat(val)));
// date sloupce (datum, platnost_do) necháme jako čisté 'YYYY-MM-DD' — žádné posuny časovým pásmem
types.setTypeParser(1082, val => val);

const app = express();
app.use(cors());
app.use(express.json());

// Databáze běží na jiném serveru než backend (Supabase), proto vždy přes SSL.
// Pozor: DATABASE_URL nesmí obsahovat "sslmode=..." — knihovna pg by si ho sama
// naparsovala a přepsala by tím rejectUnauthorized na true (ověřování certifikátu
// pak selže na "self-signed certificate in certificate chain").
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
db.on('error', (err) => console.error('Neočekávaná chyba databázového spojení:', err.message));

const ADMIN_HESLO = process.env.ADMIN_HESLO;
const CRON_KLIC = process.env.CRON_KLIC; // sdílené heslo pro denní úlohu (připomínky, žádosti o recenzi)

async function ziskatBufferMinut() {
  try {
    const { rows: [n] } = await db.query("SELECT hodnota FROM nastaveni WHERE klic = 'buffer_minut'");
    const cislo = n ? parseInt(n.hodnota, 10) : NaN;
    return Number.isFinite(cislo) ? cislo : 30;
  } catch { return 30; }
}

// Nejdřívější datum, od kterého jsou online rezervace vůbec možné (nepovinné —
// nastavuje se v adminu, ať jde spustit rezervace k danému datu bez nutnosti
// zakládat "výjimku provozu" s důvodem). Vrací null, když omezení není nastavené.
async function ziskatRezervaceOd() {
  try {
    const { rows: [n] } = await db.query("SELECT hodnota FROM nastaveni WHERE klic = 'rezervace_od'");
    return n && n.hodnota ? n.hodnota : null;
  } catch { return null; }
}

// Přepočte rezervace.uhrazeno/stav_platby/zpusob_platby/uhrazeno_kdy jako souhrn
// deníku "platby" pro danou rezervaci — VŽDY nově spočtený součet, ne postupné
// přičítání, takže se nikdy nemůže rozejít s deníkem (jediný zdroj pravdy).
// Musí běžet uvnitř transakce, která před tím zamkla řádek rezervace (FOR UPDATE),
// a hned po zápisu nového řádku do "platby" ve stejné transakci.
async function prepocitatSouhrnRezervace(client, rezervaceId) {
  const { rows: [r] } = await client.query('SELECT * FROM rezervace WHERE id = $1', [rezervaceId]);
  const { rows: [{ soucet }] } = await client.query(
    'SELECT COALESCE(SUM(castka), 0) AS soucet FROM platby WHERE rezervace_id = $1', [rezervaceId]
  );
  const { rows: [posledni] } = await client.query(
    'SELECT zpusob_platby FROM platby WHERE rezervace_id = $1 ORDER BY vytvoreno DESC, id DESC LIMIT 1', [rezervaceId]
  );
  const uhrazeno = Number(soucet);
  const cena = Number(r.cena) || 0;
  const novyStav = uhrazeno <= 0 ? 'nezaplaceno' : (uhrazeno >= cena ? 'zaplaceno' : 'castecne_zaplaceno');
  const noveUhrazenoKdy = novyStav === 'zaplaceno'
    ? (r.stav_platby === 'zaplaceno' ? r.uhrazeno_kdy : new Date())
    : null;
  const { rows: [aktualizovana] } = await client.query(
    `UPDATE rezervace SET uhrazeno = $1, stav_platby = $2, zpusob_platby = $3, uhrazeno_kdy = $4 WHERE id = $5 RETURNING *`,
    [uhrazeno, novyStav, posledni ? posledni.zpusob_platby : null, noveUhrazenoKdy, rezervaceId]
  );
  return aktualizovana;
}

function vyzadovatAdmina(req, res, next) {
  const heslo = req.headers['x-admin-heslo'] || '';
  if (!ADMIN_HESLO || heslo !== ADMIN_HESLO) {
    return res.status(401).json({ chyba: 'Neplatné heslo' });
  }
  next();
}

function vygenerovatKod() {
  const znaky = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let kod = 'ALESA-';
  for (let i = 0; i < 6; i++) kod += znaky[Math.floor(Math.random() * znaky.length)];
  return kod;
}

// Vygeneruje EAN-13 čárový kód pro tisk na poukaz (prefix 20-29 = vyhrazeno GS1 pro vlastní/interní použití)
function vygenerovatEan() {
  let zaklad = '20';
  for (let i = 0; i < 10; i++) zaklad += Math.floor(Math.random() * 10);
  let soucet = 0;
  for (let i = 0; i < 12; i++) soucet += Number(zaklad[i]) * (i % 2 === 0 ? 1 : 3);
  const kontrolni = (10 - (soucet % 10)) % 10;
  return zaklad + kontrolni;
}

function casNaMinuty(cas) { const [h, m] = cas.split(':').map(Number); return h * 60 + m; }
function minutyNaCas(min) { const h = Math.floor(min / 60), m = min % 60; return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'); }

// Pošle e-mail přes Resend (RESEND_API_KEY v env). Nikdy nevyhazuje výjimku, jen vrátí true/false.
async function odeslatEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  const from = process.env.RESEND_FROM || 'Masáže Alesa <onboarding@resend.dev>';
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html })
    });
    return resp.ok;
  } catch {
    return false;
  }
}
function formatDatumCz(datumIso) {
  const [rok, mesic, den] = datumIso.split('-');
  return `${Number(den)}. ${Number(mesic)}. ${rok}`;
}

// Sdílená vizuální šablona pro úplně všechny e-maily ze salónu (přijetí rezervace,
// potvrzení, připomínka, žádost o recenzi, newsletter) — ať mají jednotný vzhled.
// `telo` je jen obsah uvnitř bílé karty (nadpis + text), hlavičku s logem a patičku
// přidává tahle funkce automaticky.
function emailSablona(telo) {
  return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Masáže Alesa</title>
<style>
  body { margin:0; padding:0; background-color:#fcfbfa; font-family:'Helvetica Neue', Helvetica, Arial, sans-serif; color:#4a4541; line-height:1.6; }
  .email-wrapper { width:100%; table-layout:fixed; background-color:#fcfbfa; padding:40px 0; }
  .email-content { max-width:600px; margin:0 auto; background-color:#ffffff; border-radius:8px; overflow:hidden; border:1px solid #f0ece6; box-shadow:0 4px 15px rgba(0,0,0,0.03); }
  .email-header { background:linear-gradient(135deg, #fffcf7 0%, #f7f1e5 100%); padding:35px 20px; text-align:center; border-bottom:1px solid #f0ece6; }
  .email-header img { max-width:120px; height:auto; margin-bottom:15px; }
  .email-header h1 { color:#bfa14f; font-size:24px; margin:0; font-weight:400; letter-spacing:1px; }
  .email-body { padding:40px 30px; }
  .email-body h2 { color:#332e2a; font-size:20px; margin-top:0; font-weight:500; }
  .email-body p { margin-bottom:20px; font-size:15px; }
  .rez-detail { background-color:#f7f5f0; border-radius:6px; padding:18px 22px; font-size:15px; margin-bottom:20px; }
  .btn-container { text-align:center; margin:35px 0; }
  .btn { background-color:#d4af37; color:#ffffff; padding:12px 30px; text-decoration:none; border-radius:4px; font-weight:500; letter-spacing:0.5px; display:inline-block; box-shadow:0 2px 5px rgba(212,175,55,0.3); }
  .email-footer { background-color:#f7f5f0; padding:25px 20px; text-align:center; font-size:13px; color:#8c837b; border-top:1px solid #f0ece6; }
  .email-footer a { color:#bfa14f; text-decoration:none; }
</style>
</head>
<body>
  <table class="email-wrapper" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center">
        <table class="email-content" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td class="email-header">
              <img src="https://www.masazealesa.cz/assets/logo.png" alt="Masáže Alesa">
              <h1>Masáže Alesa</h1>
            </td>
          </tr>
          <tr>
            <td class="email-body">
              ${telo}
            </td>
          </tr>
          <tr>
            <td class="email-footer">
              <p>Masáže Alesa | Hulín<br>
              Navštivte můj web: <a href="https://www.masazealesa.cz" target="_blank">www.masazealesa.cz</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Rezervace přijata (hned po odeslání formuláře na webu)
function prijataEmailHtml(jmeno, nazevMasaze, datum, casOd, casDo) {
  return emailSablona(`
    <h2>Dobrý den, ${jmeno},</h2>
    <p>děkuji za rezervaci. Přijala jsem ji a brzy vám ji telefonicky nebo e-mailem potvrdím.</p>
    <table class="rez-detail" width="100%" cellpadding="0" cellspacing="0">
      <tr><td>
        <strong>Masáž:</strong> ${nazevMasaze}<br>
        <strong>Datum:</strong> ${formatDatumCz(datum)}<br>
        <strong>Čas:</strong> ${casOd}–${casDo}
      </td></tr>
    </table>
    <p>V případě potřeby mě prosím kontaktujte na tel. 736 734 951.</p>
    <p>S pozdravem,<br><strong>Alena Hasalová</strong><br>Masáže Alesa</p>
  `);
}

// Rezervace potvrzena (odesílá se, když Alena v adminu přepne rezervaci na stav "potvrzena")
function potvrzovaciEmailHtml(r) {
  return emailSablona(`
    <h2>Dobrý den, ${r.jmeno},</h2>
    <p>vaše rezervace je potvrzená — těším se na vaši návštěvu.</p>
    <table class="rez-detail" width="100%" cellpadding="0" cellspacing="0">
      <tr><td>
        <strong>Masáž:</strong> ${r.masaz}<br>
        <strong>Datum:</strong> ${formatDatumCz(r.datum)}<br>
        <strong>Čas:</strong> ${r.cas_od.slice(0,5)}–${r.cas_do.slice(0,5)}
      </td></tr>
    </table>
    <p>Pokud potřebujete termín změnit nebo zrušit, ozvěte se mi prosím co nejdřív.</p>
    <div class="btn-container">
      <a href="tel:736734951" class="btn">Zavolat kvůli změně termínu</a>
    </div>
    <p>S pozdravem,<br><strong>Alena Hasalová</strong><br>Masáže Alesa</p>
  `);
}

// Připomínka den předem (denní cron úloha)
function pripomenkaEmailHtml(r) {
  return emailSablona(`
    <h2>Dobrý den, ${r.jmeno},</h2>
    <p>připomínám vaši rezervaci na zítra:</p>
    <table class="rez-detail" width="100%" cellpadding="0" cellspacing="0">
      <tr><td>
        <strong>Masáž:</strong> ${r.masaz}<br>
        <strong>Datum:</strong> ${formatDatumCz(r.datum)}<br>
        <strong>Čas:</strong> ${String(r.cas_od).slice(0,5)}–${String(r.cas_do).slice(0,5)}
      </td></tr>
    </table>
    <p>Pokud se nemůžete dostavit, dejte mi prosím vědět na tel. 736 734 951.</p>
    <p>S pozdravem,<br><strong>Alena Hasalová</strong><br>Masáže Alesa</p>
  `);
}

// Žádost o recenzi den po návštěvě (denní cron úloha)
function recenzeEmailHtml(r) {
  return emailSablona(`
    <h2>Dobrý den, ${r.jmeno},</h2>
    <p>děkuji, že jste včera navštívila můj salón. Budu moc ráda, když mi napíšete pár slov zpětné vazby nebo necháte recenzi.</p>
    <div class="btn-container">
      <a href="https://www.facebook.com/masazehasalova" class="btn">Napsat recenzi na Facebooku</a>
    </div>
    <p>S pozdravem,<br><strong>Alena Hasalová</strong><br>Masáže Alesa</p>
  `);
}

// ── LOGIN (admin) ──
app.post('/api/login', (req, res) => {
  const { heslo } = req.body || {};
  if (ADMIN_HESLO && heslo === ADMIN_HESLO) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

// ══════════════ VEŘEJNÉ ENDPOINTY ══════════════

// Ceník pro zobrazení na webu (seřazeno podle skupiny a varianty)
app.get('/api/cenik', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM cenik ORDER BY poradi_skupiny, poradi_varianty');
    res.json(rows);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Varianty poukazů (částka + platnost) — stejný zdroj dat jako v adminu, ať web nemá vlastní napevno psané hodnoty
app.get('/api/poukazy/typy', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, hodnota, platnost_mesicu FROM poukazy_typy ORDER BY poradi');
    res.json(rows);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Zjistí skutečnou otevírací dobu pro konkrétní datum: buď normální týdenní
// pracovní dobu, nebo — pokud na ten den existuje "výjimka provozu" s vlastní
// otevírací dobou — tu (ať jde nastavit třeba jeden den v měsíci s delší
// otevírací dobou). Výjimka bez vlastní otevírací doby = celý den zavřeno
// (dovolená/svátek, dosavadní chování). Vrací null, když je ten den zavřeno.
async function ziskatEfektivniOtevrenoDobu(datum) {
  const { rows: [vyjimka] } = await db.query(
    'SELECT * FROM provozni_vyjimky WHERE $1 BETWEEN datum_od AND datum_do LIMIT 1', [datum]
  );
  if (vyjimka) {
    if (!vyjimka.otevreno_od || !vyjimka.otevreno_do) return null;
    return { otevreno_od: vyjimka.otevreno_od, otevreno_do: vyjimka.otevreno_do, pauza_od: null, pauza_do: null };
  }
  const denVTydnu = new Date(datum + 'T12:00:00').getDay();
  const { rows: [pd] } = await db.query('SELECT * FROM pracovni_doba WHERE den_v_tydnu = $1', [denVTydnu]);
  if (!pd || !pd.aktivni) return null;
  return { otevreno_od: pd.otevreno_od, otevreno_do: pd.otevreno_do, pauza_od: pd.pauza_od, pauza_do: pd.pauza_do };
}

// Spočte pro daný den seznam kandidátních časů (po 15 min) s příznakem volno/obsazeno,
// bez jakýchkoliv osobních údajů — jen čas.
async function spocitatTerminyDne(datum, delka) {
  const rezervaceOd = await ziskatRezervaceOd();
  if (rezervaceOd && datum < rezervaceOd) return [];
  const oteviraciDoba = await ziskatEfektivniOtevrenoDobu(datum);
  if (!oteviraciDoba) return [];
  const bufferMin = await ziskatBufferMinut();
  const { rows: existujici } = await db.query(
    "SELECT cas_od, cas_do FROM rezervace WHERE datum = $1 AND stav <> 'zrusena'", [datum]
  );
  // Obsazené intervaly rozšířené o mezeru na obě strany
  const obsazeno = existujici.map(r => ({
    od: casNaMinuty(r.cas_od) - bufferMin,
    do: casNaMinuty(r.cas_do) + bufferMin
  }));
  const otevrenoOd = casNaMinuty(oteviraciDoba.otevreno_od);
  const otevrenoDo = casNaMinuty(oteviraciDoba.otevreno_do);
  const pauzaOd = oteviraciDoba.pauza_od ? casNaMinuty(oteviraciDoba.pauza_od) : null;
  const pauzaDo = oteviraciDoba.pauza_do ? casNaMinuty(oteviraciDoba.pauza_do) : null;
  const KROK = 15; // kandidátní časy po 15 minutách
  const terminy = [];
  for (let start = otevrenoOd; start + delka <= otevrenoDo; start += KROK) {
    const konec = start + delka;
    const koliduje = obsazeno.some(o => start < o.do && konec > o.od);
    const vPauze = pauzaOd !== null && pauzaDo !== null && start < pauzaDo && konec > pauzaOd;
    terminy.push({ cas: minutyNaCas(start), volno: !koliduje && !vPauze });
  }
  return terminy;
}

// Volné termíny pro konkrétní datum a položku ceníku (počítá se dynamicky)
app.get('/api/rezervace/volne-terminy', async (req, res) => {
  const { datum, cenik_id } = req.query;
  if (!datum || !cenik_id) return res.status(400).json({ chyba: 'Zadejte datum a masáž.' });
  try {
    const { rows: [polozkaCeniku] } = await db.query('SELECT * FROM cenik WHERE id = $1', [cenik_id]);
    if (!polozkaCeniku) return res.status(404).json({ chyba: 'Tato masáž nebyla v ceníku nalezena.' });
    if (!polozkaCeniku.rezervovatelna) return res.status(400).json({ chyba: 'Na tuto položku nelze rezervovat online.' });

    res.json(await spocitatTerminyDne(datum, polozkaCeniku.delka_min));
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Celý týden (7 dní od zadaného data) najednou, pro kalendářové zobrazení rezervace na webu
app.get('/api/rezervace/kalendar', async (req, res) => {
  const { zacatek, cenik_id } = req.query;
  if (!zacatek || !cenik_id) return res.status(400).json({ chyba: 'Zadejte datum a masáž.' });
  try {
    const { rows: [polozkaCeniku] } = await db.query('SELECT * FROM cenik WHERE id = $1', [cenik_id]);
    if (!polozkaCeniku) return res.status(404).json({ chyba: 'Tato masáž nebyla v ceníku nalezena.' });
    if (!polozkaCeniku.rezervovatelna) return res.status(400).json({ chyba: 'Na tuto položku nelze rezervovat online.' });

    const dny = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(zacatek + 'T12:00:00');
      d.setDate(d.getDate() + i);
      const datum = d.toISOString().slice(0, 10);
      const terminy = await spocitatTerminyDne(datum, polozkaCeniku.delka_min);
      dny.push({ datum, terminy });
    }
    res.json(dny);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Vytvoření rezervace klientkou
app.post('/api/rezervace', async (req, res) => {
  const { datum, cas_od, jmeno, telefon, email, cenik_id, poznamka, poukaz_kod, alergie, preference, souhlas_gdpr, souhlas_newsletter } = req.body || {};
  if (!datum || !cas_od || !jmeno || !telefon || !email || !cenik_id) {
    return res.status(400).json({ chyba: 'Vyplňte prosím jméno, telefon, e-mail, masáž, datum a čas.' });
  }
  if (!souhlas_gdpr) {
    return res.status(400).json({ chyba: 'Pro odeslání rezervace je potřeba souhlasit se zpracováním osobních údajů.' });
  }
  // Celý blok (kontrola kolize + zápis) běží v jedné transakci uzamčené na dané datum,
  // aby se dvě rezervace odeslané prakticky současně nemohly obě protlačit na stejný
  // (nebo těsně sousedící) termín — bez zámku by obě mohly projít kontrolou dřív, než
  // se stihne zapsat ta první (tzv. race condition).
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [datum]);

    const { rows: [polozkaCeniku] } = await client.query('SELECT * FROM cenik WHERE id = $1', [cenik_id]);
    if (!polozkaCeniku) { await client.query('ROLLBACK'); return res.status(404).json({ chyba: 'Tato masáž nebyla v ceníku nalezena.' }); }
    if (!polozkaCeniku.rezervovatelna) { await client.query('ROLLBACK'); return res.status(400).json({ chyba: 'Na tuto položku nelze rezervovat online.' }); }

    const rezervaceOd = await ziskatRezervaceOd();
    if (rezervaceOd && datum < rezervaceOd) {
      await client.query('ROLLBACK');
      return res.status(400).json({ chyba: `Online rezervace spouštíme až od ${formatDatumCz(rezervaceOd)}, vyberte prosím pozdější datum.` });
    }

    const oteviraciDoba = await ziskatEfektivniOtevrenoDobu(datum);
    if (!oteviraciDoba) { await client.query('ROLLBACK'); return res.status(400).json({ chyba: 'V tento den bohužel nerezervujeme (dovolená/svátek/zavřeno), vyberte prosím jiné datum.' }); }

    const zacatek = casNaMinuty(cas_od);
    const konec = zacatek + polozkaCeniku.delka_min;
    const cas_do = minutyNaCas(konec);
    const nazevMasaze = polozkaCeniku.skupina + ' – ' + polozkaCeniku.varianta;

    const otevrenoOd = casNaMinuty(oteviraciDoba.otevreno_od);
    const otevrenoDo = casNaMinuty(oteviraciDoba.otevreno_do);
    if (zacatek < otevrenoOd || konec > otevrenoDo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ chyba: 'Tento čas je mimo otevírací dobu, vyberte prosím jiný.' });
    }
    if (oteviraciDoba.pauza_od && oteviraciDoba.pauza_do) {
      const pauzaOd = casNaMinuty(oteviraciDoba.pauza_od), pauzaDo = casNaMinuty(oteviraciDoba.pauza_do);
      if (zacatek < pauzaDo && konec > pauzaOd) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: 'Tento čas spadá do polední pauzy, vyberte prosím jiný.' });
      }
    }

    // Znovu ověřit kolizi (ochrana proti dvěma klientkám, co kliknou zároveň) — teď už pod zámkem výše
    const bufferMin = await ziskatBufferMinut();
    const { rows: existujici } = await client.query(
      "SELECT cas_od, cas_do FROM rezervace WHERE datum = $1 AND stav <> 'zrusena'", [datum]
    );
    const koliduje = existujici.some(r => {
      const oOd = casNaMinuty(r.cas_od) - bufferMin, oDo = casNaMinuty(r.cas_do) + bufferMin;
      return zacatek < oDo && konec > oOd;
    });
    if (koliduje) { await client.query('ROLLBACK'); return res.status(409).json({ chyba: 'Tento termín je již obsazený (nebo příliš blízko jiné rezervaci), vyberte prosím jiný.' }); }

    // Ověření poukazu je tu jen informativní (skutečné uplatnění/odečtení zůstatku
    // dělá Alena ručně při platbě v salonu přes POST /api/admin/poukazy/:id/uplatnit,
    // který to dělá bezpečně/atomicky) — ale ověřuje se pořádně, ať poznámka u
    // rezervace neříká "ověřen", když je poukaz ve skutečnosti nepoužitelný.
    let poukazPoznamka = '';
    if (poukaz_kod && poukaz_kod.trim()) {
      const { rows: [poukaz] } = await client.query(
        'SELECT * FROM poukazy WHERE kod = $1 OR ean = $1', [poukaz_kod.trim()]
      );
      if (!poukaz) {
        poukazPoznamka = ` Pozor: zadaný poukaz "${poukaz_kod.trim()}" nebyl nalezen — ověřit ručně.`;
      } else if (poukaz.stav === 'zruseny') {
        poukazPoznamka = ` Pozor: poukaz ${poukaz.kod} je zrušený.`;
      } else if (poukaz.stav === 'pouzity' || Number(poukaz.zustatek) <= 0) {
        poukazPoznamka = ` Pozor: poukaz ${poukaz.kod} je už plně vyčerpaný.`;
      } else if (poukaz.platnost_do < datum) {
        poukazPoznamka = ` Pozor: poukaz ${poukaz.kod} bude mít v den masáže (${formatDatumCz(datum)}) už prošlou platnost (platí do ${formatDatumCz(poukaz.platnost_do)}).`;
      } else if (poukaz.konkretni_masaz && poukaz.konkretni_masaz !== nazevMasaze) {
        poukazPoznamka = ` Pozor: poukaz ${poukaz.kod} platí jen na "${poukaz.konkretni_masaz}", ne na vybranou masáž — ověřit ručně.`;
      } else {
        poukazPoznamka = ` Poukaz ${poukaz.kod} ověřen (zůstatek ${poukaz.zustatek} Kč, platí do ${formatDatumCz(poukaz.platnost_do)}).`;
      }
    }

    const celaPoznamka = ((poznamka || '') + poukazPoznamka).trim() || null;
    const { rows: [rezervace] } = await client.query(
      `INSERT INTO rezervace (cenik_id, datum, cas_od, cas_do, jmeno, telefon, email, masaz, poznamka, poukaz_kod, stav, cena)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'cekajici',$11) RETURNING *`,
      [cenik_id, datum, cas_od, cas_do, jmeno, telefon, email || null, nazevMasaze, celaPoznamka, poukaz_kod || null, polozkaCeniku.cena]
    );

    await client.query('COMMIT');

    // Alergie/preference se ukládají k zákaznici (podle telefonu), ať je Alena vidí
    // příště u každé další rezervace, ne jen jako poznámku u tohohle jednoho termínu.
    if (alergie || preference) {
      db.query(
        `INSERT INTO zakaznici (telefon, jmeno, email, alergie, preference, upraveno) VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (telefon) DO UPDATE SET
           jmeno = COALESCE($2, zakaznici.jmeno),
           email = COALESCE($3, zakaznici.email),
           alergie = COALESCE($4, zakaznici.alergie),
           preference = COALESCE($5, zakaznici.preference),
           upraveno = now()`,
        [telefon.trim(), jmeno || null, email || null, alergie || null, preference || null]
      ).catch(() => {});
    }

    if (souhlas_newsletter && email) {
      const token = crypto.randomBytes(20).toString('hex');
      db.query(
        `INSERT INTO newsletter_odberatele (email, jmeno, odhlasovaci_token)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET aktivni = true, jmeno = COALESCE($2, newsletter_odberatele.jmeno)`,
        [email.trim().toLowerCase(), jmeno || null, token]
      ).catch(() => {});
    }

    if (email) {
      odeslatEmail(email, 'Rezervace přijata – Masáže Alesa', prijataEmailHtml(jmeno, nazevMasaze, datum, cas_od, cas_do));
    }

    res.json({ ok: true, rezervace });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).json({ chyba: e.message });
  } finally {
    client.release();
  }
});

// Žádost o dárkový poukaz z webového formuláře
app.post('/api/poukazy/zadost', async (req, res) => {
  const { hodnota, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, vzkaz, konkretni_masaz, zpusob_platby } = req.body || {};
  if (!hodnota || !kupujici_jmeno || !kupujici_email) {
    return res.status(400).json({ chyba: 'Vyplňte prosím hodnotu poukazu, jméno a e-mail.' });
  }
  if (!['qr', 'prevodem', 'pri_prevzeti'].includes(zpusob_platby)) {
    return res.status(400).json({ chyba: 'Vyberte prosím způsob platby.' });
  }
  try {
    const { rows: [zadost] } = await db.query(
      `INSERT INTO poukazy_zadosti (hodnota, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, vzkaz, konkretni_masaz, zpusob_platby, stav)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'nova') RETURNING *`,
      [hodnota, kupujici_jmeno, kupujici_email, kupujici_telefon || null, pro_koho || null, vzkaz || null, konkretni_masaz || null, zpusob_platby]
    );
    res.json({ ok: true, zadost });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Přihlášení k newsletteru z webového formuláře ("Tipy a novinky přímo do e-mailu")
app.post('/api/newsletter', async (req, res) => {
  const { email, jmeno } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ chyba: 'Zadejte prosím platný e-mail.' });
  try {
    const token = crypto.randomBytes(20).toString('hex');
    await db.query(
      `INSERT INTO newsletter_odberatele (email, jmeno, odhlasovaci_token)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET aktivni = true, jmeno = COALESCE($2, newsletter_odberatele.jmeno)`,
      [email.trim().toLowerCase(), jmeno || null, token]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Odhlášení z newsletteru přes odkaz v e-mailu (otevírá se přímo v prohlížeči)
app.get('/api/newsletter/odhlasit', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Chybí odhlašovací odkaz.');
  try {
    const { rowCount } = await db.query(
      'UPDATE newsletter_odberatele SET aktivni = false WHERE odhlasovaci_token = $1', [token]
    );
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>${rowCount ? 'Byli jste odhlášeni z newsletteru.' : 'Odkaz nenalezen (možná už jste odhlášeni).'}</h2>
    </body></html>`);
  } catch (e) { res.status(500).send('Chyba serveru.'); }
});

// ══════════════ ADMIN ENDPOINTY (heslo v hlavičce x-admin-heslo) ══════════════
app.use('/api/admin', vyzadovatAdmina);

// -- Přehled --
app.get('/api/admin/prehled', async (req, res) => {
  try {
    const dnes = new Date().toISOString().slice(0, 10);
    const [rez, pouk, zad] = await Promise.all([
      db.query('SELECT id, stav, datum FROM rezervace'),
      db.query('SELECT id, stav, zustatek FROM poukazy'),
      db.query('SELECT id, stav FROM poukazy_zadosti')
    ]);
    res.json({
      rezervaceCelkem: rez.rows.length,
      rezervaceCekajici: rez.rows.filter(r => r.stav === 'cekajici').length,
      rezervaceBudouci: rez.rows.filter(r => r.datum >= dnes && r.stav !== 'zrusena').length,
      poukazyAktivni: pouk.rows.filter(p => p.stav === 'aktivni').length,
      poukazyHodnota: pouk.rows.filter(p => p.stav === 'aktivni').reduce((s, p) => s + Number(p.zustatek), 0),
      poukazyZadostiNove: zad.rows.filter(z => z.stav === 'nova').length
    });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// -- Rezervace --
app.get('/api/admin/rezervace', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM rezervace ORDER BY datum DESC, cas_od DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Ruční založení rezervace přímo Alenou (např. klientka mimo běžnou otevírací dobu) —
// na rozdíl od veřejného POST /api/rezervace se tu neřeší otevírací doba ani datum
// "rezervace možné od" (to platí jen pro online rezervace klientkami), ale kolize
// s ostatními rezervacemi (+ mezera) se pořád hlídá, ať se nepřepíšou dvě klientky
// na stejný čas. Rezervace se rovnou založí jako "potvrzena" a pošle se e-mail.
app.post('/api/admin/rezervace', async (req, res) => {
  const { datum, cas_od, jmeno, telefon, email, cenik_id, poznamka } = req.body || {};
  // telefon je v databázi "not null" — bez kontroly tady by INSERT spadl na chybě
  // databáze a vrátil nesrozumitelnou 500 míso jasné validační chyby.
  if (!datum || !cas_od || !jmeno || !telefon || !cenik_id) {
    return res.status(400).json({ chyba: 'Vyplňte prosím jméno, telefon, masáž, datum a čas.' });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [datum]);

    const { rows: [polozkaCeniku] } = await client.query('SELECT * FROM cenik WHERE id = $1', [cenik_id]);
    if (!polozkaCeniku) { await client.query('ROLLBACK'); return res.status(404).json({ chyba: 'Tato masáž nebyla v ceníku nalezena.' }); }

    const zacatek = casNaMinuty(cas_od);
    const konec = zacatek + polozkaCeniku.delka_min;
    const cas_do = minutyNaCas(konec);
    const nazevMasaze = polozkaCeniku.skupina + ' – ' + polozkaCeniku.varianta;

    const bufferMin = await ziskatBufferMinut();
    const { rows: existujici } = await client.query(
      "SELECT cas_od, cas_do FROM rezervace WHERE datum = $1 AND stav <> 'zrusena'", [datum]
    );
    const koliduje = existujici.some(r => {
      const oOd = casNaMinuty(r.cas_od) - bufferMin, oDo = casNaMinuty(r.cas_do) + bufferMin;
      return zacatek < oDo && konec > oOd;
    });
    if (koliduje) { await client.query('ROLLBACK'); return res.status(409).json({ chyba: 'Tento termín koliduje s jinou rezervací (nebo je jí příliš blízko).' }); }

    const { rows: [rezervace] } = await client.query(
      `INSERT INTO rezervace (cenik_id, datum, cas_od, cas_do, jmeno, telefon, email, masaz, poznamka, stav, cena)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'potvrzena',$10) RETURNING *`,
      [cenik_id, datum, cas_od, cas_do, jmeno, telefon || null, email || null, nazevMasaze, poznamka || null, polozkaCeniku.cena]
    );

    await client.query('COMMIT');

    if (email) {
      odeslatEmail(email, 'Rezervace potvrzena – Masáže Alesa', potvrzovaciEmailHtml(rezervace));
    }

    res.json({ ok: true, rezervace });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).json({ chyba: e.message });
  } finally {
    client.release();
  }
});

app.patch('/api/admin/rezervace/:id/stav', async (req, res) => {
  const { stav } = req.body || {};
  if (!['cekajici', 'potvrzena', 'dokoncena', 'nedostavila_se', 'zrusena'].includes(stav)) {
    return res.status(400).json({ chyba: 'Neplatný stav.' });
  }
  try {
    const { rows: [predtim] } = await db.query('SELECT * FROM rezervace WHERE id = $1', [req.params.id]);
    await db.query('UPDATE rezervace SET stav = $1 WHERE id = $2', [stav, req.params.id]);
    // E-mail o potvrzení se posílá jen při skutečném přechodu do stavu "potvrzena"
    // (ne při každém uložení, ať se neposílá opakovaně).
    if (predtim && stav === 'potvrzena' && predtim.stav !== 'potvrzena' && predtim.email) {
      odeslatEmail(predtim.email, 'Rezervace potvrzena – Masáže Alesa', potvrzovaciEmailHtml(predtim));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Zaznamenání platby NEBO vratky k rezervaci — zapíše řádek do deníku "platby"
// a ve STEJNÉ transakci přepočte souhrn na rezervaci (viz prepocitatSouhrnRezervace).
// Buď se zapíše obojí, nebo nic (žádný poloviční zápis). Stav platby je záměrně
// nezávislý na stavu rezervace (dokončená masáž může zůstat nezaplacená a naopak).
// Zámek řádku rezervace (FOR UPDATE) chrání proti dvěma souběžným platbám, co by
// si jinak navzájem přepsaly součet (tzv. lost update).
// typ: 'platba' (výchozí) nebo 'vratka' — vratka se ukládá jako záporná částka,
// ale zůstává v deníku navždy vedle původní platby (nemaže historii).
app.patch('/api/admin/rezervace/:id/platba', async (req, res) => {
  const { castka, zpusob_platby, typ } = req.body || {};
  const druh = typ === 'vratka' ? 'vratka' : 'platba';
  const castkaNum = Number(castka);
  if (!Number.isFinite(castkaNum) || castkaNum <= 0) {
    return res.status(400).json({ chyba: 'Zadejte prosím kladnou částku.' });
  }
  if (!['hotove', 'kartou', 'online', 'poukaz'].includes(zpusob_platby)) {
    return res.status(400).json({ chyba: 'Vyberte prosím způsob platby.' });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [r] } = await client.query('SELECT * FROM rezervace WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!r) { await client.query('ROLLBACK'); return res.status(404).json({ chyba: 'Rezervace nebyla nalezena.' }); }

    const cena = Number(r.cena) || 0;
    const aktualniUhrazeno = Number(r.uhrazeno) || 0;

    if (druh === 'platba' && aktualniUhrazeno + castkaNum > cena) {
      await client.query('ROLLBACK');
      return res.status(400).json({ chyba: `Částka převyšuje zbývající dluh (zbývá ${cena - aktualniUhrazeno} Kč).` });
    }
    if (druh === 'vratka' && castkaNum > aktualniUhrazeno) {
      await client.query('ROLLBACK');
      return res.status(400).json({ chyba: `Nelze vrátit víc, než je uhrazeno (uhrazeno ${aktualniUhrazeno} Kč).` });
    }

    await client.query(
      `INSERT INTO platby (rezervace_id, castka, typ, zpusob_platby) VALUES ($1,$2,$3,$4)`,
      [req.params.id, druh === 'vratka' ? -castkaNum : castkaNum, druh, zpusob_platby]
    );
    const aktualizovana = await prepocitatSouhrnRezervace(client, req.params.id);
    await client.query('COMMIT');
    res.json({ ok: true, rezervace: aktualizovana });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).json({ chyba: e.message });
  } finally {
    client.release();
  }
});

// Historie jednotlivých plateb/vratek k rezervaci (jen pro čtení) — pro zobrazení
// v detailu rezervace v adminu.
app.get('/api/admin/rezervace/:id/platby', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM platby WHERE rezervace_id = $1 ORDER BY vytvoreno ASC, id ASC', [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.delete('/api/admin/rezervace/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM rezervace WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// -- Pracovní doba --
app.get('/api/admin/pracovni-doba', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM pracovni_doba ORDER BY den_v_tydnu');
    res.json(rows);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.put('/api/admin/pracovni-doba/:den', async (req, res) => {
  const { otevreno_od, otevreno_do, pauza_od, pauza_do, aktivni } = req.body || {};
  try {
    // otevreno_od/otevreno_do jsou v DB "not null" — u neaktivního dne (např. neděle)
    // se ale v adminu čas klidně nechává prázdný. Prázdnou hodnotu proto nezapisujeme
    // a necháme sloupci jeho dosavadní hodnotu, ať uložení nespadne na chybě databáze.
    await db.query(
      `UPDATE pracovni_doba SET
         otevreno_od = COALESCE(NULLIF($1,'')::time, otevreno_od),
         otevreno_do = COALESCE(NULLIF($2,'')::time, otevreno_do),
         pauza_od = $3, pauza_do = $4, aktivni = $5
       WHERE den_v_tydnu = $6`,
      [otevreno_od, otevreno_do, pauza_od || null, pauza_do || null, aktivni, req.params.den]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// -- Nastavení (klíč/hodnota) --
app.get('/api/admin/nastaveni', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM nastaveni');
    res.json(rows);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});
app.put('/api/admin/nastaveni/:klic', async (req, res) => {
  const { hodnota } = req.body || {};
  if (!hodnota) return res.status(400).json({ chyba: 'Chybí hodnota.' });
  try {
    await db.query(
      'INSERT INTO nastaveni (klic, hodnota) VALUES ($1,$2) ON CONFLICT (klic) DO UPDATE SET hodnota = $2',
      [req.params.klic, hodnota]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});
app.delete('/api/admin/nastaveni/:klic', async (req, res) => {
  try {
    await db.query('DELETE FROM nastaveni WHERE klic = $1', [req.params.klic]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// -- Provozní výjimky (dovolená, svátky) --
app.get('/api/admin/vyjimky', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM provozni_vyjimky ORDER BY datum_od DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});
// otevreno_od/otevreno_do jsou nepovinné — když se vyplní, výjimka pro daný den
// (dny) nastaví vlastní otevírací dobu místo běžného týdenního rozvrhu (např.
// jeden den v měsíci delší otevřeno). Bez nich je to jako dřív — celý den zavřeno.
app.post('/api/admin/vyjimky', async (req, res) => {
  const { datum_od, datum_do, popis, otevreno_od, otevreno_do } = req.body || {};
  if (!datum_od || !datum_do) return res.status(400).json({ chyba: 'Zadejte datum od a do.' });
  try {
    const { rows: [vyjimka] } = await db.query(
      'INSERT INTO provozni_vyjimky (datum_od, datum_do, popis, otevreno_od, otevreno_do) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [datum_od, datum_do, popis || null, otevreno_od || null, otevreno_do || null]
    );
    res.json({ ok: true, vyjimka });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});
app.put('/api/admin/vyjimky/:id', async (req, res) => {
  const { datum_od, datum_do, popis, otevreno_od, otevreno_do } = req.body || {};
  if (!datum_od || !datum_do) return res.status(400).json({ chyba: 'Zadejte datum od a do.' });
  try {
    const { rows: [vyjimka] } = await db.query(
      'UPDATE provozni_vyjimky SET datum_od = $1, datum_do = $2, popis = $3, otevreno_od = $4, otevreno_do = $5 WHERE id = $6 RETURNING *',
      [datum_od, datum_do, popis || null, otevreno_od || null, otevreno_do || null, req.params.id]
    );
    res.json({ ok: true, vyjimka });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});
app.delete('/api/admin/vyjimky/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM provozni_vyjimky WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// -- Varianty poukazů (částka + platnost) --
app.get('/api/admin/poukazy/typy', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM poukazy_typy ORDER BY poradi');
    res.json(rows);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.post('/api/admin/poukazy/typy', async (req, res) => {
  const { hodnota, platnost_mesicu, poradi } = req.body || {};
  if (!hodnota || !platnost_mesicu) return res.status(400).json({ chyba: 'Zadejte hodnotu a platnost v měsících.' });
  try {
    const { rows: [typ] } = await db.query(
      'INSERT INTO poukazy_typy (hodnota, platnost_mesicu, poradi) VALUES ($1,$2,$3) RETURNING *',
      [hodnota, platnost_mesicu, poradi || 0]
    );
    res.json({ ok: true, typ });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.put('/api/admin/poukazy/typy/:id', async (req, res) => {
  const { hodnota, platnost_mesicu } = req.body || {};
  try {
    await db.query('UPDATE poukazy_typy SET hodnota = $1, platnost_mesicu = $2 WHERE id = $3', [hodnota, platnost_mesicu, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.delete('/api/admin/poukazy/typy/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM poukazy_typy WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// -- Poukazy --
app.get('/api/admin/poukazy', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM poukazy ORDER BY vytvoreno DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Poukaz jde vydat buď na částku (poukaz_typ_id, z "Varianty poukazů"), nebo rovnou
// na konkrétní masáž (cenik_id) — pak se hodnota poukazu vezme přímo z ceníku,
// místo aby se vždycky vynucovala první/vybraná peněžní varianta.
app.post('/api/admin/poukazy', async (req, res) => {
  const { poukaz_typ_id, cenik_id, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, zakoupeno_kde } = req.body || {};
  if (!poukaz_typ_id && !cenik_id) return res.status(400).json({ chyba: 'Vyberte variantu poukazu nebo konkrétní masáž.' });
  try {
    let hodnota, platnostMesicu, konkretniMasaz = null;
    if (cenik_id) {
      const { rows: [polozka] } = await db.query('SELECT * FROM cenik WHERE id = $1', [cenik_id]);
      if (!polozka) return res.status(404).json({ chyba: 'Tato masáž nebyla v ceníku nalezena.' });
      hodnota = polozka.cena;
      platnostMesicu = 12;
      konkretniMasaz = polozka.skupina + ' – ' + polozka.varianta;
    } else {
      const { rows: [typ] } = await db.query('SELECT * FROM poukazy_typy WHERE id = $1', [poukaz_typ_id]);
      if (!typ) return res.status(404).json({ chyba: 'Tato varianta poukazu nebyla nalezena.' });
      hodnota = typ.hodnota;
      platnostMesicu = typ.platnost_mesicu;
    }
    const platnostDo = new Date();
    platnostDo.setMonth(platnostDo.getMonth() + platnostMesicu);
    const { rows: [poukaz] } = await db.query(
      `INSERT INTO poukazy (kod, ean, hodnota, zustatek, platnost_do, zakoupeno_kde, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, konkretni_masaz, stav)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'aktivni') RETURNING *`,
      [vygenerovatKod(), vygenerovatEan(), hodnota, hodnota, platnostDo.toISOString().slice(0, 10), zakoupeno_kde || 'osobne', kupujici_jmeno || null, kupujici_email || null, kupujici_telefon || null, pro_koho || null, konkretniMasaz]
    );
    res.json({ ok: true, poukaz });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.patch('/api/admin/poukazy/:id/stav', async (req, res) => {
  const { stav } = req.body || {};
  if (!['aktivni', 'castecne_vyuzity', 'pouzity', 'zruseny'].includes(stav)) return res.status(400).json({ chyba: 'Neplatný stav.' });
  try {
    await db.query('UPDATE poukazy SET stav = $1 WHERE id = $2', [stav, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Skutečné uplatnění poukazu (odečtení částky ze zůstatku) — jediné místo, kde se
// zůstatek opravdu mění. Běží v transakci se "SELECT ... FOR UPDATE", což zamkne
// řádek toho konkrétního poukazu, dokud transakce neskončí — kdyby přišly dva
// požadavky na uplatnění stejného poukazu skoro současně (např. dva panely admina
// otevřené najednou), druhý počká, až první dopíše, a pak už vidí správný, už
// snížený zůstatek. Stejný princip jako zámek proti dvojité rezervaci termínu,
// jen tady jde o zámek konkrétního řádku místo dne v kalendáři.
// Nepovinné rezervace_id: pokud se poukaz uplatňuje na konkrétní rezervaci,
// uplatněná částka se ve stejné transakci rovnou zapíše i jako řádek do deníku
// "platby" (typ='platba', zpusob_platby='poukaz', poukaz_id=tenhle poukaz) a
// souhrn rezervace se přepočte — takže propojení rezervace↔poukaz zůstává
// zachované a obě strany (poukaz i rezervace) se buď zapíšou obě, nebo ani jedna.
app.post('/api/admin/poukazy/:id/uplatnit', async (req, res) => {
  const castka = Number(req.body && req.body.castka);
  const rezervaceId = req.body && req.body.rezervace_id ? Number(req.body.rezervace_id) : null;
  if (!Number.isFinite(castka) || castka <= 0) {
    return res.status(400).json({ chyba: 'Zadejte prosím kladnou částku k uplatnění.' });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [poukaz] } = await client.query('SELECT * FROM poukazy WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!poukaz) { await client.query('ROLLBACK'); return res.status(404).json({ chyba: 'Poukaz nebyl nalezen.' }); }
    if (poukaz.stav === 'zruseny') { await client.query('ROLLBACK'); return res.status(400).json({ chyba: 'Poukaz je zrušený, nelze ho uplatnit.' }); }
    if (poukaz.stav === 'pouzity' || Number(poukaz.zustatek) <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ chyba: 'Poukaz je už plně vyčerpaný.' });
    }
    const dnesIso = new Date().toISOString().slice(0, 10);
    if (poukaz.platnost_do < dnesIso) {
      await client.query('ROLLBACK');
      return res.status(400).json({ chyba: `Poukaz je prošlý (platnost do ${formatDatumCz(poukaz.platnost_do)}).` });
    }
    if (castka > Number(poukaz.zustatek)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ chyba: `Částka převyšuje zůstatek na poukazu (${poukaz.zustatek} Kč).` });
    }

    let aktualizovanaRezervace = null;
    if (rezervaceId) {
      const { rows: [r] } = await client.query('SELECT * FROM rezervace WHERE id = $1 FOR UPDATE', [rezervaceId]);
      if (!r) { await client.query('ROLLBACK'); return res.status(404).json({ chyba: 'Rezervace k propojení nebyla nalezena.' }); }
      const cena = Number(r.cena) || 0;
      const aktualniUhrazeno = Number(r.uhrazeno) || 0;
      if (aktualniUhrazeno + castka > cena) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: `Částka převyšuje zbývající dluh na rezervaci (zbývá ${cena - aktualniUhrazeno} Kč).` });
      }
      await client.query(
        `INSERT INTO platby (rezervace_id, castka, typ, zpusob_platby, poukaz_id) VALUES ($1,$2,'platba','poukaz',$3)`,
        [rezervaceId, castka, req.params.id]
      );
      aktualizovanaRezervace = await prepocitatSouhrnRezervace(client, rezervaceId);
    }

    const novyZustatek = Number(poukaz.zustatek) - castka;
    const novyStav = novyZustatek <= 0 ? 'pouzity' : 'castecne_vyuzity';
    const { rows: [aktualizovany] } = await client.query(
      'UPDATE poukazy SET zustatek = $1, stav = $2 WHERE id = $3 RETURNING *',
      [novyZustatek, novyStav, req.params.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true, poukaz: aktualizovany, rezervace: aktualizovanaRezervace });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).json({ chyba: e.message });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/poukazy/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM poukazy WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// -- Žádosti o poukaz --
app.get('/api/admin/poukazy/zadosti', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM poukazy_zadosti ORDER BY vytvoreno DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Schválení žádosti → automaticky vytvoří aktivní poukaz
app.patch('/api/admin/poukazy/zadosti/:id/stav', async (req, res) => {
  const { stav } = req.body || {};
  if (!['nova', 'vyrizena', 'zamitnuta'].includes(stav)) return res.status(400).json({ chyba: 'Neplatný stav.' });
  try {
    const { rows: [zadost] } = await db.query('SELECT * FROM poukazy_zadosti WHERE id = $1', [req.params.id]);
    if (!zadost) return res.status(404).json({ chyba: 'Žádost nenalezena.' });

    await db.query('UPDATE poukazy_zadosti SET stav = $1 WHERE id = $2', [stav, req.params.id]);

    if (stav === 'vyrizena') {
      const platnostDo = new Date();
      platnostDo.setFullYear(platnostDo.getFullYear() + 1);
      const { rows: [poukaz] } = await db.query(
        `INSERT INTO poukazy (kod, ean, hodnota, zustatek, platnost_do, zakoupeno_kde, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, konkretni_masaz, zpusob_platby, stav)
         VALUES ($1,$2,$3,$4,$5,'web',$6,$7,$8,$9,$10,$11,'aktivni') RETURNING *`,
        [vygenerovatKod(), vygenerovatEan(), zadost.hodnota, zadost.hodnota, platnostDo.toISOString().slice(0, 10), zadost.kupujici_jmeno, zadost.kupujici_email, zadost.kupujici_telefon, zadost.pro_koho, zadost.konkretni_masaz, zadost.zpusob_platby]
      );
      return res.json({ ok: true, poukaz });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.delete('/api/admin/poukazy/zadosti/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM poukazy_zadosti WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// -- Zákazníci (ručně přidané + odvozené z rezervací a poukazů, seskupeno podle telefonu) --
app.get('/api/admin/zakaznici', async (req, res) => {
  try {
    const [rez, pouk, zak] = await Promise.all([
      db.query('SELECT jmeno, telefon, email, datum, cena, stav FROM rezervace'),
      db.query('SELECT kupujici_jmeno, kupujici_telefon, kupujici_email, hodnota, stav FROM poukazy'),
      db.query('SELECT telefon, jmeno, email, poznamka, alergie, preference FROM zakaznici')
    ]);

    const rucne = {};
    zak.rows.forEach(z => { rucne[z.telefon] = z; });

    const zakaznici = {};
    function najit(telefon) {
      const klic = (telefon || '').trim();
      if (!klic) return null;
      if (!zakaznici[klic]) {
        const r = rucne[klic];
        zakaznici[klic] = {
          telefon: klic, jmeno: r?.jmeno || null, email: r?.email || null,
          pocetNavstev: 0, celkemUtraceno: 0, posledniNavstiva: null,
          aktivniPoukazy: 0, poznamka: r?.poznamka || '',
          alergie: r?.alergie || '', preference: r?.preference || ''
        };
      }
      return zakaznici[klic];
    }

    zak.rows.forEach(z => najit(z.telefon));

    rez.rows.forEach(r => {
      const z = najit(r.telefon);
      if (!z) return;
      if (r.jmeno) z.jmeno = r.jmeno;
      if (r.email) z.email = r.email;
      if (!['zrusena', 'nedostavila_se'].includes(r.stav)) {
        z.pocetNavstev++;
        z.celkemUtraceno += Number(r.cena) || 0;
        if (!z.posledniNavstiva || r.datum > z.posledniNavstiva) z.posledniNavstiva = r.datum;
      }
    });
    pouk.rows.forEach(p => {
      const z = najit(p.kupujici_telefon);
      if (!z) return;
      if (p.kupujici_jmeno && !z.jmeno) z.jmeno = p.kupujici_jmeno;
      if (p.kupujici_email && !z.email) z.email = p.kupujici_email;
      z.celkemUtraceno += Number(p.hodnota) || 0;
      if (p.stav === 'aktivni') z.aktivniPoukazy++;
    });

    const seznam = Object.values(zakaznici).sort((a, b) => {
      if (!a.posledniNavstiva) return 1;
      if (!b.posledniNavstiva) return -1;
      return b.posledniNavstiva.localeCompare(a.posledniNavstiva);
    });
    res.json(seznam);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.put('/api/admin/zakaznici/poznamka', async (req, res) => {
  const { telefon, poznamka, alergie, preference } = req.body || {};
  if (!telefon) return res.status(400).json({ chyba: 'Chybí telefon.' });
  try {
    await db.query(
      `INSERT INTO zakaznici (telefon, poznamka, alergie, preference, upraveno) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (telefon) DO UPDATE SET poznamka = $2, alergie = $3, preference = $4, upraveno = now()`,
      [telefon.trim(), poznamka || null, alergie || null, preference || null]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Ruční přidání zákaznice bez rezervace (nebo doplnění jména/e-mailu k existující)
app.post('/api/admin/zakaznici', async (req, res) => {
  const { telefon, jmeno, email, poznamka, alergie, preference } = req.body || {};
  if (!telefon) return res.status(400).json({ chyba: 'Chybí telefon.' });
  try {
    const { rows: [zakaznice] } = await db.query(
      `INSERT INTO zakaznici (telefon, jmeno, email, poznamka, alergie, preference, upraveno) VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (telefon) DO UPDATE SET
         jmeno = COALESCE($2, zakaznici.jmeno),
         email = COALESCE($3, zakaznici.email),
         poznamka = COALESCE($4, zakaznici.poznamka),
         alergie = COALESCE($5, zakaznici.alergie),
         preference = COALESCE($6, zakaznici.preference),
         upraveno = now()
       RETURNING *`,
      [telefon.trim(), jmeno || null, email || null, poznamka || null, alergie || null, preference || null]
    );
    res.json({ ok: true, zakaznice });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.delete('/api/admin/zakaznici/:telefon', async (req, res) => {
  try {
    await db.query('DELETE FROM zakaznici WHERE telefon = $1', [req.params.telefon]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// -- Newsletter --
app.get('/api/admin/newsletter', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, email, jmeno, aktivni, vytvoreno FROM newsletter_odberatele ORDER BY vytvoreno DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.delete('/api/admin/newsletter/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM newsletter_odberatele WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.get('/api/admin/newsletter/historie', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM newsletter_zpravy ORDER BY odeslano DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Odešle newsletter všem aktivním odběratelkám přes Resend (RESEND_API_KEY v env)
app.post('/api/admin/newsletter/odeslat', async (req, res) => {
  const { predmet, obsah } = req.body || {};
  if (!predmet || !obsah) return res.status(400).json({ chyba: 'Vyplňte prosím předmět a obsah.' });
  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ chyba: 'Rozesílání e-mailů zatím není nastavené (na Renderu chybí RESEND_API_KEY).' });
  }
  try {
    const { rows: odberatele } = await db.query(
      'SELECT email, odhlasovaci_token FROM newsletter_odberatele WHERE aktivni = true'
    );
    if (!odberatele.length) return res.status(400).json({ chyba: 'Nejsou žádné aktivní odběratelky.' });

    let odeslano = 0;
    for (const o of odberatele) {
      const odhlasitUrl = `${API_URL}/api/newsletter/odhlasit?token=${o.odhlasovaci_token}`;
      const html = emailSablona(`${obsah}
        <p style="font-size:12px;color:#999;margin-top:30px;border-top:1px solid #f0ece6;padding-top:15px;">
          Nechcete už tyto e-maily dostávat? <a href="${odhlasitUrl}" style="color:#bfa14f;">Odhlásit se z newsletteru</a>
        </p>`);
      if (await odeslatEmail(o.email, predmet, html)) odeslano++;
    }

    await db.query(
      'INSERT INTO newsletter_zpravy (predmet, obsah, pocet_prijemcu) VALUES ($1,$2,$3)',
      [predmet, obsah, odeslano]
    );
    res.json({ ok: true, odeslano, celkem: odberatele.length });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// -- Ceník --
app.get('/api/admin/cenik', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM cenik ORDER BY poradi_skupiny, poradi_varianty');
    res.json(rows);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.post('/api/admin/cenik', async (req, res) => {
  const { skupina, emoji, varianta, delka_min, cena, rezervovatelna, poradi_skupiny, poradi_varianty } = req.body || {};
  if (!skupina || !varianta || !delka_min || cena === undefined) return res.status(400).json({ chyba: 'Vyplňte název masáže, variantu, délku a cenu.' });
  try {
    const { rows: [polozka] } = await db.query(
      `INSERT INTO cenik (skupina, emoji, varianta, delka_min, cena, rezervovatelna, poradi_skupiny, poradi_varianty)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [skupina, emoji || '💆', varianta, delka_min, cena, rezervovatelna !== false, poradi_skupiny || 0, poradi_varianty || 0]
    );
    res.json({ ok: true, polozka });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.put('/api/admin/cenik/:id', async (req, res) => {
  const { skupina, emoji, varianta, delka_min, cena, rezervovatelna } = req.body || {};
  try {
    await db.query(
      'UPDATE cenik SET skupina = $1, emoji = $2, varianta = $3, delka_min = $4, cena = $5, rezervovatelna = $6 WHERE id = $7',
      [skupina, emoji, varianta, delka_min, cena, rezervovatelna, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.delete('/api/admin/cenik/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM cenik WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// -- Prodejna (masáže prodané osobně na místě) --
app.get('/api/admin/prodejna', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM prodeje ORDER BY vytvoreno DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.post('/api/admin/prodejna', async (req, res) => {
  const { masaz, cena, zpusob_platby, poznamka } = req.body || {};
  if (!masaz || !cena) return res.status(400).json({ chyba: 'Vyberte masáž a zadejte cenu.' });
  try {
    const { rows: [prodej] } = await db.query(
      'INSERT INTO prodeje (masaz, cena, zpusob_platby, poznamka) VALUES ($1,$2,$3,$4) RETURNING *',
      [masaz, cena, zpusob_platby || 'hotove', poznamka || null]
    );
    res.json({ ok: true, prodej });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.delete('/api/admin/prodejna/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM prodeje WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// -- Účetnictví (Fáze 3B): 4 oddělené přehledy, ať jedno číslo nemusí
// představovat čtyři různé věci najednou.
//
// A) TRŽBY ZA SLUŽBY — hodnota uskutečněné/objednané služby podle DATA MASÁŽE
//    (rezervace.datum), bez ohledu na to, kdy/jestli už je zaplacená. Prodejna
//    (walk-in prodej) sem patří taky, tam ale datum vytvoření = datum služby
//    (platí se na místě hned), takže žádný rozdíl není.
// B) PŘIJATÉ PLATBY — skutečný pohyb peněz podle deníku "platby" (+prodejna).
//    Platby se zpusob_platby='poukaz' se sem NEPOČÍTAJÍ — ty peníze už byly
//    jednou započítané v okamžiku PRODEJE poukazu (viz C), takže by se jinak
//    počítaly dvakrát. Vratky (záporné částky) se přirozeně odečtou.
// C) PRODEJ POUKAZŮ — kdy a kolik se prodalo dárkových poukazů (podle
//    poukazy.vytvoreno = okamžik prodeje/platby za poukaz).
// D) VRATKY — přehled všech vrácení peněz z deníku "platby" (typ='vratka'),
//    bez ohledu na to, jestli šlo o platbu hotově/kartou/poukazem.
//
// Nepovinné query parametry ?od=YYYY-MM-DD&do=YYYY-MM-DD omezí období (podle
// data té které položky — masáže, platby, nebo prodeje poukazu).
app.get('/api/admin/ucetnictvi', async (req, res) => {
  try {
    const { od, do: doParam } = req.query;
    const vObdobi = iso => (!od || iso >= od) && (!doParam || iso <= doParam);
    const seskupitPodleDne = (radky, castka, datum) => {
      const mapa = {};
      radky.forEach(r => { const d = datum(r); mapa[d] = (mapa[d] || 0) + castka(r); });
      return Object.entries(mapa).sort((a, b) => b[0].localeCompare(a[0])).map(([den, c]) => ({ den, castka: c }));
    };

    const [rez, prod, pouk, plat] = await Promise.all([
      db.query("SELECT cena, datum FROM rezervace WHERE stav IN ('potvrzena', 'dokoncena')"),
      db.query('SELECT cena, vytvoreno FROM prodeje'),
      db.query('SELECT id, hodnota, vytvoreno FROM poukazy'),
      db.query('SELECT id, rezervace_id, castka, typ, zpusob_platby, vytvoreno FROM platby')
    ]);

    const prodejnaPolozky = prod.rows.map(p => ({ castka: Number(p.cena) || 0, datum: p.vytvoreno.toISOString().slice(0, 10) }));

    // A) Tržby za služby (rezervace podle data masáže + prodejna podle data prodeje)
    const trzbyPolozky = [
      ...rez.rows.filter(r => vObdobi(r.datum)).map(r => ({ castka: Number(r.cena) || 0, datum: r.datum })),
      ...prodejnaPolozky.filter(p => vObdobi(p.datum))
    ];

    // B) Přijaté platby — deník bez poukazových řádků (ty patří do C) + prodejna
    const platbyFiltr = plat.rows
      .map(p => ({ ...p, den: p.vytvoreno.toISOString().slice(0, 10) }))
      .filter(p => vObdobi(p.den));
    const prijatePlatbyPolozky = [
      ...platbyFiltr.filter(p => p.zpusob_platby !== 'poukaz').map(p => ({ castka: Number(p.castka), datum: p.den })),
      ...prodejnaPolozky.filter(p => vObdobi(p.datum))
    ];

    // C) Prodej poukazů
    const poukazyFiltr = pouk.rows
      .map(p => ({ ...p, den: p.vytvoreno.toISOString().slice(0, 10) }))
      .filter(p => vObdobi(p.den));

    // D) Vratky
    const vratkyFiltr = platbyFiltr.filter(p => p.typ === 'vratka');

    res.json({
      obdobi: { od: od || null, do: doParam || null },
      trzbyZaSluzby: {
        celkem: trzbyPolozky.reduce((s, p) => s + p.castka, 0),
        podleDne: seskupitPodleDne(trzbyPolozky, p => p.castka, p => p.datum)
      },
      prijatePlatby: {
        celkem: prijatePlatbyPolozky.reduce((s, p) => s + p.castka, 0),
        podleDne: seskupitPodleDne(prijatePlatbyPolozky, p => p.castka, p => p.datum),
        // I seznam jednotlivých položek musí vynechat zpusob_platby='poukaz' —
        // jinak by se ta samá platba objevila v přehledu, i když do součtu výš
        // (celkem/podleDne) správně nevstupuje. Peníze z poukazu jsou vidět
        // zvlášť v prodejPoukazu (v den PRODEJE poukazu, ne uplatnění).
        seznam: platbyFiltr.filter(p => p.zpusob_platby !== 'poukaz').map(p => ({
          id: p.id, rezervace_id: p.rezervace_id, castka: Number(p.castka), typ: p.typ,
          zpusob_platby: p.zpusob_platby, vytvoreno: p.vytvoreno.toISOString()
        }))
      },
      prodejPoukazu: {
        celkem: poukazyFiltr.reduce((s, p) => s + Number(p.hodnota), 0),
        pocet: poukazyFiltr.length,
        podleDne: seskupitPodleDne(poukazyFiltr, p => Number(p.hodnota), p => p.den)
      },
      vratky: {
        celkem: vratkyFiltr.reduce((s, p) => s + Math.abs(Number(p.castka)), 0),
        pocet: vratkyFiltr.length,
        seznam: vratkyFiltr.map(p => ({
          id: p.id, rezervace_id: p.rezervace_id, castka: Number(p.castka),
          zpusob_platby: p.zpusob_platby, vytvoreno: p.vytvoreno.toISOString()
        }))
      }
    });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Denní úloha spouštěná zvenčí (cron-job.org apod.) přes tajný klíč v URL:
// GET /api/cron/denni?klic=...
// 1) pošle připomínku zítřejších rezervací (jednou, hlídá se přes pripomenuto)
// 2) pošle žádost o recenzi za včerejší rezervace (jednou, hlídá se přes pozadano_recenze)
app.get('/api/cron/denni', async (req, res) => {
  if (!CRON_KLIC || req.query.klic !== CRON_KLIC) {
    return res.status(401).json({ chyba: 'Neplatný klíč.' });
  }
  try {
    const zitra = new Date(); zitra.setDate(zitra.getDate() + 1);
    const zitraIso = zitra.toISOString().slice(0, 10);
    const vcera = new Date(); vcera.setDate(vcera.getDate() - 1);
    const vceraIso = vcera.toISOString().slice(0, 10);

    let pripomenutoPocet = 0;
    const { rows: zitrejsi } = await db.query(
      `SELECT * FROM rezervace WHERE datum = $1 AND stav IN ('cekajici','potvrzena') AND pripomenuto = false AND email IS NOT NULL`,
      [zitraIso]
    );
    for (const r of zitrejsi) {
      const odeslano = await odeslatEmail(r.email, 'Připomínka rezervace zítra – Masáže Alesa', pripomenkaEmailHtml(r));
      if (odeslano) {
        await db.query('UPDATE rezervace SET pripomenuto = true WHERE id = $1', [r.id]);
        pripomenutoPocet++;
      }
    }

    let recenzePocet = 0;
    const { rows: vcerejsi } = await db.query(
      `SELECT * FROM rezervace WHERE datum = $1 AND stav IN ('potvrzena','dokoncena') AND pozadano_recenze = false AND email IS NOT NULL`,
      [vceraIso]
    );
    for (const r of vcerejsi) {
      const odeslano = await odeslatEmail(r.email, 'Jak jste byla spokojená? – Masáže Alesa', recenzeEmailHtml(r));
      if (odeslano) {
        await db.query('UPDATE rezervace SET pozadano_recenze = true WHERE id = $1', [r.id]);
        recenzePocet++;
      }
    }

    res.json({ ok: true, pripomenutoOdeslano: pripomenutoPocet, zCelkem: zitrejsi.length, recenzeOdeslano: recenzePocet, zCelkemVcera: vcerejsi.length });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.get('/', (req, res) => res.send('Masáže Alesa API běží 🌸'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server běží na portu ' + PORT));
