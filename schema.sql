-- ══════════════════════════════════════════════════════════
-- Masáže Alesa — databázové schéma pro vlastní PostgreSQL
-- Spusť celé přes psql nebo jiného klienta připojeného k databázi
-- (např. psql -U uzivatel -d masaze_alesa -f schema.sql)
--
-- Pokud jsi předtím spustila starší verzi tohoto souboru, spusť
-- nejdřív (smaže staré tabulky a data v nich):
--   drop table if exists rezervace_sloty cascade;
--   drop table if exists rezervace cascade;
--   drop table if exists cenik cascade;
-- a pak teprve tenhle celý soubor.
-- ══════════════════════════════════════════════════════════

-- Pracovní doba — nastavuje si Alena sama v adminu (den v týdnu: 0=neděle...6=sobota)
create table if not exists pracovni_doba (
  den_v_tydnu integer primary key,
  otevreno_od time not null,
  otevreno_do time not null,
  pauza_od time, -- nepovinné: polední pauza, kdy nelze rezervovat
  pauza_do time,
  aktivni boolean not null default true
);
insert into pracovni_doba (den_v_tydnu, otevreno_od, otevreno_do, aktivni) values
  (0, '09:00', '17:00', false), -- neděle
  (1, '09:00', '17:00', true),  -- pondělí
  (2, '09:00', '17:00', true),
  (3, '09:00', '17:00', true),
  (4, '09:00', '17:00', true),
  (5, '09:00', '17:00', true),
  (6, '09:00', '13:00', false)  -- sobota
on conflict (den_v_tydnu) do nothing;

-- Obecná nastavení klíč→hodnota (např. mezera mezi masážemi na úklid/vyvětrání)
create table if not exists nastaveni (
  klic text primary key,
  hodnota text not null
);
insert into nastaveni (klic, hodnota) values ('buffer_minut', '30') on conflict (klic) do nothing;
-- Fáze 5B, nepovinné klíče (chybí-li řádek, chová se to jako výchozí hodnota
-- níže — proto se pro ně záměrně NEVKLÁDÁ žádný řádek při nasazení):
--   pripominky_zapnuto           'false' vypne odesílání připomínek; cokoliv jiné (i chybějící) = zapnuto
--   pripominka_predstih_hodin    kolik hodin předem se má připomínka poslat (výchozí 24, platný rozsah 1–168)

-- Jednorázové výjimky provozu (dovolená, svátek) — blokují celý den(y) mimo týdenní rozvrh
-- otevreno_od/otevreno_do nepovinné: když jsou vyplněné, výjimka pro dané dny
-- nastaví vlastní otevírací dobu (např. jeden den v měsíci delší otevřeno)
-- místo běžného týdenního rozvrhu. Bez nich = celý den zavřeno (dovolená/svátek).
create table if not exists provozni_vyjimky (
  id serial primary key,
  datum_od date not null,
  datum_do date not null,
  popis text,
  otevreno_od time,
  otevreno_do time,
  vytvoreno timestamptz not null default now()
);

-- Ceník — každá masáž (skupina) může mít víc variant (různá délka/rozsah/cena)
-- Zobrazuje se na webu i v adminu; cokoliv tu upravíš, propíše se rovnou na web.
create table if not exists cenik (
  id serial primary key,
  skupina text not null,        -- název masáže, např. "Rekondiční masáž"
  emoji text not null default '💆',
  varianta text not null,       -- např. "Záda + šíje"
  delka_min integer not null,
  cena integer not null,
  rezervovatelna boolean not null default true, -- false = jen se zobrazí v ceníku, nejde na ni rezervovat (např. kineziotaping)
  aktivni boolean not null default true, -- false = skryto z veřejného webu i z nabídky pro nové rezervace/rychlý prodej, ale zůstává v adminu pro historické (dřív založené) rezervace se starou cenou
  poradi_skupiny integer not null default 0,
  poradi_varianty integer not null default 0,
  unique (skupina, varianta, delka_min)
);

-- Jednotlivé rezervace klientek — termín se počítá dynamicky (datum + čas + délka masáže z ceníku)
create table if not exists rezervace (
  id serial primary key,
  cenik_id integer references cenik(id) on delete set null,
  datum date not null,
  cas_od time not null,
  cas_do time not null, -- dopočteno: cas_od + délka masáže z ceníku
  jmeno text not null,
  telefon text not null,
  email text,
  masaz text not null, -- snímek názvu v době rezervace (skupina + varianta), pro případ že se ceník později změní
  cena numeric, -- snímek ceny v okamžiku rezervace (pro účetnictví)
  poznamka text,
  poukaz_kod text, -- nepovinné: kód dárkového poukazu, který chce zákaznice uplatnit na místě
  stav text not null default 'cekajici', -- cekajici | potvrzena | dokoncena | nedostavila_se | zrusena
  pripomenuto boolean not null default false, -- už úspěšně odeslána připomínka (ať se neposílá vícekrát)
  pripomenuto_pokus_kdy timestamptz, -- Fáze 5B: kdy naposledy začal pokus o odeslání připomínky (atomické
    -- "claimnutí" proti duplicitě při souběžném volání cron endpointu — viz komentář
    -- u /api/cron/denni). Claim starší než 10 minut se bere jako zaseklý a smí se převzít.
    -- NULL = žádný rozdělaný pokus.
  pozadano_recenze boolean not null default false, -- už odeslána žádost o recenzi
  -- Platba je záměrně oddělená od stavu rezervace (stav) — dokončená masáž může
  -- být nezaplacená a naopak. uhrazeno je průběžný součet (podporuje částečnou
  -- platbu, např. poukaz + doplatek hotově), stav_platby se z něj dopočítává.
  stav_platby text not null default 'nezaplaceno', -- nezaplaceno | castecne_zaplaceno | zaplaceno
  zpusob_platby text, -- hotove | kartou | online | poukaz — vždy způsob POSLEDNÍ transakce v "platby"
  uhrazeno numeric not null default 0, -- vždy = SUM(platby.castka) pro tuhle rezervaci, viz níž
  uhrazeno_kdy timestamptz, -- nastaveno, jen když je stav_platby právě teď "zaplaceno" (jinak null)
  vytvoreno timestamptz not null default now(),
  klientka_id integer -- Fáze 6D: vazba na klientky(id), FK přidaná až níž (tabulka klientky
    -- v souboru vzniká později) — nullable, jmeno/telefon/email tu ZŮSTÁVAJÍ jako
    -- snímek z okamžiku rezervace, klientka_id je jen navíc pro CRM
);

-- Deník jednotlivých plateb a vratek k rezervaci (Fáze 3B). rezervace.uhrazeno/
-- stav_platby/zpusob_platby/uhrazeno_kdy zůstávají jako rychlý dopočtený souhrn
-- (vždy přepočtený z tohohle deníku ve stejné transakci, nikdy se nerozejdou) —
-- ale historie jednotlivých plateb (kdy, kolik, jak) žije jen tady.
create table if not exists platby (
  id serial primary key,
  rezervace_id integer not null references rezervace(id) on delete cascade,
  castka numeric not null, -- kladná = platba, záporná = vratka (viz typ níž)
  typ text not null, -- platba | vratka
  zpusob_platby text not null, -- hotove | kartou | online | poukaz
  poukaz_id integer, -- vyplněno jen když zpusob_platby = 'poukaz'; FK na poukazy(id) přidána
    -- až níž přes ALTER TABLE (tabulka "poukazy" v souboru vzniká až POZDĚJI —
    -- stejný důvod a stejný princip jako u klientka_id, viz komentář u FK bloku níž)
  vytvoreno timestamptz not null default now(),
  check ((typ = 'platba' and castka > 0) or (typ = 'vratka' and castka < 0))
);

-- Prodeje na místě v salónu (klientka bez rezervace, platí hned)
create table if not exists prodeje (
  id serial primary key,
  masaz text not null,
  cena numeric not null,
  zpusob_platby text not null default 'hotove', -- hotove | qr | poukaz
  poznamka text,
  poukaz_id integer, -- vyplněno jen při platbě poukazem; FK na poukazy(id) přidána
    -- až níž (tabulka "poukazy" vzniká až POZDĚJI — stejný princip jako u
    -- platby.poukaz_id, viz komentář u FK bloku níž)
  poukaz_castka numeric, -- kolik z "cena" bylo kryto poukazem (může být míň než
    -- cena — poukaz nemusí pokrýt celou částku, zbytek platí zpusob_platby)
  vytvoreno timestamptz not null default now()
);

-- Varianty poukazů, které lze vydat (částka + doba platnosti) — upravuje si Alena v adminu
create table if not exists poukazy_typy (
  id serial primary key,
  hodnota numeric not null,
  platnost_mesicu integer not null default 12,
  poradi integer not null default 0,
  unique (hodnota, platnost_mesicu)
);
insert into poukazy_typy (hodnota, platnost_mesicu, poradi) values
  (500, 12, 1),
  (1000, 12, 2),
  (1500, 12, 3)
on conflict (hodnota, platnost_mesicu) do nothing;

-- Vydané dárkové poukazy
create table if not exists poukazy (
  id serial primary key,
  kod text not null unique,
  ean text unique, -- nevyužívané od zrušení skenování čárových kódů — sloupec zůstává jen pro starší poukazy, které ho mají vyplněný
  hodnota numeric not null,
  zustatek numeric not null,
  platnost_do date not null,
  zakoupeno_kde text not null default 'web', -- web | osobne | vratka (vznikl jako vratka platby za rezervaci)
  kupujici_jmeno text,
  kupujici_email text,
  kupujici_telefon text,
  pro_koho text,
  konkretni_masaz text, -- nepovinné: pokud poukaz platí jen na jednu konkrétní masáž, ne na libovolnou částku
  zpusob_platby text, -- qr | prevodem | pri_prevzeti | hotove (nepovinné, jen u poukazů z webu)
  stav text not null default 'aktivni', -- aktivni | castecne_vyuzity | pouzity | zruseny
  -- "prošlý" se nikde neukládá jako stav — dopočítává se za běhu z platnost_do,
  -- ať je vždy aktuální bez nutnosti plánované úlohy, která by stav přepínala.
  ucel text not null default 'prodej', -- prodej (skutečně zaplacený, počítá se do tržeb) | dar (např. tombola, žádné peníze — do tržeb se nepočítá) | vratka (vznikl jako vratka platby za rezervaci — taky se do tržeb nepočítá)
  vytvoreno timestamptz not null default now(),
  klientka_id integer, -- Fáze 6D: vazba na klientky(id), nullable — poukaz bez kupujici_telefon
    -- zůstává klientka_id NULL (nelze bezpečně určit), kupujici_* pole ZŮSTÁVAJÍ jako snímek
  uzavreno_kdy timestamptz -- Fáze 7G.3: kdy poukaz naposledy přešel do 'pouzity'/'zruseny'
    -- (nastaveno ve stejném UPDATE jako změna stavu) — NULL, dokud poukaz nebyl nikdy
    -- uzavřen, nebo po návratu zpět do 'aktivni'/'castecne_vyuzity'. Retenční engine
    -- (viz retence_udalosti) počítá stáří uzavřeného poukazu VÝHRADNĚ z tohoto sloupce,
    -- nikdy z "vytvoreno" (to je okamžik vydání, ne uzavření — viz audit Fáze 7G.2A).
    -- Poukaz s uzavreno_kdy IS NULL a stav IN ('pouzity','zruseny') je historický
    -- řádek bez známého okamžiku uzavření — retenční engine ho vždy přeskočí.
);

-- Fáze 6D: skutečná klientská entita s vlastním id — nahrazuje telefon jako
-- identitu (viz audit/návrh Fáze 6C). Starší tabulka "zakaznici" (klíčovaná
-- přímo telefonem, s odvozeným sloučením podle rezervací/poukazů) byla po
-- ověřeném přechodu odstraněna ve Fázi 7B.2 — "klientky" je jediný zdroj
-- pravdy pro CRM (jméno/kontakt/alergie/preference/poznámka) a napojuje se
-- na rezervace a poukazy přes klientka_id (viz FK níž).
create table if not exists klientky (
  id serial primary key,
  jmeno text,
  telefon text, -- RAW hodnota přesně tak, jak ji klientka/admin zadali — jen pro zobrazení
  telefon_normalizovany text, -- jen číslice, tuzemská předvolba (420/00420) oříznutá — skutečný identifikační klíč
  email text,
  email_normalizovany text, -- lowercase + trim, pro case-insensitive hledání/shodu — NENÍ unique (víc klientek smí sdílet e-mail)
  poznamka text,
  alergie text,
  preference text,
  aktivni boolean not null default true, -- příprava na budoucí "deaktivaci" bez mazání (GDPR, řeší až pozdější fáze)
  anonymizovano_kdy timestamptz, -- NULL dokud neproběhla anonymizace (GDPR, řeší až pozdější fáze)
  marketing_odhlasen boolean not null default false, -- true = klientka se odhlásila z hromadných e-mailů (odkaz v každé zprávě)
  marketing_odhlasovaci_token text, -- generuje se lazy při prvním hromadném e-mailu (crypto.randomBytes), ne hned při vzniku klientky
  vytvoreno timestamptz not null default now(),
  upraveno timestamptz not null default now()
);
create unique index if not exists klientky_telefon_normalizovany_key
  on klientky (telefon_normalizovany) where telefon_normalizovany is not null;

-- FK přidané až tady přes ALTER TABLE — buď proto, že cílová tabulka v souboru
-- vzniká POZDĚJI než tabulka, která na ni odkazuje (platby → poukazy, viz
-- komentář u sloupce poukaz_id výš), nebo je to stejný princip použitý
-- konzistentně i tam, kde by inline FK teoreticky šlo (rezervace/poukazy →
-- klientky) — ať jsou všechny "dodatečné" FK vazby pohromadě na jednom místě.
-- ON DELETE SET NULL: i budoucí smazání klientky/poukazu nesmí smazat/poškodit
-- historickou rezervaci ani účetní záznam, jen ztratí vazbu na (už neexistující)
-- klientku/poukaz.
-- Poznámka: "ADD CONSTRAINT IF NOT EXISTS" v PostgreSQL neexistuje (na rozdíl
-- od "ADD COLUMN IF NOT EXISTS" výš) — tenhle soubor se ale spouští jen jednou
-- na čerstvou databázi (viz hlavička souboru), takže prosté ADD CONSTRAINT stačí.
alter table rezervace add constraint rezervace_klientka_id_fkey
  foreign key (klientka_id) references klientky(id) on delete set null;
alter table poukazy add constraint poukazy_klientka_id_fkey
  foreign key (klientka_id) references klientky(id) on delete set null;
alter table platby add constraint platby_poukaz_id_fkey
  foreign key (poukaz_id) references poukazy(id) on delete set null;
alter table prodeje add constraint prodeje_poukaz_id_fkey
  foreign key (poukaz_id) references poukazy(id) on delete set null;

-- Audit stopa čerpání dárkových poukazů (append-only) — zaznamenává KAŽDÉ
-- snížení zůstatku, ať je navázané na rezervaci, prodej na místě, nebo žádné
-- z obou (dřív se tenhle poslední případ nikam nezapisoval — poukaz šel
-- uplatnit bez návázání na cokoliv a jediná stopa byl nižší zůstatek, bez
-- data/částky/důvodu). "poukazy" i "rezervace"/"prodeje" už existují výš,
-- takže FK jde rovnou inline, bez odkladu přes ALTER TABLE.
create table if not exists poukazy_historie (
  id serial primary key,
  poukaz_id integer not null references poukazy(id) on delete cascade,
  castka numeric not null, -- vždy kladná = čerpaná částka
  rezervace_id integer references rezervace(id) on delete set null,
  prodej_id integer references prodeje(id) on delete set null,
  vytvoreno timestamptz not null default now()
);

-- Jednorázové slevové kupóny na konkrétní marketingovou akci (např. "100 Kč
-- sleva na první masáž") — záměrně ODDĚLENO od dárkových poukazů (jiný účel:
-- žádná hodnota/zůstatek k čerpání po částech, jen jednorázové "použito/ne").
-- Uplatňuje se jen osobně v salonu přes "Rychlý prodej", ne online.
create table if not exists slevove_kupony (
  id serial primary key,
  kod text not null unique,
  nazev_akce text not null,
  sleva_castka numeric not null,
  pouzito_kdy timestamptz, -- NULL = ještě nepoužitý
  vydano_kdy timestamptz, -- NULL = ještě fyzicky nevydaný (ruční evidence majitelky)
  vytvoreno timestamptz not null default now()
);

-- Žádosti o poukaz z veřejného webového formuláře
create table if not exists poukazy_zadosti (
  id serial primary key,
  hodnota numeric not null,
  kupujici_jmeno text not null,
  kupujici_email text not null,
  kupujici_telefon text,
  pro_koho text,
  vzkaz text,
  konkretni_masaz text, -- nepovinné: pokud si nezvolili částku, ale konkrétní masáž
  zpusob_platby text, -- qr | prevodem | pri_prevzeti
  platnost_mesicu integer, -- snímek z poukazy_typy.platnost_mesicu v době žádosti; NULL = konkrétní masáž (při schválení se použije 12)
  stav text not null default 'nova', -- nova | vyrizena | zamitnuta
  vytvoreno timestamptz not null default now()
);

-- Odběratelky newsletteru z formuláře na webu ("Tipy a novinky přímo do e-mailu")
create table if not exists newsletter_odberatele (
  id serial primary key,
  email text not null unique,
  jmeno text,
  odhlasovaci_token text not null unique,
  aktivni boolean not null default true,
  odhlaseno_kdy timestamptz, -- Fáze 7D.2B: kdy došlo k poslednímu odhlášení (NULL, pokud se
    -- odběratelka nikdy neodhlásila, nebo se od odhlášení znovu přihlásila — viz server.js)
  vytvoreno timestamptz not null default now()
);

-- Historie newsletterů odeslaných z administrace (jen pro přehled, ne fronta)
create table if not exists newsletter_zpravy (
  id serial primary key,
  predmet text not null,
  obsah text not null,
  pocet_prijemcu integer not null default 0,
  odeslano timestamptz not null default now()
);

-- Fáze 7D.2B: auditní stopa pro anonymizaci klientek (GDPR) — append-only,
-- zaznamenává jen METADATA události (kdy, jaký typ), nikdy osobní údaje.
-- Záměrně BEZ FOREIGN KEY na klientky(id) — záznam musí přežít i případné
-- budoucí fyzické smazání klientky, ne se s ním ztratit (viz audit Fáze 7D.1).
-- Sloupec "kdo" akci provedl záměrně chybí — aplikace má jediné sdílené
-- ADMIN_HESLO (ne účty jednotlivých osob), takže by šlo jen o pevný řetězec
-- bez informační hodnoty navíc.
create table if not exists klientky_udalosti (
  id serial primary key,
  klientka_id integer not null,
  udalost text not null, -- zatím jediná hodnota: 'anonymizovano'
  kdy timestamptz not null default now()
);

-- Fáze 9E: Produkty a sklad (doplňkový prodej v salonu — oleje, čaje,
-- kosmetika...). "skupina"/"varianta" je stejný vzor jako u ceníku (jeden
-- konkrétní produkt/velikost/vůně = jeden řádek s vlastním skladem, žádná
-- samostatná hierarchie kategorií).
create table if not exists produkty (
  id serial primary key,
  skupina text not null,         -- např. "Masážní olej"
  varianta text not null,        -- např. "Levandule 100ml"
  cena numeric not null,         -- prodejní cena za kus
  nakupni_cena numeric,          -- pořizovací cena za kus (nepovinné, jen pro orientační marži)
  dodavatel text,                -- nepovinné
  sklad integer not null default 0,       -- aktuální počet kusů skladem (mění se JEN přes prodej/naskladnění, nikdy ručně)
  minimalni_sklad integer,       -- nepovinné; sklad <= tahle hodnota => denní e-mailové upozornění
  aktivni boolean not null default true,  -- false = skrytý v nabídce k prodeji, historie zůstává
  vytvoreno timestamptz not null default now()
);

-- Prodej produktu klientce — snižuje produkty.sklad, zaznamenává tržbu
-- (odděleně od "prodeje", což jsou masáže na místě bez rezervace — produkt
-- není služba, viz Účetnictví kategorie "Prodej produktů").
create table if not exists prodeje_produktu (
  id serial primary key,
  produkt_id integer not null references produkty(id) on delete restrict,
  nazev text not null,           -- snímek "skupina – varianta" v době prodeje
  mnozstvi integer not null,
  cena_za_kus numeric not null,  -- snímek prodejní ceny v době prodeje
  cena_celkem numeric not null,
  zpusob_platby text not null default 'hotove', -- hotove | kartou | online
  vytvoreno timestamptz not null default now(),
  check (mnozstvi > 0)
);

-- Naskladnění (nákup od dodavatele) — zvyšuje produkty.sklad. Samostatný
-- log, ne ruční přepsání čísla, ať zůstane dohledatelná historie pohybů.
create table if not exists naskladneni_produktu (
  id serial primary key,
  produkt_id integer not null references produkty(id) on delete restrict,
  mnozstvi integer not null,
  nakupni_cena_celkem numeric,
  dodavatel text,
  poznamka text,
  vytvoreno timestamptz not null default now(),
  check (mnozstvi > 0)
);

-- Fáze 9C: editovatelné e-mailové šablony. "klic" odpovídá pevné sadě ve
-- server.js (VYCHOZI_SABLONY) — řádek tu existuje, jen když ho admin někdy
-- upravil; dokud neexistuje, používá se vestavěný výchozí text (žádný seed
-- řádek tu záměrně není, ať je na první pohled vidět, co admin skutečně
-- změnil oproti výchozímu stavu).
create table if not exists email_sablony (
  klic text primary key,
  predmet text not null,
  telo text not null,
  upraveno timestamptz not null default now()
);

-- Fáze 7D.2B/7G.3: klíče v "nastaveni" pro retenční engine (viz
-- ziskatRetenciNastaveni v server.js a tabulka retence_udalosti níž) —
-- záměrně se sem NEVKLÁDÁ žádný řádek/výchozí hodnota, dokud nejsou lhůty
-- právně/účetně ověřené (viz audit Fáze 7D.1/7D.2A/7E/7G.1/7G.2). Chybějící
-- (nebo neplatný/<=0) klíč se NESMÍ nikde v aplikaci vykládat jako "0 dní"
-- nebo jako implicitní souhlas s automatickou anonymizací — dokud klíč
-- neexistuje jako platné kladné celé číslo, daná kategorie se retenčním
-- enginem vůbec nezpracovává (fail-closed, viz server.js):
--   retence_rezervace_dokoncena_dny    (hodnota musí být stanovena po právním/účetním ověření)
--   retence_rezervace_zrusena_dny      (hodnota musí být stanovena po právním/účetním ověření)
--   retence_rezervace_nedostavila_dny  (hodnota musí být stanovena po právním/účetním ověření)
--   retence_poukazy_uzavrene_dny       (hodnota musí být stanovena po právním/účetním ověření)
--   retence_poukazy_expirovane_dny     (hodnota musí být stanovena po právním/účetním ověření)
--   retence_zadosti_dny                (hodnota musí být stanovena po právním/účetním ověření)
--   retence_newsletter_dny             (hodnota musí být stanovena po právním/účetním ověření)

-- Fáze 7G.3: auditní stopa retenčního enginu — SAMOSTATNÁ od klientky_udalosti
-- (ta beze změny zůstává jen pro ruční anonymizaci klientky přes
-- POST /api/admin/klientky/:id/anonymizovat, viz audit 7G.2A/7G.2). Tahle
-- tabulka eviduje KAŽDOU skutečně provedenou retenční anonymizaci — klientky,
-- rezervace, poukazu, žádosti i newsletteru, nezávisle na sobě (Varianta A,
-- nezávislá retence historických objektů, schváleno 7G.2A). Append-only,
-- jen metadata, nikdy osobní údaje. Záměrně BEZ FOREIGN KEY na klientky(id)
-- ani na cílové tabulky — záznam musí přežít i budoucí fyzické smazání
-- objektu, ne se s ním ztratit (stejný princip jako klientky_udalosti).
create table if not exists retence_udalosti (
  id serial primary key,
  objekt_typ text not null check (objekt_typ in ('klientka','rezervace','poukaz','zadost','newsletter')),
  objekt_id integer not null,
  klientka_id integer, -- nullable — u 'zadost'/'newsletter' vazba na klientku neexistuje (viz schema poukazy_zadosti/newsletter_odberatele)
  udalost text not null, -- zatím jediná hodnota: 'anonymizovano'
  spousteno text not null check (spousteno in ('rucne','automaticky')),
  dry_run boolean not null default false, -- vždy false — skutečný (ne dry-run) zápis; sloupec existuje jen pro budoucí rozšiřitelnost, dry-run do této tabulky nikdy nezapisuje
  duvod text, -- např. 'retence_rezervace_dokoncena_dny'
  kdy timestamptz not null default now()
);

-- Počáteční ceník podle skutečného obsahu webu
insert into cenik (skupina, emoji, varianta, delka_min, cena, rezervovatelna, poradi_skupiny, poradi_varianty) values
  ('Rekondiční masáž', '💪', 'Záda + šíje', 45, 630, true, 1, 1),
  ('Rekondiční masáž', '💪', 'Záda + šíje + rašelinový zábal', 60, 840, true, 1, 2),
  ('Rekondiční masáž', '💪', 'Částečná (nohy zezadu, záda, šíje)', 60, 800, true, 1, 3),
  ('Rekondiční masáž', '💪', 'Celková + rašelinový zábal', 90, 1190, true, 1, 4),

  ('Masáž lávovými kameny', '🔥', 'Záda + šíje', 45, 720, true, 2, 1),
  ('Masáž lávovými kameny', '🔥', 'Záda + dolní končetiny', 60, 960, true, 2, 2),
  ('Masáž lávovými kameny', '🔥', 'Celková', 100, 1600, true, 2, 3),

  ('Masáž pro těhotné', '🤰', 'Částečná (záda + šíje)', 30, 420, true, 3, 1),
  ('Masáž pro těhotné', '🤰', 'Celková', 60, 840, true, 3, 2),

  ('Konopná úleva', '🌿', 'Záda + šíje', 45, 765, true, 4, 1),
  ('Konopná úleva', '🌿', 'Částečná (nohy zezadu, záda, šíje)', 60, 960, true, 4, 2),

  ('Medové snění', '🍯', 'Celková procedura (2× nanesení medu + zábal)', 60, 960, true, 5, 1),

  ('Kineziotaping', '🩹', 'Při masáži – aplikace ZDARMA (materiál 5 Kč/cm)', 0, 0, false, 6, 1),
  ('Kineziotaping', '🩹', 'Samostatně (do 30 min, + 150 Kč/dalších 30 min + materiál)', 30, 150, false, 6, 2)
on conflict (skupina, varianta, delka_min) do nothing;

-- Poznámka k zabezpečení: databáze není přístupná z prohlížeče — s ní mluví jen
-- backend (server.js) přes DATABASE_URL, takže cizí čtení/zápis jde jen přes API
-- chráněné heslem (x-admin-heslo). Řádkové zabezpečení (RLS) tu záměrně není —
-- to dává smysl jen u Supabase, kde databáze byla přímo za veřejným REST API.
