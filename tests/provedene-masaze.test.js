// Regresní test: "Dokončení masáže" dialog, viditelné stavy plateb na
// dashboardu a jednotný přehled GET /api/admin/provedene-masaze.
//
// Řeší stížnost "když odkliknu provedenou masáž, prodej se mi nepropíše do
// evidence prodejů" — PATCH /rezervace/:id/stav sám o sobě nikdy nezapisuje
// platbu (mění jen stav), takže админka musí umět zápis platby + dokončení
// bezpečně spojit (viz otevritDokonceniMasaze/dokoncitMasazOdeslat v
// admin.html) a mít jedno čitelné místo (Provedené masáže), kde obojí vidí
// spojené dohromady, bez dvojího započítání.
//
// Spuštění:  ADMIN_HESLO=... TEST_API_BASE=http://localhost:3001/api node tests/provedene-masaze.test.js

const assert = require('node:assert/strict');

const { ziskatTestApiBase } = require('./env-guard');
const API = ziskatTestApiBase(); // fail-closed, žádný produkční fallback
const HESLO = process.env.ADMIN_HESLO;

if (!HESLO) {
  console.error('Chybí ADMIN_HESLO v prostředí — test se přeskakuje.');
  process.exit(0);
}

function adminFetch(cesta, options = {}) {
  return fetch(API + cesta, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-admin-heslo': HESLO, ...(options.headers || {}) }
  });
}

async function najitVolnyTermin(datum, cenikId) {
  const terminy = await fetch(`${API}/rezervace/volne-terminy?datum=${datum}&cenik_id=${cenikId}`).then(r => r.json());
  const volny = Array.isArray(terminy) ? terminy.find(t => t.volno) : null;
  return volny ? volny.cas : null;
}

async function novyVolnyTermin(cenikId, odpocetDni) {
  for (let i = odpocetDni; i < odpocetDni + 60; i += 3) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const cas = await najitVolnyTermin(iso, cenikId);
    if (cas) return { datum: iso, cas };
  }
  throw new Error('Nenalezen volný termín pro test');
}

// Pro testy souhrnů za konkrétní den potřebujeme jeden den se ALESPOŇ dvěma
// volnými termíny. Druhý skutečně volný čas se ale musí zjistit ZNOVU, AŽ
// PO založení první rezervace na ten den — zabrání prvního termínu totiž
// kvůli povinné mezeře mezi rezervacemi může neplatit i NEJBLIŽŠÍ sousední
// čas, který byl v původním (před-rezervačním) seznamu ještě volný.
async function denSeDvemaVolnymiTerminy(cenikId, odpocetDni) {
  for (let i = odpocetDni; i < odpocetDni + 90; i += 1) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const terminy = await fetch(`${API}/rezervace/volne-terminy?datum=${iso}&cenik_id=${cenikId}`).then(r => r.json());
    const volne = Array.isArray(terminy) ? terminy.filter(t => t.volno).map(t => t.cas) : [];
    if (volne.length >= 4) return iso; // rezerva, ať po zabrání jednoho zbyde i druhý skutečně volný
  }
  throw new Error('Nenalezen den se dostatkem volných termínů pro test souhrnů');
}

async function vytvorRezervaci(cenikId, telefonSuffix, { datum, cas } = {}) {
  const term = datum && cas ? { datum, cas } : await novyVolnyTermin(cenikId, 300 + Math.floor(Math.random() * 100));
  const res = await adminFetch('/admin/rezervace', {
    method: 'POST',
    body: JSON.stringify({ cenik_id: cenikId, datum: term.datum, cas_od: term.cas, jmeno: 'TEST-PROVEDENE-MASAZE (smazat)', telefon: '00001' + telefonSuffix, email: 'test-provedene-masaze@example.cz' })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'Vytvoření testovací rezervace selhalo: ' + JSON.stringify(data));
  if (data.rezervace.klientka_id) uklidKlientky.add(data.rezervace.klientka_id);
  return data.rezervace;
}

async function dokoncit(id) {
  const res = await adminFetch(`/admin/rezervace/${id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'dokoncena' }) });
  const data = await res.json();
  assert.equal(res.status, 200, 'Dokončení rezervace selhalo: ' + JSON.stringify(data));
  return data;
}

async function zaplatit(id, castka, zpusob_platby) {
  return adminFetch(`/admin/rezervace/${id}/platba`, { method: 'PATCH', body: JSON.stringify({ castka, zpusob_platby }) }).then(async r => ({ status: r.status, data: await r.json() }));
}

async function najitPolozku(od, doD, id) {
  const d = await adminFetch(`/admin/provedene-masaze?od=${od}&do=${doD}`).then(r => r.json());
  return d.polozky.find(p => p.zdroj === 'rezervace' && p.id === id);
}

const uklidRezervace = [];
const uklidPoukazy = [];
const uklidKlientky = new Set();

async function main() {
  try {
    const cenik = await fetch(API + '/cenik').then(r => r.json());
    const polozka = cenik.find(c => c.rezervovatelna);
    assert.ok(polozka, 'V ceníku není rezervovatelná položka pro test');
    const cena = Number(polozka.cena);

    // 1) Platba předem + doplatek jinou metodou → kombinovaná platba
    console.log('--- 1) záloha hotově + doplatek kartou → kombinovaná platba ---');
    {
      const r = await vytvorRezervaci(polozka.id, '11');
      uklidRezervace.push(r.id);
      const zaloha = Math.max(1, Math.floor(cena / 3));
      const doplatek = cena - zaloha;
      const p1 = await zaplatit(r.id, zaloha, 'hotove');
      assert.equal(p1.status, 200, JSON.stringify(p1.data));
      assert.equal(p1.data.rezervace.stav_platby, 'castecne_zaplaceno');
      const p2 = await zaplatit(r.id, doplatek, 'kartou');
      assert.equal(p2.status, 200, JSON.stringify(p2.data));
      assert.equal(p2.data.rezervace.stav_platby, 'zaplaceno');
      await dokoncit(r.id);

      const polozkaView = await najitPolozku(r.datum, r.datum, r.id);
      assert.ok(polozkaView, 'Dokončená rezervace se neobjevila v /provedene-masaze');
      assert.equal(polozkaView.cena, cena);
      assert.equal(polozkaView.uhrazeno, cena);
      assert.equal(polozkaView.zbytek, 0);
      assert.equal(polozkaView.stav_platby, 'zaplaceno');
      assert.equal(Object.keys(polozkaView.rozpisPlatby).length, 2, 'Rozpis platby má mít OBĚ metody, ne jen poslední: ' + JSON.stringify(polozkaView.rozpisPlatby));
      assert.equal(polozkaView.rozpisPlatby.hotove, zaloha);
      assert.equal(polozkaView.rozpisPlatby.kartou, doplatek);
      console.log('OK — kombinovaná platba (hotově ' + zaloha + ' + kartou ' + doplatek + ') se v rozpisu zobrazí celá, ne jen poslední metoda');
    }

    // 2) Plná úhrada jedním zápisem
    console.log('--- 2) plná úhrada ---');
    {
      const r = await vytvorRezervaci(polozka.id, '12');
      uklidRezervace.push(r.id);
      await zaplatit(r.id, cena, 'hotove');
      await dokoncit(r.id);
      const polozkaView = await najitPolozku(r.datum, r.datum, r.id);
      assert.equal(polozkaView.stav_platby, 'zaplaceno');
      assert.equal(polozkaView.zbytek, 0);
      assert.deepEqual(polozkaView.rozpisPlatby, { hotove: cena });
      console.log('OK — plná úhrada jednou metodou: rozpis má jen tu jednu metodu');
    }

    // 3) Částečná úhrada, masáž dokončená s nedoplatkem
    console.log('--- 3) částečná úhrada ---');
    let rCastecna;
    {
      const r = await vytvorRezervaci(polozka.id, '13');
      uklidRezervace.push(r.id);
      const castecna = Math.max(1, Math.floor(cena / 4));
      await zaplatit(r.id, castecna, 'kartou');
      await dokoncit(r.id);
      rCastecna = { ...r, castecna, doplatek: cena - castecna };
      const polozkaView = await najitPolozku(r.datum, r.datum, r.id);
      assert.equal(polozkaView.stav_platby, 'castecne_zaplaceno');
      assert.equal(polozkaView.zbytek, cena - castecna);
      console.log('OK — částečně zaplacená dokončená masáž má ve "zbytek" správný nedoplatek');
    }

    // 4) Dokončení bez platby
    console.log('--- 4) dokončení bez platby ---');
    let rBezPlatby;
    {
      const r = await vytvorRezervaci(polozka.id, '14');
      uklidRezervace.push(r.id);
      await dokoncit(r.id);
      rBezPlatby = r;
      const polozkaView = await najitPolozku(r.datum, r.datum, r.id);
      assert.equal(polozkaView.stav_platby, 'nezaplaceno');
      assert.equal(polozkaView.uhrazeno, 0);
      assert.equal(polozkaView.zbytek, cena);
      assert.deepEqual(polozkaView.rozpisPlatby, {});
      console.log('OK — dokončená masáž bez jakékoli platby: uhrazeno 0, prázdný rozpis, "nezaplaceno"');
    }

    // 5) Dlaždice "Dokončené bez platby" na /api/admin/prehled musí zahrnout
    // i částečně nezaplacené (ne jen úplně nezaplacené).
    console.log('--- 5) dlaždice "Dokončené bez platby" ---');
    {
      const pred = await adminFetch('/admin/prehled').then(r => r.json());
      // rCastecna a rBezPlatby z bodů 3 a 4 jsou v tuhle chvíli OBĚ "dokoncena"
      // a NEJSOU "zaplaceno" — obě už se počítaly v "pred", protože vznikly
      // dřív. Zaplatíme teď jednu z nich a ověříme POKLES o 1.
      await zaplatit(rCastecna.id, rCastecna.doplatek, 'hotove');
      const po = await adminFetch('/admin/prehled').then(r => r.json());
      assert.equal(po.dokonceneBezPlatby, pred.dokonceneBezPlatby - 1, 'Doplacení nedoplatku má snížit počet "Dokončené bez platby" o 1');
      console.log('OK — doplacení nedoplatku sníží počet "Dokončené bez platby" na dashboardu o 1 (' + pred.dokonceneBezPlatby + ' → ' + po.dokonceneBezPlatby + ')');
    }

    // 6) Platba poukazem — poukaz se v rozpisu objeví, ale do "skutečně
    // přijato podle data platby" se nezapočítá znovu (ty peníze byly přijaté
    // už při PRODEJI poukazu, ne teď při uplatnění) — stejné pravidlo jako
    // kategorie B v /api/admin/ucetnictvi.
    console.log('--- 6) platba poukazem — bez dvojího započítání ---');
    {
      const r = await vytvorRezervaci(polozka.id, '16');
      uklidRezervace.push(r.id);
      const poukazRes = await adminFetch('/admin/poukazy', {
        method: 'POST', body: JSON.stringify({ cenik_id: polozka.id, kupujici_jmeno: 'TEST-PROVEDENE-MASAZE-POUKAZ (smazat)', zaplaceno: true, zpusob_platby: 'hotove' })
      });
      const poukazData = await poukazRes.json();
      assert.equal(poukazRes.status, 200, JSON.stringify(poukazData));
      uklidPoukazy.push(poukazData.poukaz.id);

      // Uplatnění poukazu zapisuje řádek do "platby" s vytvoreno = DNES —
      // měříme proto "skutecnePrijato" pro DNEŠNÍ den těsně před a po
      // uplatnění (ne pro den masáže, který je v budoucnu — viz test 13).
      const dnes = new Date().toISOString().slice(0, 10);
      const skutecnePrijatoDnesPred = await adminFetch(`/admin/provedene-masaze?od=${dnes}&do=${dnes}`).then(res => res.json()).then(d => d.souhrn.skutecnePrijato);

      const uplatnitRes = await adminFetch(`/admin/poukazy/${poukazData.poukaz.id}/uplatnit`, {
        method: 'POST', body: JSON.stringify({ castka: cena, rezervace_id: r.id })
      });
      const uplatnitData = await uplatnitRes.json();
      assert.equal(uplatnitRes.status, 200, JSON.stringify(uplatnitData));
      await dokoncit(r.id);

      const den = await adminFetch(`/admin/provedene-masaze?od=${r.datum}&do=${r.datum}`).then(res => res.json());
      const polozkaView = den.polozky.find(p => p.zdroj === 'rezervace' && p.id === r.id);
      assert.ok(polozkaView, 'Rezervace zaplacená poukazem se neobjevila v přehledu');
      assert.deepEqual(polozkaView.rozpisPlatby, { poukaz: cena });
      assert.equal(polozkaView.uhrazeno, cena, '"uhrazenoKSluzbam" musí počítat i platbu poukazem jako uhrazenou službu');

      const skutecnePrijatoDnesPo = await adminFetch(`/admin/provedene-masaze?od=${dnes}&do=${dnes}`).then(res => res.json()).then(d => d.souhrn.skutecnePrijato);
      assert.equal(skutecnePrijatoDnesPo, skutecnePrijatoDnesPred,
        'Uplatnění poukazu nesmí zvýšit "skutečně přijato podle data platby" — ty peníze byly přijaté už při PRODEJI poukazu (byla by jinak započtena podruhé)');
      console.log('OK — platba poukazem se v rozpisu zobrazí, ale "skutečně přijato dnes" se jejím uplatněním nezvýší (žádné dvojí započítání)');
    }

    // 7) Souběžné platby (race): dvě žádosti o STEJNOU plnou částku najednou
    // — musí uspět přesně JEDNA, druhá musí být odmítnuta (FOR UPDATE zámek
    // + živé přepočítání zbývajícího dluhu v PATCH .../platba), ne obě.
    console.log('--- 7) souběžné platby (race) ---');
    {
      const r = await vytvorRezervaci(polozka.id, '17');
      uklidRezervace.push(r.id);
      const [a, b] = await Promise.all([
        zaplatit(r.id, cena, 'hotove'),
        zaplatit(r.id, cena, 'kartou')
      ]);
      const uspesne = [a, b].filter(x => x.status === 200);
      const odmitnute = [a, b].filter(x => x.status !== 200);
      assert.equal(uspesne.length, 1, 'Právě JEDNA ze dvou souběžných plateb na celou částku má uspět, uspělo: ' + uspesne.length);
      assert.equal(odmitnute.length, 1, 'Právě JEDNA ze dvou souběžných plateb má být odmítnuta, odmítnuto: ' + odmitnute.length);
      const historie = await adminFetch(`/admin/rezervace/${r.id}/platby`).then(res => res.json());
      const soucet = historie.reduce((s, p) => s + Number(p.castka), 0);
      assert.equal(soucet, cena, 'Souběh nesmí zapsat víc peněz, než je cena — zapsáno ' + soucet + ', cena ' + cena);
      assert.equal(historie.length, 1, 'Souběh nesmí vytvořit dva platební řádky, vytvořeno: ' + historie.length);
      console.log('OK — ze dvou souběžných plateb na celou částku uspěje přesně jedna, druhá je odmítnuta (žádná dvojí platba)');
    }

    // 8) Selhání kroku "dokončit" PO úspěšném zápisu platby — i bez
    // klientského "už zaplaceno" příznaku (ten chrání jen UI, ne server) musí
    // opakovaný pokus zaplatit STEJNOU částku znovu server odmítnout, protože
    // živě přepočítává zbývající dluh ze zamčeného řádku rezervace — přesně
    // ten mechanismus, na který se spoléhá dialog "Dokončit masáž" při
    // opakování po chybě.
    console.log('--- 8) "opakování po chybě dokončení" nesmí zapsat platbu dvakrát ---');
    {
      const r = await vytvorRezervaci(polozka.id, '18');
      uklidRezervace.push(r.id);
      const prvni = await zaplatit(r.id, cena, 'hotove');
      assert.equal(prvni.status, 200, JSON.stringify(prvni.data));
      assert.equal(prvni.data.rezervace.stav_platby, 'zaplaceno');

      // Simulace: dialog by si po úspěšné platbě nastavil "už zapsáno" a
      // znovu platbu NEPOSLAL — tady ověřujeme tvrdší věc, totiž že i KDYBY
      // se platba (naivním opakováním) poslala znovu se stejnou částkou,
      // server by ji odmítl, takže dvojí zápis není možný ani bez klientské
      // pojistky.
      const opakovani = await zaplatit(r.id, cena, 'hotove');
      assert.notEqual(opakovani.status, 200, 'Opakovaný zápis STEJNÉ platby po úspěchu měl být odmítnut, ale prošel: ' + JSON.stringify(opakovani.data));

      // Krok 2 (dokončení) teď proběhne — jako by šlo o úspěšný retry po
      // dřívější chybě kroku 2.
      await dokoncit(r.id);
      const historie = await adminFetch(`/admin/rezervace/${r.id}/platby`).then(res => res.json());
      assert.equal(historie.length, 1, 'Po "opakování" nesmí v historii přibyla druhá platba, řádků: ' + historie.length);
      assert.equal(Number(historie[0].castka), cena);
      console.log('OK — opakovaný zápis stejné platby po úspěchu je server odmítne; historie obsahuje jen jeden platební řádek');
    }

    // 9) Storno (zrušená rezervace) se do přehledu provedených masáží nikdy
    // nedostane, i kdyby měla zaplaceno.
    console.log('--- 9) zrušená rezervace není v přehledu ---');
    {
      const r = await vytvorRezervaci(polozka.id, '19');
      uklidRezervace.push(r.id);
      await zaplatit(r.id, cena, 'hotove');
      await adminFetch(`/admin/rezervace/${r.id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'zrusena' }) });
      const den = await adminFetch(`/admin/provedene-masaze?od=${r.datum}&do=${r.datum}`).then(res => res.json());
      const najdena = den.polozky.find(p => p.zdroj === 'rezervace' && p.id === r.id);
      assert.equal(najdena, undefined, 'Zrušená (stornovaná) rezervace se nesmí objevit v přehledu provedených masáží');
      console.log('OK — zrušená rezervace (storno) se do přehledu provedených masáží nedostane, i když byla zaplacená');
    }

    // 10) Potvrzená (budoucí, ještě neproběhlá) rezervace se do přehledu
    // provedených masáží taky nedostane — na rozdíl od /ucetnictvi kategorie
    // A tenhle přehled záměrně počítá JEN skutečně dokončené masáže.
    console.log('--- 10) potvrzená (budoucí) rezervace není v přehledu ---');
    {
      const r = await vytvorRezervaci(polozka.id, '1a');
      uklidRezervace.push(r.id);
      await adminFetch(`/admin/rezervace/${r.id}/stav`, { method: 'PATCH', body: JSON.stringify({ stav: 'potvrzena' }) });
      const den = await adminFetch(`/admin/provedene-masaze?od=${r.datum}&do=${r.datum}`).then(res => res.json());
      const najdena = den.polozky.find(p => p.zdroj === 'rezervace' && p.id === r.id);
      assert.equal(najdena, undefined, 'Potvrzená, ale ještě neproběhlá rezervace se nesmí objevit v přehledu provedených masáží');
      console.log('OK — potvrzená budoucí rezervace (ještě neproběhla) se do přehledu provedených masáží nedostane');
    }

    // 11) Vratka (částečné vrácení) se v rozpisu metody správně odečte, ne
    // zdvojí, a "skutečně přijato" ji taky čistě zanetuje.
    console.log('--- 11) vratka se v rozpisu metody odečte ---');
    {
      const r = await vytvorRezervaci(polozka.id, '1b');
      uklidRezervace.push(r.id);
      await zaplatit(r.id, cena, 'hotove');
      const vratka = Math.max(1, Math.floor(cena / 5));
      const vratkaRes = await adminFetch(`/admin/rezervace/${r.id}/platba`, {
        method: 'PATCH', body: JSON.stringify({ castka: vratka, zpusob_platby: 'hotove', typ: 'vratka' })
      });
      assert.equal(vratkaRes.status, 200);
      await dokoncit(r.id);
      const polozkaView = await najitPolozku(r.datum, r.datum, r.id);
      assert.equal(polozkaView.uhrazeno, cena - vratka);
      assert.deepEqual(polozkaView.rozpisPlatby, { hotove: cena - vratka }, 'Vratka musí vyčistit součet metody "hotove", ne zůstat jako druhá položka');
      console.log('OK — vratka se v rozpisu metody čistě odečte (' + cena + ' − ' + vratka + ' = ' + (cena - vratka) + ' Kč)');
    }

    // 12) Filtrování podle způsobu úhrady (?zpusobPlatby=) — položka placená
    // jen kartou se nesmí objevit ve filtru "hotove" a naopak.
    console.log('--- 12) filtrování podle způsobu úhrady ---');
    {
      const datum = await denSeDvemaVolnymiTerminy(polozka.id, 450 + Math.floor(Math.random() * 50));
      const cas1 = await najitVolnyTermin(datum, polozka.id);
      const rHotove = await vytvorRezervaci(polozka.id, '1c', { datum, cas: cas1 });
      const cas2 = await najitVolnyTermin(datum, polozka.id); // znovu AŽ PO založení rHotove
      const rKartou = await vytvorRezervaci(polozka.id, '1d', { datum, cas: cas2 });
      uklidRezervace.push(rHotove.id, rKartou.id);
      await zaplatit(rHotove.id, cena, 'hotove');
      await zaplatit(rKartou.id, cena, 'kartou');
      await dokoncit(rHotove.id);
      await dokoncit(rKartou.id);

      const filtrHotove = await adminFetch(`/admin/provedene-masaze?od=${datum}&do=${datum}&zpusobPlatby=hotove`).then(res => res.json());
      const idsHotove = filtrHotove.polozky.filter(p => p.zdroj === 'rezervace').map(p => p.id);
      assert.ok(idsHotove.includes(rHotove.id), 'Filtr "hotove" musí obsahovat rezervaci placenou hotově');
      assert.ok(!idsHotove.includes(rKartou.id), 'Filtr "hotove" nesmí obsahovat rezervaci placenou kartou');

      const filtrKartou = await adminFetch(`/admin/provedene-masaze?od=${datum}&do=${datum}&zpusobPlatby=kartou`).then(res => res.json());
      const idsKartou = filtrKartou.polozky.filter(p => p.zdroj === 'rezervace').map(p => p.id);
      assert.ok(idsKartou.includes(rKartou.id), 'Filtr "kartou" musí obsahovat rezervaci placenou kartou');
      assert.ok(!idsKartou.includes(rHotove.id), 'Filtr "kartou" nesmí obsahovat rezervaci placenou hotově');
      console.log('OK — filtr podle způsobu úhrady správně odděluje položky placené různými metodami');
    }

    // 13) Souhrny za přesně jeden (izolovaný) den — dvě dokončené masáže,
    // jedna plně zaplacená hotově, druhá nezaplacená → ověří, že
    // hodnotaSluzeb/uhrazenoKSluzbam/skutecnePrijato počítají přesně to, co
    // mají, a ne o víc nebo méně.
    console.log('--- 13) přesný souhrn za izolovaný den (2 položky) ---');
    {
      const datum = await denSeDvemaVolnymiTerminy(polozka.id, 500 + Math.floor(Math.random() * 50));
      const predTim = await adminFetch(`/admin/provedene-masaze?od=${datum}&do=${datum}`).then(res => res.json());
      assert.equal(predTim.polozky.length, 0, 'Testovací den už obsahuje cizí položky — zvolený den nebyl prázdný');

      const cas1 = await najitVolnyTermin(datum, polozka.id);
      const rZaplacena = await vytvorRezervaci(polozka.id, '1e', { datum, cas: cas1 });
      const cas2 = await najitVolnyTermin(datum, polozka.id); // znovu AŽ PO založení rZaplacena
      const rNezaplacena = await vytvorRezervaci(polozka.id, '1f', { datum, cas: cas2 });
      uklidRezervace.push(rZaplacena.id, rNezaplacena.id);

      // Platba se zapisuje TEĎ (vytvoreno = dnes), zatímco "datum" masáže je
      // daleko v budoucnu (den zvolený denSeDvemaVolnymiTerminy výš) — přesně
      // tahle situace (záloha zaplacená dávno PŘED masáží) je důvod, proč
      // jsou "uhrazenoKSluzbam" (podle data MASÁŽE) a "skutecnePrijato"
      // (podle data PLATBY) dvě different osy, ne jedno číslo.
      const dnes = new Date().toISOString().slice(0, 10);
      const skutecnePrijatoDnesPred = await adminFetch(`/admin/provedene-masaze?od=${dnes}&do=${dnes}`).then(res => res.json()).then(d => d.souhrn.skutecnePrijato);
      await zaplatit(rZaplacena.id, cena, 'hotove');
      await dokoncit(rZaplacena.id);
      await dokoncit(rNezaplacena.id);

      const po = await adminFetch(`/admin/provedene-masaze?od=${datum}&do=${datum}`).then(res => res.json());
      assert.equal(po.polozky.length, 2);
      assert.equal(po.souhrn.hodnotaSluzeb, cena * 2, 'hodnotaSluzeb má počítat OBĚ služby, bez ohledu na to, jestli jsou zaplacené');
      assert.equal(po.souhrn.uhrazenoKSluzbam, cena, 'uhrazenoKSluzbam má počítat jen skutečně uhrazenou část, podle data MASÁŽE');
      assert.equal(po.souhrn.skutecnePrijato, 0,
        'skutecnePrijato se měří PODLE DATA PLATBY (dnes), ne podle data masáže (v budoucnu) — v budoucím dni musí vyjít 0, i když je masáž zaplacená');

      const skutecnePrijatoDnesPo = await adminFetch(`/admin/provedene-masaze?od=${dnes}&do=${dnes}`).then(res => res.json()).then(d => d.souhrn.skutecnePrijato);
      assert.equal(skutecnePrijatoDnesPo - skutecnePrijatoDnesPred, cena,
        'Platba zapsaná DNES se měla projevit v "skutecnePrijato" pro DNEŠNÍ den (ne pro den masáže)');
      console.log('OK — souhrny za izolovaný den masáže: hodnota služeb ' + po.souhrn.hodnotaSluzeb + ' Kč, uhrazeno ' + po.souhrn.uhrazenoKSluzbam + ' Kč; "skutečně přijato" pro TEN den je 0 (platba šla dnešním datem) a dnešní součet vzrostl přesně o ' + cena + ' Kč');
    }

    // 14) Strukturální invariant pro položky ze zdroje "prodejna" (pokud v
    // TEST databázi nějaké existují) — vždy plně zaplacené, nikdy
    // nedoplatek, bez nutnosti vytvářet novou fixturu.
    console.log('--- 14) strukturální invariant prodejny (bez nutnosti fixtury) ---');
    {
      const vse = await adminFetch('/admin/provedene-masaze').then(res => res.json());
      const prodejnaPolozky = vse.polozky.filter(p => p.zdroj === 'prodejna');
      prodejnaPolozky.forEach(p => {
        assert.equal(p.stav_platby, 'zaplaceno', 'Položka z prodejny musí být vždy "zaplaceno" (platí se celá hned) — id ' + p.id);
        assert.equal(p.zbytek, 0, 'Položka z prodejny nesmí mít nedoplatek — id ' + p.id);
      });
      console.log('OK — ' + prodejnaPolozky.length + ' položek ze zdroje "prodejna" v TEST databázi, všechny bez výjimky "zaplaceno" a bez nedoplatku');
    }

    console.log('\n✅ VŠECHNY TESTY "PROVEDENÉ MASÁŽE" PROŠLY');
  } finally {
    for (const id of uklidRezervace) {
      await adminFetch(`/admin/rezervace/${id}`, { method: 'DELETE' }).catch(() => null);
    }
    for (const id of uklidPoukazy) {
      await adminFetch(`/admin/poukazy/${id}`, { method: 'DELETE' }).catch(() => null);
    }
    let klientkySmazano = 0;
    for (const id of uklidKlientky) {
      const r = await adminFetch(`/admin/klientky/${id}`, { method: 'DELETE' }).catch(() => null);
      if (r && r.ok) klientkySmazano++;
    }
    if (uklidRezervace.length || uklidPoukazy.length || uklidKlientky.size) {
      console.log(`(uklizeno: ${uklidRezervace.length} testovacích rezervací, ${uklidPoukazy.length} testovacích poukazů, ${klientkySmazano}/${uklidKlientky.size} testovacích klientek)`);
    }
  }
}

main().catch(e => { console.error('❌ TEST SELHAL:', e.message); process.exit(1); });
