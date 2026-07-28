-- ══════════════════════════════════════════════════════════
-- Masáže Alesa — databázové schéma pro Supabase (PostgreSQL)
-- Spusť celé v Supabase → SQL Editor → New query → Run
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
  poradi_skupiny integer not null default 0,
  poradi_varianty integer not null default 0
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
  stav text not null default 'cekajici', -- cekajici | potvrzena | zrusena
  vytvoreno timestamptz not null default now()
);

-- Prodeje na místě v salónu (klientka bez rezervace, platí hned)
create table if not exists prodeje (
  id serial primary key,
  masaz text not null,
  cena numeric not null,
  zpusob_platby text not null default 'hotove', -- hotove | qr
  poznamka text,
  vytvoreno timestamptz not null default now()
);

-- Varianty poukazů, které lze vydat (částka + doba platnosti) — upravuje si Alena v adminu
create table if not exists poukazy_typy (
  id serial primary key,
  hodnota numeric not null,
  platnost_mesicu integer not null default 12,
  poradi integer not null default 0
);
insert into poukazy_typy (hodnota, platnost_mesicu, poradi) values
  (500, 3, 1),
  (1000, 6, 2),
  (1500, 12, 3),
  (2000, 12, 4)
on conflict do nothing;

-- Vydané dárkové poukazy
create table if not exists poukazy (
  id serial primary key,
  kod text not null unique,
  ean text unique, -- čárový kód (EAN-13) pro naskenování při uplatnění v salonu
  hodnota numeric not null,
  zustatek numeric not null,
  platnost_do date not null,
  zakoupeno_kde text not null default 'web', -- web | osobne
  kupujici_jmeno text,
  kupujici_email text,
  kupujici_telefon text,
  pro_koho text,
  konkretni_masaz text, -- nepovinné: pokud poukaz platí jen na jednu konkrétní masáž, ne na libovolnou částku
  stav text not null default 'aktivni', -- aktivni | pouzity | zruseny
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
  stav text not null default 'nova', -- nova | vyrizena | zamitnuta
  vytvoreno timestamptz not null default now()
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
on conflict do nothing;

-- Row Level Security: zapnuto, ale veškerý přístup jde přes backend
-- (service role klíč obchází RLS), takže z prohlížeče napřímo nikdo nic nepřečte/nezapíše
alter table pracovni_doba enable row level security;
alter table rezervace enable row level security;
alter table cenik enable row level security;
alter table poukazy_typy enable row level security;
alter table poukazy enable row level security;
alter table poukazy_zadosti enable row level security;
alter table prodeje enable row level security;
