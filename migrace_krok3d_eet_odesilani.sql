-- Krok 3d: koordinované odesílání EET (okamžitě po platbě + záložní worker).
-- Čistě aditivní migrace — žádná existující tabulka/funkce se neduplikuje,
-- žádný historický řádek se nemění ani nemaže. Jediná destruktivní operace
-- (DROP FUNCTION eet_zapsat_vysledek v původní desetiparametrové podobě) je
-- nutná, protože PostgreSQL "create or replace function" se ZMĚNĚNÝM
-- seznamem parametrů vytvoří DRUHOU přetíženou funkci místo nahrazení té
-- staré — ověřeno PŘED touto migrací (viz zpráva k přípravě nasazení):
--   * žádný jiný objekt v databázi (view/trigger/funkce) na starou
--     desetiparametrovou podobu neodkazuje (pg_depend prázdný),
--   * stará podoba není v PRODUKCI volána ŽÁDNÝM aktuálně nasazeným kódem
--     (Krok 3a/3b evidenci jen ZAKLÁDAJÍ, eet_zapsat_vysledek vůbec
--     nevolají — to dělá až Krok 3d),
--   * nová podoba je zpětně kompatibilní (jen 2 nové parametry na konci,
--     s DEFAULT NULL).
--
-- DŮLEŽITÉ: tato migrace sama o sobě nic NEODESÍLÁ ani NEZAKLÁDÁ. EET
-- přepínače (eet_evidence_zapnuta, eet_odesilani_pozastaveno) se touto
-- migrací vůbec nemění — zůstávají přesně v tom stavu, v jakém jsou teď.
--
-- Bezpečné spustit opakovaně (idempotentní) — "if not exists"/"or replace"
-- všude, DROP FUNCTION má "if exists".

\set ON_ERROR_STOP on
set lock_timeout = '3s';

\echo '--- PŘED: počty řádků existujících tabulek (pro ověření, že migrace nic nesmaže/nepřidá) ---'
select
  (select count(*) from evidovana_trzba) as pred_evidovana_trzba,
  (select count(*) from eet_odeslani) as pred_eet_odeslani,
  (select count(*) from evidovana_trzba_zdroje) as pred_evidovana_trzba_zdroje,
  (select count(*) from nastaveni) as pred_nastaveni;

-- Bezpečnostní pojistka (stejný princip jako migrace_krok3b_eet_platby.sql) —
-- migrace se ÚPLNĚ ODMÍTNE spustit, pokud přepínače nejsou v očekávaném
-- (vypnutém) stavu, místo aby mlčky pokračovala nad neočekávanou situací.
\echo '--- Kontrola očekávaného stavu EET přepínačů PŘED migrací ---'
do $$
declare
  v_pozastaveno text;
  v_evidence text;
begin
  select hodnota into v_pozastaveno from nastaveni where klic = 'eet_odesilani_pozastaveno';
  select hodnota into v_evidence from nastaveni where klic = 'eet_evidence_zapnuta';

  if coalesce(v_pozastaveno, '') <> 'true' then
    raise exception 'Migrace odmítnuta: eet_odesilani_pozastaveno má nečekanou hodnotu "%" (čekáno "true") — odesílání EET nemusí být pozastavené, zastavuji se a hlásím problém.', v_pozastaveno;
  end if;
  if coalesce(v_evidence, '') <> 'false' then
    raise exception 'Migrace odmítnuta: eet_evidence_zapnuta má nečekanou hodnotu "%" (čekáno "false") — zastavuji se a hlásím problém.', v_evidence;
  end if;
end $$;

begin;

-- 1) EIČ poplatníka — dřív jen parametr v kódu, teď i konfigurační místo.
insert into nastaveni (klic, hodnota) values ('eet_eic_popl', '') on conflict (klic) do nothing;

-- 2) Strop počtu pokusů — bez něj by trvalý výpadek FS vedl k neomezenému
--    opakování navždy (viz eet/odesilaci-sluzba.js).
insert into nastaveni (klic, hodnota) values ('eet_max_pokusu', '10') on conflict (klic) do nothing;

-- 3) Výsledek kryptografického ověření podpisu PŘIJATÉ odpovědi.
alter table eet_odeslani add column if not exists fs_podpis_duveryhodny boolean;
alter table eet_odeslani add column if not exists fs_podpis_poznamka text;

-- 4) Zamknutí JEDNÉ KONKRÉTNÍ evidované tržby (okamžité odeslání po platbě) —
--    stejný zamykací mechanismus jako eet_zamknout_dalsi_davku (Krok 3a).
create or replace function eet_zamknout_konkretni(p_trzba_id integer, p_worker_id text)
returns setof evidovana_trzba language sql as $$
  with kandidat as (
    select id from evidovana_trzba
    where id = p_trzba_id
      and stav_evidence in ('nova', 'nejiste')
      and (zpracovava_se_od is null or zpracovava_se_od < now() - interval '5 minutes')
    for update skip locked
  )
  update evidovana_trzba e
  set zpracovava_se_od = now(), zpracovava_worker_id = p_worker_id, aktualni_pokus_id = gen_random_uuid()
  from kandidat
  where e.id = kandidat.id
  returning e.*;
$$;

-- 5) Ruční "reset" báze pokusů po manuálním vyřešení trvalé chyby.
alter table evidovana_trzba add column if not exists rucni_reset_kdy timestamptz;
alter table evidovana_trzba add column if not exists rucni_reset_poznamka text;

create or replace function eet_znovu_zaradit_do_fronty(p_trzba_id integer, p_poznamka text)
returns boolean language plpgsql as $$
declare
  v_pocet integer;
begin
  update evidovana_trzba
  set stav_evidence = 'nova',
      zpracovava_se_od = null, zpracovava_worker_id = null, aktualni_pokus_id = null,
      rucni_reset_kdy = now(), rucni_reset_poznamka = p_poznamka
  where id = p_trzba_id and stav_evidence = 'chyba';
  get diagnostics v_pocet = row_count;
  return v_pocet > 0;
end $$;

-- 6) Uvolnění zámku BEZ zápisu výsledku — infrastrukturní chyba (cert/klíč)
--    se nesmí počítat do eet_max_pokusu ani tržbu trvale uzavřít.
create or replace function eet_uvolnit_zamek_bez_vysledku(p_trzba_id integer, p_pokus_id uuid)
returns boolean language plpgsql as $$
declare
  v_pocet integer;
begin
  update evidovana_trzba
  set zpracovava_se_od = null, zpracovava_worker_id = null
  where id = p_trzba_id and aktualni_pokus_id = p_pokus_id;
  get diagnostics v_pocet = row_count;
  return v_pocet > 0;
end $$;

-- 7) eet_zapsat_vysledek — rozšíření o fs_podpis_duveryhodny/fs_podpis_poznamka
--    (viz zdůvodnění DROP FUNCTION v hlavičce souboru výš).
drop function if exists eet_zapsat_vysledek(integer, uuid, text, uuid, boolean, text, text, text, text, integer);
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
  p_fs_podpis_duveryhodny boolean default null,
  p_fs_podpis_poznamka text default null,
  out zapsano boolean
) language plpgsql as $$
declare
  v_pocet integer;
begin
  insert into eet_odeslani (evidovana_trzba_id, pokus_id, uuid_zpravy, prvni_zaslani, stav, pok, chyba_kod, chyba_text, http_status, fs_podpis_duveryhodny, fs_podpis_poznamka)
  select p_trzba_id, p_pokus_id, p_uuid_zpravy, p_prvni_zaslani, p_odeslani_stav, p_pok, p_chyba_kod, p_chyba_text, p_http_status, p_fs_podpis_duveryhodny, p_fs_podpis_poznamka
  where exists (select 1 from evidovana_trzba where id = p_trzba_id and aktualni_pokus_id = p_pokus_id);
  get diagnostics v_pocet = row_count;
  zapsano := v_pocet > 0;

  if zapsano then
    update evidovana_trzba
    set stav_evidence = p_novy_stav, zpracovava_se_od = null, zpracovava_worker_id = null
    where id = p_trzba_id and aktualni_pokus_id = p_pokus_id;
  end if;
end $$;

commit;

\echo '--- PO: nové sloupce existují ---'
select table_name, column_name from information_schema.columns
  where table_schema = 'public'
    and (
      (table_name = 'eet_odeslani' and column_name in ('fs_podpis_duveryhodny','fs_podpis_poznamka'))
      or (table_name = 'evidovana_trzba' and column_name in ('rucni_reset_kdy','rucni_reset_poznamka'))
    )
  order by table_name, column_name;

\echo '--- PO: nové/upravené funkce existují s očekávaným počtem argumentů ---'
select proname, pronargs from pg_proc
  where proname in ('eet_zamknout_konkretni','eet_znovu_zaradit_do_fronty','eet_uvolnit_zamek_bez_vysledku','eet_zapsat_vysledek')
  order by proname;

\echo '--- PO: počty řádků existujících tabulek (musí být IDENTICKÉ s PŘED) ---'
select
  (select count(*) from evidovana_trzba) as po_evidovana_trzba,
  (select count(*) from eet_odeslani) as po_eet_odeslani,
  (select count(*) from evidovana_trzba_zdroje) as po_evidovana_trzba_zdroje,
  (select count(*) from nastaveni) as po_nastaveni;

\echo '--- PO: EET přepínače MUSÍ zůstat beze změny ---'
select klic, hodnota from nastaveni where klic in ('eet_evidence_zapnuta','eet_odesilani_pozastaveno') order by klic;
