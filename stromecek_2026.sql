-- ══════════════════════════════════════════════════════════
-- Vánoční akce „Stromeček 2026“ — veřejný slevový kód STROMECEK2026
-- Spusť JEDNOU v Supabase: SQL Editor → New query → vložit celý soubor → Run.
-- Jde spustit i opakovaně (nic nesmaže, jen doplní chybějící).
-- Stejný blok je přidaný i na konec schema.sql (pro nové instalace).
--
-- Pravidla:
--  - kód je veřejný (na stránce stromečku), sleva se odečte jen při uložené
--    rezervaci nebo žádosti o poukaz z webu
--  - jedna sleva na rezervaci / poukaz, strop 50 použití (počítá se jen 'pouzito')
--  - akce začíná 30. 11. 2026 0:00 a končí 31. 12. 2026 23:59
--  - záznamy o využití se NIKDY nemažou — storno = status 'vraceno'
--  - tabulka využití nedrží žádné osobní údaje (jen odkaz na rezervaci/žádost),
--    takže se jí retence/anonymizace nemusí týkat
-- ══════════════════════════════════════════════════════════

-- Akce se slevovým kódem (jeden řádek = jeden veřejný kód)
create table if not exists promo_kody (
  kod text primary key,               -- velkými písmeny, bez diakritiky (STROMECEK2026)
  nazev text,
  sleva_kc numeric not null check (sleva_kc > 0),
  plati_od timestamptz,               -- NULL = hned
  plati_do timestamptz not null,      -- do kdy musí být rezervace / žádost o poukaz vytvořená
  strop integer check (strop is null or strop >= 0), -- max. počet použití (NULL = bez limitu)
  aktivni boolean not null default true, -- ruční pauza z administrace
  vytvoreno timestamptz not null default now()
);

insert into promo_kody (kod, nazev, sleva_kc, plati_od, plati_do, strop)
values ('STROMECEK2026', 'Vánoční stromeček na náměstí 2026', 100,
        '2026-11-30 00:00:00 Europe/Prague', '2026-12-31 23:59:59 Europe/Prague', 50)
on conflict (kod) do nothing;

do $$ begin
  create type promo_status as enum ('pouzito', 'vraceno');
exception when duplicate_object then null;
end $$;

-- Každé použití kódu. Bez FK na rezervace/poukazy_zadosti — záznam musí přežít
-- i smazání rezervace/žádosti (účetní historie), proto jen holé id.
create table if not exists promo_poukaz_vyuziti (
  id serial primary key,
  kod text not null references promo_kody(kod) on update cascade,
  typ text not null check (typ in ('rezervace', 'poukaz')), -- poukaz = žádost o poukaz z webu
  objednavka_id integer,              -- rezervace.id nebo poukazy_zadosti.id
  cena_puvodni numeric not null,
  sleva_kc numeric not null check (sleva_kc > 0),
  status promo_status not null default 'pouzito',
  vytvoreno timestamptz not null default now(),
  vraceno_kdy timestamptz,
  poznamka text
);
create index if not exists promo_vyuziti_objednavka on promo_poukaz_vyuziti (typ, objednavka_id);
create index if not exists promo_vyuziti_kod_status on promo_poukaz_vyuziti (kod, status);

-- Pojistka: záznamy o využití nejde smazat ani omylem
create or replace function promo_zakaz_mazani() returns trigger language plpgsql as $$
begin
  raise exception 'Záznamy o využití slevového kódu se nemažou – změň status na ''vraceno''.';
end $$;
drop trigger if exists promo_vyuziti_bez_mazani on promo_poukaz_vyuziti;
create trigger promo_vyuziti_bez_mazani before delete on promo_poukaz_vyuziti
  for each row execute function promo_zakaz_mazani();

-- Sleva u rezervace / žádosti / poukazu (snímek, stejně jako cena)
alter table rezervace       add column if not exists sleva_kc numeric not null default 0;
alter table rezervace       add column if not exists promo_kod text;
alter table poukazy_zadosti add column if not exists sleva_kc numeric not null default 0;
alter table poukazy_zadosti add column if not exists promo_kod text;
-- poukaz má dál plnou hodnotu (zůstatek), sleva_kc říká, o kolik méně se za něj
-- zaplatilo — účetnictví počítá prodej poukazu jako hodnota - sleva_kc
alter table poukazy         add column if not exists sleva_kc numeric not null default 0;

alter table promo_kody           enable row level security;
alter table promo_poukaz_vyuziti enable row level security;
