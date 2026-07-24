// ══════════════════════════════════════════════════════════
// Masáže Alesa — backend API
// Veřejné endpointy: ceník, volné termíny, vytvoření rezervace, žádost o poukaz
// Admin endpointy (chráněné heslem): správa rezervací, termínů, poukazů, ceníku
// ══════════════════════════════════════════════════════════
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
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
  const { data, error } = await supabase.from('cenik').select('*').order('poradi_skupiny').order('poradi_varianty');
  if (error) return res.status(500).json({ chyba: error.message });
  res.json(data);
});

// Volné termíny pro konkrétní datum a položku ceníku (počítá se dynamicky)
app.get('/api/rezervace/volne-terminy', async (req, res) => {
  const { datum, cenik_id } = req.query;
  if (!datum || !cenik_id) return res.status(400).json({ chyba: 'Zadejte datum a masáž.' });

  const { data: polozkaCeniku } = await supabase.from('cenik').select('*').eq('id', cenik_id).maybeSingle();
  if (!polozkaCeniku) return res.status(404).json({ chyba: 'Tato masáž nebyla v ceníku nalezena.' });
  if (!polozkaCeniku.rezervovatelna) return res.status(400).json({ chyba: 'Na tuto položku nelze rezervovat online.' });
  const delka = polozkaCeniku.delka_min;

  const denVTydnu = new Date(datum + 'T12:00:00').getDay();
  const { data: pd } = await supabase.from('pracovni_doba').select('*').eq('den_v_tydnu', denVTydnu).single();
  if (!pd || !pd.aktivni) return res.json([]);

  const { data: existujici } = await supabase
    .from('rezervace').select('cas_od, cas_do')
    .eq('datum', datum).neq('stav', 'zrusena');

  // Obsazené intervaly rozšířené o mezeru na obě strany
  const obsazeno = (existujici || []).map(r => ({
    od: casNaMinuty(r.cas_od) - MEZERA_MIN,
    do: casNaMinuty(r.cas_do) + MEZERA_MIN
  }));

  const otevrenoOd = casNaMinuty(pd.otevreno_od);
  const otevrenoDo = casNaMinuty(pd.otevreno_do);
  const KROK = 15; // kandidátní časy po 15 minutách

  const volne = [];
  for (let start = otevrenoOd; start + delka <= otevrenoDo; start += KROK) {
    const konec = start + delka;
    const koliduje = obsazeno.some(o => start < o.do && konec > o.od);
    if (!koliduje) volne.push(minutyNaCas(start));
  }
  res.json(volne);
});

// Vytvoření rezervace klientkou
app.post('/api/rezervace', async (req, res) => {
  const { datum, cas_od, jmeno, telefon, email, cenik_id, poznamka } = req.body || {};
  if (!datum || !cas_od || !jmeno || !telefon || !cenik_id) {
    return res.status(400).json({ chyba: 'Vyplňte prosím jméno, telefon, masáž, datum a čas.' });
  }
  const { data: polozkaCeniku } = await supabase.from('cenik').select('*').eq('id', cenik_id).maybeSingle();
  if (!polozkaCeniku) return res.status(404).json({ chyba: 'Tato masáž nebyla v ceníku nalezena.' });
  if (!polozkaCeniku.rezervovatelna) return res.status(400).json({ chyba: 'Na tuto položku nelze rezervovat online.' });

  const zacatek = casNaMinuty(cas_od);
  const konec = zacatek + polozkaCeniku.delka_min;
  const cas_do = minutyNaCas(konec);
  const nazevMasaze = polozkaCeniku.skupina + ' – ' + polozkaCeniku.varianta;

  // Znovu ověřit kolizi (ochrana proti dvěma klientkám, co kliknou zároveň)
  const { data: existujici } = await supabase
    .from('rezervace').select('cas_od, cas_do')
    .eq('datum', datum).neq('stav', 'zrusena');
  const koliduje = (existujici || []).some(r => {
    const oOd = casNaMinuty(r.cas_od) - MEZERA_MIN, oDo = casNaMinuty(r.cas_do) + MEZERA_MIN;
    return zacatek < oDo && konec > oOd;
  });
  if (koliduje) return res.status(409).json({ chyba: 'Tento termín je již obsazený (nebo příliš blízko jiné rezervaci), vyberte prosím jiný.' });

  const { data, error } = await supabase.from('rezervace').insert({
    cenik_id, datum, cas_od, cas_do, jmeno, telefon, email, masaz: nazevMasaze, poznamka, stav: 'cekajici', cena: polozkaCeniku.cena
  }).select().single();
  if (error) return res.status(500).json({ chyba: error.message });
  res.json({ ok: true, rezervace: data });
});

// Žádost o dárkový poukaz z webového formuláře
app.post('/api/poukazy/zadost', async (req, res) => {
  const { hodnota, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, vzkaz } = req.body || {};
  if (!hodnota || !kupujici_jmeno || !kupujici_email) {
    return res.status(400).json({ chyba: 'Vyplňte prosím hodnotu poukazu, jméno a e-mail.' });
  }
  const { data, error } = await supabase.from('poukazy_zadosti').insert({
    hodnota, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, vzkaz, stav: 'nova'
  }).select().single();
  if (error) return res.status(500).json({ chyba: error.message });
  res.json({ ok: true, zadost: data });
});

// ══════════════ ADMIN ENDPOINTY (heslo v hlavičce x-admin-heslo) ══════════════
app.use('/api/admin', vyzadovatAdmina);

// -- Přehled --
app.get('/api/admin/prehled', async (req, res) => {
  const dnes = new Date().toISOString().slice(0, 10);
  const [{ data: rez }, { data: pouk }, { data: zad }] = await Promise.all([
    supabase.from('rezervace').select('id, stav, datum'),
    supabase.from('poukazy').select('id, stav, zustatek'),
    supabase.from('poukazy_zadosti').select('id, stav')
  ]);
  res.json({
    rezervaceCelkem: rez?.length || 0,
    rezervaceCekajici: rez?.filter(r => r.stav === 'cekajici').length || 0,
    rezervaceBudouci: rez?.filter(r => r.datum >= dnes && r.stav !== 'zrusena').length || 0,
    poukazyAktivni: pouk?.filter(p => p.stav === 'aktivni').length || 0,
    poukazyHodnota: pouk?.filter(p => p.stav === 'aktivni').reduce((s, p) => s + Number(p.zustatek), 0) || 0,
    poukazyZadostiNove: zad?.filter(z => z.stav === 'nova').length || 0
  });
});

// -- Rezervace --
app.get('/api/admin/rezervace', async (req, res) => {
  const { data, error } = await supabase
    .from('rezervace')
    .select('*')
    .order('datum', { ascending: false }).order('cas_od', { ascending: false });
  if (error) return res.status(500).json({ chyba: error.message });
  res.json(data);
});

app.patch('/api/admin/rezervace/:id/stav', async (req, res) => {
  const { stav } = req.body || {};
  if (!['cekajici', 'potvrzena', 'zrusena'].includes(stav)) {
    return res.status(400).json({ chyba: 'Neplatný stav.' });
  }
  const { error } = await supabase.from('rezervace').update({ stav }).eq('id', req.params.id);
  if (error) return res.status(500).json({ chyba: error.message });
  res.json({ ok: true });
});

// -- Pracovní doba --
app.get('/api/admin/pracovni-doba', async (req, res) => {
  const { data, error } = await supabase.from('pracovni_doba').select('*').order('den_v_tydnu');
  if (error) return res.status(500).json({ chyba: error.message });
  res.json(data);
});

app.put('/api/admin/pracovni-doba/:den', async (req, res) => {
  const { otevreno_od, otevreno_do, aktivni } = req.body || {};
  const { error } = await supabase.from('pracovni_doba')
    .update({ otevreno_od, otevreno_do, aktivni })
    .eq('den_v_tydnu', req.params.den);
  if (error) return res.status(500).json({ chyba: error.message });
  res.json({ ok: true });
});

// -- Varianty poukazů (částka + platnost) --
app.get('/api/admin/poukazy/typy', async (req, res) => {
  const { data, error } = await supabase.from('poukazy_typy').select('*').order('poradi');
  if (error) return res.status(500).json({ chyba: error.message });
  res.json(data);
});

app.post('/api/admin/poukazy/typy', async (req, res) => {
  const { hodnota, platnost_mesicu, poradi } = req.body || {};
  if (!hodnota || !platnost_mesicu) return res.status(400).json({ chyba: 'Zadejte hodnotu a platnost v měsících.' });
  const { data, error } = await supabase.from('poukazy_typy').insert({
    hodnota, platnost_mesicu, poradi: poradi || 0
  }).select().single();
  if (error) return res.status(500).json({ chyba: error.message });
  res.json({ ok: true, typ: data });
});

app.put('/api/admin/poukazy/typy/:id', async (req, res) => {
  const { hodnota, platnost_mesicu } = req.body || {};
  const { error } = await supabase.from('poukazy_typy').update({ hodnota, platnost_mesicu }).eq('id', req.params.id);
  if (error) return res.status(500).json({ chyba: error.message });
  res.json({ ok: true });
});

app.delete('/api/admin/poukazy/typy/:id', async (req, res) => {
  const { error } = await supabase.from('poukazy_typy').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ chyba: error.message });
  res.json({ ok: true });
});

// -- Poukazy --
app.get('/api/admin/poukazy', async (req, res) => {
  const { data, error } = await supabase.from('poukazy').select('*').order('vytvoreno', { ascending: false });
  if (error) return res.status(500).json({ chyba: error.message });
  res.json(data);
});

app.post('/api/admin/poukazy', async (req, res) => {
  const { poukaz_typ_id, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, zakoupeno_kde } = req.body || {};
  if (!poukaz_typ_id) return res.status(400).json({ chyba: 'Vyberte variantu poukazu.' });
  const { data: typ } = await supabase.from('poukazy_typy').select('*').eq('id', poukaz_typ_id).maybeSingle();
  if (!typ) return res.status(404).json({ chyba: 'Tato varianta poukazu nebyla nalezena.' });
  const platnostDo = new Date();
  platnostDo.setMonth(platnostDo.getMonth() + typ.platnost_mesicu);
  const { data, error } = await supabase.from('poukazy').insert({
    kod: vygenerovatKod(),
    ean: vygenerovatEan(),
    hodnota: typ.hodnota, zustatek: typ.hodnota,
    platnost_do: platnostDo.toISOString().slice(0, 10),
    zakoupeno_kde: zakoupeno_kde || 'osobne',
    kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho,
    stav: 'aktivni'
  }).select().single();
  if (error) return res.status(500).json({ chyba: error.message });
  res.json({ ok: true, poukaz: data });
});

app.patch('/api/admin/poukazy/:id/stav', async (req, res) => {
  const { stav } = req.body || {};
  if (!['aktivni', 'pouzity', 'zruseny'].includes(stav)) return res.status(400).json({ chyba: 'Neplatný stav.' });
  const { error } = await supabase.from('poukazy').update({ stav }).eq('id', req.params.id);
  if (error) return res.status(500).json({ chyba: error.message });
  res.json({ ok: true });
});

app.delete('/api/admin/poukazy/:id', async (req, res) => {
  const { error } = await supabase.from('poukazy').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ chyba: error.message });
  res.json({ ok: true });
});

// -- Žádosti o poukaz --
app.get('/api/admin/poukazy/zadosti', async (req, res) => {
  const { data, error } = await supabase.from('poukazy_zadosti').select('*').order('vytvoreno', { ascending: false });
  if (error) return res.status(500).json({ chyba: error.message });
  res.json(data);
});

// Schválení žádosti → automaticky vytvoří aktivní poukaz
app.patch('/api/admin/poukazy/zadosti/:id/stav', async (req, res) => {
  const { stav } = req.body || {};
  if (!['nova', 'vyrizena', 'zamitnuta'].includes(stav)) return res.status(400).json({ chyba: 'Neplatný stav.' });
  const { data: zadost } = await supabase.from('poukazy_zadosti').select('*').eq('id', req.params.id).single();
  if (!zadost) return res.status(404).json({ chyba: 'Žádost nenalezena.' });

  await supabase.from('poukazy_zadosti').update({ stav }).eq('id', req.params.id);

  if (stav === 'vyrizena') {
    const platnostDo = new Date();
    platnostDo.setFullYear(platnostDo.getFullYear() + 1);
    const { data: poukaz, error } = await supabase.from('poukazy').insert({
      kod: vygenerovatKod(),
      ean: vygenerovatEan(),
      hodnota: zadost.hodnota, zustatek: zadost.hodnota,
      platnost_do: platnostDo.toISOString().slice(0, 10),
      zakoupeno_kde: 'web',
      kupujici_jmeno: zadost.kupujici_jmeno,
      kupujici_email: zadost.kupujici_email,
      kupujici_telefon: zadost.kupujici_telefon,
      pro_koho: zadost.pro_koho,
      stav: 'aktivni'
    }).select().single();
    if (error) return res.status(500).json({ chyba: error.message });
    return res.json({ ok: true, poukaz });
  }
  res.json({ ok: true });
});

// -- Ceník --
app.get('/api/admin/cenik', async (req, res) => {
  const { data, error } = await supabase.from('cenik').select('*').order('poradi_skupiny').order('poradi_varianty');
  if (error) return res.status(500).json({ chyba: error.message });
  res.json(data);
});

app.post('/api/admin/cenik', async (req, res) => {
  const { skupina, emoji, varianta, delka_min, cena, rezervovatelna, poradi_skupiny, poradi_varianty } = req.body || {};
  if (!skupina || !varianta || !delka_min || cena === undefined) return res.status(400).json({ chyba: 'Vyplňte název masáže, variantu, délku a cenu.' });
  const { data, error } = await supabase.from('cenik').insert({
    skupina, emoji: emoji || '💆', varianta, delka_min, cena,
    rezervovatelna: rezervovatelna !== false,
    poradi_skupiny: poradi_skupiny || 0, poradi_varianty: poradi_varianty || 0
  }).select().single();
  if (error) return res.status(500).json({ chyba: error.message });
  res.json({ ok: true, polozka: data });
});

app.put('/api/admin/cenik/:id', async (req, res) => {
  const { skupina, emoji, varianta, delka_min, cena, rezervovatelna } = req.body || {};
  const { error } = await supabase.from('cenik').update({ skupina, emoji, varianta, delka_min, cena, rezervovatelna }).eq('id', req.params.id);
  if (error) return res.status(500).json({ chyba: error.message });
  res.json({ ok: true });
});

app.delete('/api/admin/cenik/:id', async (req, res) => {
  const { error } = await supabase.from('cenik').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ chyba: error.message });
  res.json({ ok: true });
});

// -- Prodejna (masáže prodané osobně na místě) --
app.get('/api/admin/prodejna', async (req, res) => {
  const { data, error } = await supabase.from('prodeje').select('*').order('vytvoreno', { ascending: false });
  if (error) return res.status(500).json({ chyba: error.message });
  res.json(data);
});

app.post('/api/admin/prodejna', async (req, res) => {
  const { masaz, cena, zpusob_platby, poznamka } = req.body || {};
  if (!masaz || !cena) return res.status(400).json({ chyba: 'Vyberte masáž a zadejte cenu.' });
  const { data, error } = await supabase.from('prodeje').insert({
    masaz, cena, zpusob_platby: zpusob_platby || 'hotove', poznamka
  }).select().single();
  if (error) return res.status(500).json({ chyba: error.message });
  res.json({ ok: true, prodej: data });
});

app.delete('/api/admin/prodejna/:id', async (req, res) => {
  const { error } = await supabase.from('prodeje').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ chyba: error.message });
  res.json({ ok: true });
});

// -- Účetnictví: souhrn tržeb z rezervací, prodejny na místě a poukazů --
app.get('/api/admin/ucetnictvi', async (req, res) => {
  const [{ data: rez }, { data: prod }, { data: pouk }] = await Promise.all([
    supabase.from('rezervace').select('cena, vytvoreno, stav').eq('stav', 'potvrzena'),
    supabase.from('prodeje').select('cena, vytvoreno'),
    supabase.from('poukazy').select('hodnota, vytvoreno')
  ]);

  const polozky = [
    ...(rez || []).map(r => ({ zdroj: 'rezervace', castka: Number(r.cena) || 0, datum: r.vytvoreno })),
    ...(prod || []).map(p => ({ zdroj: 'prodejna', castka: Number(p.cena) || 0, datum: p.vytvoreno })),
    ...(pouk || []).map(p => ({ zdroj: 'poukaz', castka: Number(p.hodnota) || 0, datum: p.vytvoreno }))
  ];

  const trzbyCelkem = polozky.reduce((s, p) => s + p.castka, 0);
  const dnes = new Date().toISOString().slice(0, 10);
  const trzbyDnes = polozky.filter(p => p.datum.slice(0, 10) === dnes).reduce((s, p) => s + p.castka, 0);

  const poMesicich = {};
  polozky.forEach(p => {
    const mesic = p.datum.slice(0, 7); // YYYY-MM
    poMesicich[mesic] = (poMesicich[mesic] || 0) + p.castka;
  });
  const mesicniPrehled = Object.entries(poMesicich).sort((a, b) => b[0].localeCompare(a[0])).map(([mesic, castka]) => ({ mesic, castka }));

  res.json({
    trzbyCelkem, trzbyDnes,
    pocetPolozek: polozky.length,
    prumernaPolozka: polozky.length ? trzbyCelkem / polozky.length : 0,
    mesicniPrehled,
    polozky: polozky.sort((a, b) => b.datum.localeCompare(a.datum))
  });
});

app.get('/', (req, res) => res.send('Masáže Alesa API běží 🌸'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server běží na portu ' + PORT));
