-- Migrace: ochrana proti ztrátě evidence plateb/dokončených masáží při
-- mazání rezervace (viz DELETE /api/admin/rezervace/:id a rezervace č. 466,
-- která v produkci zmizela z evidence "Provedené masáže" beze stopy, beze
-- varování a bez auditu).
--
-- PŘIPRAVENO PRO POZDĚJŠÍ PRODUKČNÍ NASAZENÍ — ZATÍM NESPOUŠTĚT NA PRODUKCI.
-- Aplikováno a ověřeno zatím jen na TEST databázi.
--
-- Co migrace dělá (vše bezpečné spustit i opakovaně):
--  1) FK platby.rezervace_id: CASCADE → RESTRICT. Rezervaci s JAKOUKOLI
--     historií platby (i nulovou po úplném vrácení, i poukazovou) teď
--     nejde smazat ani přímým SQL příkazem, ne jen přes administraci.
--  2) Trigger "rezervace_bez_mazani_dokoncene": dokončenou rezervaci
--     (stav='dokoncena') nejde smazat vůbec, ani bez jakékoli platby — FK
--     samo o sobě "stav" neřeší, proto trigger.
--  3) Nová tabulka "rezervace_ochrana_udalosti" — append-only audit:
--     KAŽDÉ povolené trvalé smazání rezervace a KAŽDÝ přechod stavu PRYČ
--     z "dokoncena". Jen metadata (id, stavy, částka, čas), NIKDY osobní
--     údaje, BEZ FOREIGN KEY (přežije smazání objektu, na který odkazuje).
--
-- Vedlejší účinky a související vazby (prověřeno):
--  - "poukazy_historie.rezervace_id" už dnes má ON DELETE SET NULL (ne
--    CASCADE) — řádek historie čerpání poukazu PŘEŽÍVÁ smazání rezervace,
--    jen ztrácí konkrétní vazbu na ni. Žádná změna potřeba.
--  - Logika "vrátit zůstatek poukazu při smazání rezervace" uvnitř
--    DELETE /api/admin/rezervace/:id (server.js) se touhle migrací NEMĚNÍ,
--    ale stává se fakticky nedosažitelnou: rezervace s jakoukoli poukazovou
--    platbou má podle nové aplikační kontroly vždy JAKOUKOLI platbu, a tedy
--    je blokovaná dřív, než se k téhle části kódu dostane. To je ZÁMĚR, ne
--    vedlejší škoda — kód zůstává nedotčen pro čitelnost/historii.
--  - Nic jiného v schema.sql neodkazuje na rezervace(id) s ON DELETE CASCADE.
--
-- Žádné mazání ani přepisování historických dat — jen definice ochrany
-- a nová prázdná auditní tabulka.
--
-- Postup nasazení (až bude schváleno):
--   1. Záloha produkční databáze bezprostředně před migrací.
--   2. Spustit: psql "$DATABASE_URL" -f migrace_ochrana_mazani_rezervaci.sql
--      — výstup obsahuje kontroly PŘED i PO, projít je ručně.
--   3. Pokud cokoli selže → ZASTAVIT SE, nic dalšího nenasazovat.
--   4. Teprve POTOM nasadit nový server.js + admin.html společně (nový kód
--      bez migrace by hlásil chybu při DELETE, protože by nenašel nové
--      kontroly/audit tabulku zapsatelné — ve skutečnosti appka funguje i
--      bez migrace, jen by chyběla aplikační kontrola DB-level pojistky;
--      bezpečnější pořadí je ale stejně databáze první, jako u ostatních
--      migrací v tomhle projektu).

\set ON_ERROR_STOP on
set lock_timeout = '3s';

-- Kontrola PŘED migrací.
select conname, confdeltype from pg_constraint where conname = 'platby_rezervace_id_fkey';
select tgname from pg_trigger where tgname = 'rezervace_bez_mazani_dokoncene';
select exists(select 1 from information_schema.tables where table_name = 'rezervace_ochrana_udalosti') as tabulka_existuje;
select count(*) as pred_celkem_rezervaci from rezervace;
select count(*) as pred_celkem_plateb from platby;

begin;

alter table platby drop constraint if exists platby_rezervace_id_fkey;
alter table platby add constraint platby_rezervace_id_fkey
  foreign key (rezervace_id) references rezervace(id) on delete restrict;

create or replace function zkontrolovat_mazani_dokoncene_rezervace() returns trigger language plpgsql as $$
begin
  if OLD.stav = 'dokoncena' then
    raise exception 'Dokončenou masáž nelze trvale smazat (ztratila by se evidence provedené služby) — nejdřív změňte stav, pak smažte.';
  end if;
  return OLD;
end $$;
drop trigger if exists rezervace_bez_mazani_dokoncene on rezervace;
create trigger rezervace_bez_mazani_dokoncene before delete on rezervace
  for each row execute function zkontrolovat_mazani_dokoncene_rezervace();

create table if not exists rezervace_ochrana_udalosti (
  id serial primary key,
  rezervace_id integer not null,
  udalost text not null check (udalost in ('smazana', 'stav_zmenen_z_dokoncena')),
  stav_pred text,
  stav_po text,
  uhrazeno_pred numeric,
  mela_historii_plateb boolean not null default false,
  kdy timestamptz not null default now()
);

commit;

-- Kontrola PO migraci — "confdeltype" musí být 'r' (restrict), trigger musí
-- existovat, tabulka musí existovat, počty rezervací/plateb nesmí být
-- ovlivněny (žádná změna dat touhle migrací).
select conname, confdeltype from pg_constraint where conname = 'platby_rezervace_id_fkey';
select tgname from pg_trigger where tgname = 'rezervace_bez_mazani_dokoncene';
select exists(select 1 from information_schema.tables where table_name = 'rezervace_ochrana_udalosti') as tabulka_existuje;
select count(*) as po_celkem_rezervaci from rezervace;
select count(*) as po_celkem_plateb from platby;
