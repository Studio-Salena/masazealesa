-- Krok 3a přípravy na EET 2.0: databázový základ (evidované tržby).
--
-- Čistě aditivní migrace — žádná existující tabulka se nemění, žádná
-- historická data se nepřepisují, NIC z tohoto není napojené na žádný
-- existující platební endpoint (to je vyhrazené pro samostatně schvalovaný
-- Krok 3b). Vytváří jen nové tabulky, sekvenci, funkce a 2 nové řádky v
-- "nastaveni" (eet_aktivovano_od='', eet_odesilani_pozastaveno='true').
--
-- Bezpečné spustit opakovaně (idempotentní — "if not exists"/"or replace"
-- všude). Žádný řádek v žádné existující tabulce se touto migrací nemění.

\set ON_ERROR_STOP on
set lock_timeout = '3s';

\echo '--- PŘED: nové tabulky zatím nemají existovat ---'
select table_name from information_schema.tables
  where table_schema = 'public'
    and table_name in ('evidovana_trzba','evidovana_trzba_zdroje','eet_odeslani','eet_pripojeni_test','evidovana_trzba_audit');

\echo '--- PŘED: počty řádků existujících tabulek (pro ověření, že migrace nic nesmaže/nepřidá) ---'
select
  (select count(*) from platby) as pred_platby,
  (select count(*) from poukazy) as pred_poukazy,
  (select count(*) from prodeje) as pred_prodeje,
  (select count(*) from prodeje_produktu) as pred_prodeje_produktu,
  (select count(*) from nastaveni) as pred_nastaveni;

begin;

create sequence if not exists eet_porad_cis_seq start 1;

create table if not exists evidovana_trzba (
  id serial primary key,
  pokladni_udalost_id uuid not null unique,
  smer text not null check (smer in ('prijem','storno')),
  celk_trzba numeric not null default 0
    check ((smer = 'prijem' and celk_trzba >= 0) or (smer = 'storno' and celk_trzba <= 0)),
  urceno_cerp_zuct numeric,
  cerp_zuct numeric,
  id_jednotky text not null,
  id_pokl text not null,
  porad_cis text not null default ('ET-' || nextval('eet_porad_cis_seq')::text),
  dat_trzby timestamptz not null,
  stav_evidence text not null default 'nova'
    check (stav_evidence in ('nova','odeslano','potvrzeno','chyba','nejiste','rucne_vyreseno')),
  zpracovava_se_od timestamptz,
  zpracovava_worker_id text,
  aktualni_pokus_id uuid,
  poznamka_rucniho_vyreseni text,
  vytvoreno timestamptz not null default now(),
  unique (id_jednotky, id_pokl, porad_cis, dat_trzby)
);
create index if not exists evidovana_trzba_fronta_idx on evidovana_trzba (stav_evidence, zpracovava_se_od);

create table if not exists evidovana_trzba_zdroje (
  id serial primary key,
  evidovana_trzba_id integer not null references evidovana_trzba(id),
  zdroj_typ text not null check (zdroj_typ in ('platba','poukaz_historie','prodej','prodej_produktu')),
  zdroj_id integer not null,
  castka numeric not null,
  vytvoreno timestamptz not null default now(),
  unique (zdroj_typ, zdroj_id)
);

create table if not exists eet_odeslani (
  id serial primary key,
  evidovana_trzba_id integer not null references evidovana_trzba(id),
  pokus_id uuid not null,
  uuid_zpravy uuid not null,
  prvni_zaslani boolean not null,
  odeslano_kdy timestamptz not null default now(),
  stav text not null check (stav in ('odeslano','potvrzeno','chyba','nejiste')),
  pok text,
  chyba_kod text,
  chyba_text text,
  http_status integer
);
create index if not exists eet_odeslani_trzba_idx on eet_odeslani (evidovana_trzba_id);

create table if not exists eet_pripojeni_test (
  id serial primary key,
  kdy timestamptz not null default now(),
  prostredi text not null check (prostredi in ('playground','produkce')),
  vysledek text not null,
  detail text
);

create table if not exists evidovana_trzba_audit (
  id serial primary key,
  evidovana_trzba_id integer not null references evidovana_trzba(id),
  pole text not null,
  puvodni_hodnota text,
  nova_hodnota text,
  kdy timestamptz not null default now()
);

create or replace function evidovana_trzba_chranit_po_odeslani() returns trigger language plpgsql as $$
declare
  existuje_odeslani boolean;
begin
  select exists(select 1 from eet_odeslani where evidovana_trzba_id = old.id) into existuje_odeslani;
  if existuje_odeslani and (
    new.id_jednotky is distinct from old.id_jednotky or
    new.id_pokl is distinct from old.id_pokl or
    new.porad_cis is distinct from old.porad_cis or
    new.dat_trzby is distinct from old.dat_trzby or
    new.celk_trzba is distinct from old.celk_trzba or
    new.smer is distinct from old.smer or
    new.urceno_cerp_zuct is distinct from old.urceno_cerp_zuct or
    new.cerp_zuct is distinct from old.cerp_zuct
  ) then
    raise exception 'Identifikační údaje evidované tržby (id %) nelze měnit po prvním odeslání.', old.id;
  end if;
  return new;
end $$;
drop trigger if exists evidovana_trzba_chranit_po_odeslani_trg on evidovana_trzba;
create trigger evidovana_trzba_chranit_po_odeslani_trg before update on evidovana_trzba
  for each row execute function evidovana_trzba_chranit_po_odeslani();

create or replace function eet_odeslani_zakaz_mazani() returns trigger language plpgsql as $$
begin
  raise exception 'Záznamy o odeslání EET se nemažou.';
end $$;
drop trigger if exists eet_odeslani_bez_mazani on eet_odeslani;
create trigger eet_odeslani_bez_mazani before delete on eet_odeslani
  for each row execute function eet_odeslani_zakaz_mazani();

create or replace function eet_zaevidovat_zdroj(
  p_pokladni_udalost_id uuid,
  p_smer text,
  p_zdroj_typ text,
  p_zdroj_id integer,
  p_castka numeric,
  p_id_jednotky text,
  p_id_pokl text,
  p_dat_trzby timestamptz,
  p_urceno_cerp_zuct numeric default null,
  p_cerp_zuct numeric default null,
  out trzba_id integer,
  out nove_zapocitano boolean
) language plpgsql as $$
declare
  v_pocet integer;
begin
  insert into evidovana_trzba (pokladni_udalost_id, smer, celk_trzba, id_jednotky, id_pokl, dat_trzby)
  values (p_pokladni_udalost_id, p_smer, 0, p_id_jednotky, p_id_pokl, p_dat_trzby)
  on conflict (pokladni_udalost_id) do update set pokladni_udalost_id = evidovana_trzba.pokladni_udalost_id
  returning id into trzba_id;

  insert into evidovana_trzba_zdroje (evidovana_trzba_id, zdroj_typ, zdroj_id, castka)
  values (trzba_id, p_zdroj_typ, p_zdroj_id, p_castka)
  on conflict (zdroj_typ, zdroj_id) do nothing;

  get diagnostics v_pocet = row_count;
  nove_zapocitano := v_pocet > 0;

  if nove_zapocitano then
    update evidovana_trzba
    set celk_trzba = celk_trzba + p_castka,
        urceno_cerp_zuct = case when p_urceno_cerp_zuct is not null then coalesce(urceno_cerp_zuct, 0) + p_urceno_cerp_zuct else urceno_cerp_zuct end,
        cerp_zuct = case when p_cerp_zuct is not null then coalesce(cerp_zuct, 0) + p_cerp_zuct else cerp_zuct end
    where id = trzba_id;
  end if;
end $$;

create or replace function eet_zamknout_dalsi_davku(p_worker_id text, p_pocet integer default 10)
returns setof evidovana_trzba language sql as $$
  with kandidati as (
    select id from evidovana_trzba
    where stav_evidence in ('nova', 'nejiste')
      and (zpracovava_se_od is null or zpracovava_se_od < now() - interval '5 minutes')
    order by id
    for update skip locked
    limit p_pocet
  )
  update evidovana_trzba e
  set zpracovava_se_od = now(), zpracovava_worker_id = p_worker_id, aktualni_pokus_id = gen_random_uuid()
  from kandidati
  where e.id = kandidati.id
  returning e.*;
$$;

create or replace function eet_zapsat_vysledek(
  p_trzba_id integer,
  p_pokus_id uuid,
  p_novy_stav text,
  p_uuid_zpravy uuid,
  p_prvni_zaslani boolean,
  p_odeslani_stav text,
  p_pok text default null,
  p_chyba_kod text default null,
  p_chyba_text text default null,
  p_http_status integer default null,
  out zapsano boolean
) language plpgsql as $$
declare
  v_pocet integer;
begin
  insert into eet_odeslani (evidovana_trzba_id, pokus_id, uuid_zpravy, prvni_zaslani, stav, pok, chyba_kod, chyba_text, http_status)
  select p_trzba_id, p_pokus_id, p_uuid_zpravy, p_prvni_zaslani, p_odeslani_stav, p_pok, p_chyba_kod, p_chyba_text, p_http_status
  where exists (select 1 from evidovana_trzba where id = p_trzba_id and aktualni_pokus_id = p_pokus_id);
  get diagnostics v_pocet = row_count;
  zapsano := v_pocet > 0;

  if zapsano then
    update evidovana_trzba
    set stav_evidence = p_novy_stav, zpracovava_se_od = null, zpracovava_worker_id = null
    where id = p_trzba_id and aktualni_pokus_id = p_pokus_id;
  end if;
end $$;

insert into nastaveni (klic, hodnota) values ('eet_aktivovano_od', '') on conflict (klic) do nothing;
insert into nastaveni (klic, hodnota) values ('eet_odesilani_pozastaveno', 'true') on conflict (klic) do nothing;

commit;

\echo '--- PO: nové tabulky existují ---'
select table_name from information_schema.tables
  where table_schema = 'public'
    and table_name in ('evidovana_trzba','evidovana_trzba_zdroje','eet_odeslani','eet_pripojeni_test','evidovana_trzba_audit')
  order by table_name;

\echo '--- PO: nové tabulky jsou PRÁZDNÉ (žádný automatický backfill ze starých dat) ---'
select 'evidovana_trzba' as tabulka, count(*) from evidovana_trzba
union all select 'evidovana_trzba_zdroje', count(*) from evidovana_trzba_zdroje
union all select 'eet_odeslani', count(*) from eet_odeslani
union all select 'eet_pripojeni_test', count(*) from eet_pripojeni_test
union all select 'evidovana_trzba_audit', count(*) from evidovana_trzba_audit;

\echo '--- PO: počty řádků existujících tabulek (musí být IDENTICKÉ s PŘED) ---'
select
  (select count(*) from platby) as po_platby,
  (select count(*) from poukazy) as po_poukazy,
  (select count(*) from prodeje) as po_prodeje,
  (select count(*) from prodeje_produktu) as po_prodeje_produktu,
  (select count(*) from nastaveni) as po_nastaveni;

\echo '--- PO: nové klíče v nastaveni ---'
select klic, hodnota from nastaveni where klic in ('eet_aktivovano_od','eet_odesilani_pozastaveno') order by klic;
