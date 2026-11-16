-- Migrace: přesun auditu "povolené smazání rezervace" a "přechod stavu pryč
-- z dokoncena" z appky (server.js) do databázových triggerů.
--
-- PŘEDPOKLAD: migrace_ochrana_mazani_rezervaci.sql už proběhla (existuje
-- tabulka rezervace_ochrana_udalosti, trigger rezervace_bez_mazani_dokoncene
-- a FK platby_rezervace_id_fkey je ON DELETE RESTRICT). Tahle migrace na to
-- navazuje, nenahrazuje ji.
--
-- PŘIPRAVENO PRO POZDĚJŠÍ PRODUKČNÍ NASAZENÍ — ZATÍM NESPOUŠTĚT NA PRODUKCI.
-- Aplikováno a ověřeno zatím jen na TEST databázi.
--
-- Důvod: appkový zápis auditu šlo obejít přímým SQL DELETE/UPDATE mimo
-- server.js (živě ověřeno — 0 nových auditních záznamů po přímém SQL
-- zásahu). Databázový trigger se spustí vždy, nezávisle na tom, jak ke
-- změně došlo (appka i přímý SQL). Zápis auditu je navíc součástí STEJNÉHO
-- příkazu jako samotná změna (standardní vlastnost triggerů) — selže-li
-- INSERT do auditu, celý příkaz (včetně DELETE/UPDATE rezervace) se vrátí
-- zpět, nemůže tedy nastat změna bez auditního záznamu. Žádná změna dat,
-- jen nové funkce/triggery — bezpečné spustit i opakovaně (CREATE OR
-- REPLACE / DROP TRIGGER IF EXISTS).
--
-- Odpovídající INSERTy v server.js byly ODSTRANĚNY (ne jen doplněny) — po
-- téhle migraci appka do rezervace_ochrana_udalosti už nezapisuje, jen čte
-- (GET /api/admin/rezervace-ochrana-udalosti). Nasazovat databázi a kód
-- tedy opět společně/koordinovaně (stejně jako u předchozích migrací),
-- jinak by starý kód ještě chvíli zapisoval duplicitně.

\set ON_ERROR_STOP on
set lock_timeout = '3s';

-- Kontrola PŘED migrací.
select tgname from pg_trigger where tgname in ('rezervace_audit_smazani', 'rezervace_audit_zmena_stavu');
select count(*) as pred_celkem_udalosti from rezervace_ochrana_udalosti;

begin;

create or replace function rezervace_audit_smazani() returns trigger language plpgsql as $$
declare
  v_pocet_plateb integer;
begin
  select count(*) into v_pocet_plateb from platby where rezervace_id = OLD.id;
  insert into rezervace_ochrana_udalosti (rezervace_id, udalost, stav_pred, stav_po, uhrazeno_pred, mela_historii_plateb)
  values (OLD.id, 'smazana', OLD.stav, null, OLD.uhrazeno, v_pocet_plateb > 0);
  return OLD;
end $$;
drop trigger if exists rezervace_audit_smazani on rezervace;
create trigger rezervace_audit_smazani after delete on rezervace
  for each row execute function rezervace_audit_smazani();

create or replace function rezervace_audit_zmena_stavu() returns trigger language plpgsql as $$
declare
  v_pocet_plateb integer;
begin
  if OLD.stav = 'dokoncena' and NEW.stav is distinct from OLD.stav then
    select count(*) into v_pocet_plateb from platby where rezervace_id = OLD.id;
    insert into rezervace_ochrana_udalosti (rezervace_id, udalost, stav_pred, stav_po, uhrazeno_pred, mela_historii_plateb)
    values (OLD.id, 'stav_zmenen_z_dokoncena', OLD.stav, NEW.stav, OLD.uhrazeno, v_pocet_plateb > 0);
  end if;
  return NEW;
end $$;
drop trigger if exists rezervace_audit_zmena_stavu on rezervace;
create trigger rezervace_audit_zmena_stavu after update on rezervace
  for each row execute function rezervace_audit_zmena_stavu();

commit;

-- Kontrola PO migraci — obě triggery musí existovat; počet řádků v auditu
-- se touhle migrací nesmí změnit (jen definice, žádný zápis dat).
select tgname from pg_trigger where tgname in ('rezervace_audit_smazani', 'rezervace_audit_zmena_stavu');
select count(*) as po_celkem_udalosti from rezervace_ochrana_udalosti;
