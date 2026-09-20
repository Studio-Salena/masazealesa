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
const MEZERA_MIN = 30; // mezera mezi masážemi v minutách

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

// Spočte pro daný den seznam kandidátních časů (po 15 min) s příznakem volno/obsazeno,
// bez jakýchkoliv osobních údajů — jen čas.
async function spocitatTerminyDne(datum, delka, pd) {
  if (!pd || !pd.aktivni) return [];
  const { rows: existujici } = await db.query(
    "SELECT cas_od, cas_do FROM rezervace WHERE datum = $1 AND stav <> 'zrusena'", [datum]
  );
  // Obsazené intervaly rozšířené o mezeru na obě strany
  const obsazeno = existujici.map(r => ({
    od: casNaMinuty(r.cas_od) - MEZERA_MIN,
    do: casNaMinuty(r.cas_do) + MEZERA_MIN
  }));
  const otevrenoOd = casNaMinuty(pd.otevreno_od);
  const otevrenoDo = casNaMinuty(pd.otevreno_do);
  const KROK = 15; // kandidátní časy po 15 minutách
  const terminy = [];
  for (let start = otevrenoOd; start + delka <= otevrenoDo; start += KROK) {
    const konec = start + delka;
    const koliduje = obsazeno.some(o => start < o.do && konec > o.od);
    terminy.push({ cas: minutyNaCas(start), volno: !koliduje });
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

    const denVTydnu = new Date(datum + 'T12:00:00').getDay();
    const { rows: [pd] } = await db.query('SELECT * FROM pracovni_doba WHERE den_v_tydnu = $1', [denVTydnu]);
    res.json(await spocitatTerminyDne(datum, polozkaCeniku.delka_min, pd));
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

    const { rows: pracovniDoba } = await db.query('SELECT * FROM pracovni_doba');
    const pdPodleDne = {};
    pracovniDoba.forEach(pd => { pdPodleDne[pd.den_v_tydnu] = pd; });

    const dny = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(zacatek + 'T12:00:00');
      d.setDate(d.getDate() + i);
      const datum = d.toISOString().slice(0, 10);
      const terminy = await spocitatTerminyDne(datum, polozkaCeniku.delka_min, pdPodleDne[d.getDay()]);
      dny.push({ datum, terminy });
    }
    res.json(dny);
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Vytvoření rezervace klientkou
app.post('/api/rezervace', async (req, res) => {
  const { datum, cas_od, jmeno, telefon, email, cenik_id, poznamka } = req.body || {};
  if (!datum || !cas_od || !jmeno || !telefon || !cenik_id) {
    return res.status(400).json({ chyba: 'Vyplňte prosím jméno, telefon, masáž, datum a čas.' });
  }
  try {
    const { rows: [polozkaCeniku] } = await db.query('SELECT * FROM cenik WHERE id = $1', [cenik_id]);
    if (!polozkaCeniku) return res.status(404).json({ chyba: 'Tato masáž nebyla v ceníku nalezena.' });
    if (!polozkaCeniku.rezervovatelna) return res.status(400).json({ chyba: 'Na tuto položku nelze rezervovat online.' });

    const zacatek = casNaMinuty(cas_od);
    const konec = zacatek + polozkaCeniku.delka_min;
    const cas_do = minutyNaCas(konec);
    const nazevMasaze = polozkaCeniku.skupina + ' – ' + polozkaCeniku.varianta;

    // Znovu ověřit kolizi (ochrana proti dvěma klientkám, co kliknou zároveň)
    const { rows: existujici } = await db.query(
      "SELECT cas_od, cas_do FROM rezervace WHERE datum = $1 AND stav <> 'zrusena'", [datum]
    );
    const koliduje = existujici.some(r => {
      const oOd = casNaMinuty(r.cas_od) - MEZERA_MIN, oDo = casNaMinuty(r.cas_do) + MEZERA_MIN;
      return zacatek < oDo && konec > oOd;
    });
    if (koliduje) return res.status(409).json({ chyba: 'Tento termín je již obsazený (nebo příliš blízko jiné rezervaci), vyberte prosím jiný.' });

    const { rows: [rezervace] } = await db.query(
      `INSERT INTO rezervace (cenik_id, datum, cas_od, cas_do, jmeno, telefon, email, masaz, poznamka, stav, cena)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'cekajici',$10) RETURNING *`,
      [cenik_id, datum, cas_od, cas_do, jmeno, telefon, email || null, nazevMasaze, poznamka || null, polozkaCeniku.cena]
    );
    res.json({ ok: true, rezervace });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
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

app.patch('/api/admin/rezervace/:id/stav', async (req, res) => {
  const { stav } = req.body || {};
  if (!['cekajici', 'potvrzena', 'zrusena'].includes(stav)) {
    return res.status(400).json({ chyba: 'Neplatný stav.' });
  }
  try {
    await db.query('UPDATE rezervace SET stav = $1 WHERE id = $2', [stav, req.params.id]);
    res.json({ ok: true });
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
  const { otevreno_od, otevreno_do, aktivni } = req.body || {};
  try {
    await db.query(
      'UPDATE pracovni_doba SET otevreno_od = $1, otevreno_do = $2, aktivni = $3 WHERE den_v_tydnu = $4',
      [otevreno_od, otevreno_do, aktivni, req.params.den]
    );
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

app.post('/api/admin/poukazy', async (req, res) => {
  const { poukaz_typ_id, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, zakoupeno_kde, konkretni_masaz } = req.body || {};
  if (!poukaz_typ_id) return res.status(400).json({ chyba: 'Vyberte variantu poukazu.' });
  try {
    const { rows: [typ] } = await db.query('SELECT * FROM poukazy_typy WHERE id = $1', [poukaz_typ_id]);
    if (!typ) return res.status(404).json({ chyba: 'Tato varianta poukazu nebyla nalezena.' });
    const platnostDo = new Date();
    platnostDo.setMonth(platnostDo.getMonth() + typ.platnost_mesicu);
    const { rows: [poukaz] } = await db.query(
      `INSERT INTO poukazy (kod, ean, hodnota, zustatek, platnost_do, zakoupeno_kde, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, konkretni_masaz, stav)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'aktivni') RETURNING *`,
      [vygenerovatKod(), vygenerovatEan(), typ.hodnota, typ.hodnota, platnostDo.toISOString().slice(0, 10), zakoupeno_kde || 'osobne', kupujici_jmeno || null, kupujici_email || null, kupujici_telefon || null, pro_koho || null, konkretni_masaz || null]
    );
    res.json({ ok: true, poukaz });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.patch('/api/admin/poukazy/:id/stav', async (req, res) => {
  const { stav } = req.body || {};
  if (!['aktivni', 'pouzity', 'zruseny'].includes(stav)) return res.status(400).json({ chyba: 'Neplatný stav.' });
  try {
    await db.query('UPDATE poukazy SET stav = $1 WHERE id = $2', [stav, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
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
      db.query('SELECT telefon, jmeno, email, poznamka FROM zakaznici')
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
          aktivniPoukazy: 0, poznamka: r?.poznamka || ''
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
      if (r.stav !== 'zrusena') {
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
  const { telefon, poznamka } = req.body || {};
  if (!telefon) return res.status(400).json({ chyba: 'Chybí telefon.' });
  try {
    await db.query(
      `INSERT INTO zakaznici (telefon, poznamka, upraveno) VALUES ($1, $2, now())
       ON CONFLICT (telefon) DO UPDATE SET poznamka = $2, upraveno = now()`,
      [telefon.trim(), poznamka || null]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

// Ruční přidání zákaznice bez rezervace (nebo doplnění jména/e-mailu k existující)
app.post('/api/admin/zakaznici', async (req, res) => {
  const { telefon, jmeno, email, poznamka } = req.body || {};
  if (!telefon) return res.status(400).json({ chyba: 'Chybí telefon.' });
  try {
    const { rows: [zakaznice] } = await db.query(
      `INSERT INTO zakaznici (telefon, jmeno, email, poznamka, upraveno) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (telefon) DO UPDATE SET
         jmeno = COALESCE($2, zakaznici.jmeno),
         email = COALESCE($3, zakaznici.email),
         poznamka = COALESCE($4, zakaznici.poznamka),
         upraveno = now()
       RETURNING *`,
      [telefon.trim(), jmeno || null, email || null, poznamka || null]
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

    const from = process.env.RESEND_FROM || 'Masáže Alesa <onboarding@resend.dev>';
    let odeslano = 0;
    for (const o of odberatele) {
      const odhlasitUrl = `${API_URL}/api/newsletter/odhlasit?token=${o.odhlasovaci_token}`;
      const html = `${obsah}<hr style="margin-top:30px;border:none;border-top:1px solid #ddd">
        <p style="font-size:12px;color:#999">Nechcete už tyto e-maily dostávat?
        <a href="${odhlasitUrl}">Odhlásit se z newsletteru</a></p>`;
      try {
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: o.email, subject: predmet, html })
        });
        if (resp.ok) odeslano++;
      } catch { /* jednotlivé selhání nepřeruší zbytek rozesílání */ }
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

// -- Účetnictví: souhrn tržeb z rezervací, prodejny na místě a poukazů --
app.get('/api/admin/ucetnictvi', async (req, res) => {
  try {
    const [rez, prod, pouk] = await Promise.all([
      db.query("SELECT cena, vytvoreno FROM rezervace WHERE stav = 'potvrzena'"),
      db.query('SELECT cena, vytvoreno FROM prodeje'),
      db.query('SELECT hodnota, vytvoreno FROM poukazy')
    ]);

    const polozky = [
      ...rez.rows.map(r => ({ zdroj: 'rezervace', castka: Number(r.cena) || 0, datum: r.vytvoreno.toISOString() })),
      ...prod.rows.map(p => ({ zdroj: 'prodejna', castka: Number(p.cena) || 0, datum: p.vytvoreno.toISOString() })),
      ...pouk.rows.map(p => ({ zdroj: 'poukaz', castka: Number(p.hodnota) || 0, datum: p.vytvoreno.toISOString() }))
    ];

    const trzbyCelkem = polozky.reduce((s, p) => s + p.castka, 0);
    const dnes = new Date().toISOString().slice(0, 10);
    const trzbyDnes = polozky.filter(p => p.datum.slice(0, 10) === dnes).reduce((s, p) => s + p.castka, 0);

    const poMesicich = {};
    const poDnech = {};
    polozky.forEach(p => {
      const mesic = p.datum.slice(0, 7); // YYYY-MM
      const den = p.datum.slice(0, 10); // YYYY-MM-DD
      poMesicich[mesic] = (poMesicich[mesic] || 0) + p.castka;
      poDnech[den] = (poDnech[den] || 0) + p.castka;
    });
    const mesicniPrehled = Object.entries(poMesicich).sort((a, b) => b[0].localeCompare(a[0])).map(([mesic, castka]) => ({ mesic, castka }));
    const denniPrehled = Object.entries(poDnech).sort((a, b) => b[0].localeCompare(a[0])).map(([den, castka]) => ({ den, castka }));

    res.json({
      trzbyCelkem, trzbyDnes,
      pocetPolozek: polozky.length,
      prumernaPolozka: polozky.length ? trzbyCelkem / polozky.length : 0,
      mesicniPrehled,
      denniPrehled,
      polozky: polozky.sort((a, b) => b.datum.localeCompare(a.datum))
    });
  } catch (e) { res.status(500).json({ chyba: e.message }); }
});

app.get('/', (req, res) => res.send('Masáže Alesa API běží 🌸'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server běží na portu ' + PORT));
