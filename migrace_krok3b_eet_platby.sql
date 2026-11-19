-- Krok 3b: napojení skutečných platebních operací na databázovou EET evidenci
-- z Kroku 3a. Čistě aditivní migrace — žádná existující tabulka se nemaže ani
-- nepřepisuje, žádný historický řádek se nemění.
--
-- DŮLEŽITÉ: tato migrace sama o sobě NEVYTVÁŘÍ žádné EET záznamy. Jen
-- připravuje sloupce/konstrukce. Vytváření evidence v server.js je navíc
-- podmíněno příznakem "eet_evidence_zapnuta" v tabulce "nastaveni" — tahle
-- migrace ho vkládá jako 'false', takže ani po nasazení kódu Kroku 3b se v
-- produkci nezačne nic evidovat, dokud se příznak výslovně nepřepne (to je
-- samostatné, budoucí schválení, ne součást téhle migrace).
--
-- Bezpečné spustit opakovaně (idempotentní).

\set ON_ERROR_STOP on
set lock_timeout = '3s';

\echo '--- PŘED: počty řádků existujících tabulek (pro ověření, že migrace nic nesmaže/nepřidá) ---'
select
  (select count(*) from prodeje) as pred_prodeje,
  (select count(*) from prodeje_produktu) as pred_prodeje_produktu,
  (select count(*) from poukazy) as pred_poukazy,
  (select count(*) from nastaveni) as pred_nastaveni;

-- Bezpečnostní pojistka (audit před nasazením, bod 7) — níž použité
-- "ON CONFLICT DO NOTHING" by při NEČEKANÉ existující hodnotě tiše nic
-- nezměnilo, což by mohlo vypadat bezpečně, i kdyby EET bylo už omylem
-- před migrací částečně zapnuté. Migrace se raději ÚPLNĚ ODMÍTNE spustit
-- (chyba, ON_ERROR_STOP zastaví celý skript), než aby mlčky pokračovala
-- nad neočekávaným stavem.
\echo '--- Kontrola očekávaného stavu EET přepínačů PŘED migrací ---'
do $$
declare
  v_aktivovano_od text;
  v_pozastaveno text;
  v_evidence text;
begin
  select hodnota into v_aktivovano_od from nastaveni where klic = 'eet_aktivovano_od';
  select hodnota into v_pozastaveno from nastaveni where klic = 'eet_odesilani_pozastaveno';
  select hodnota into v_evidence from nastaveni where klic = 'eet_evidence_zapnuta';

  if coalesce(v_aktivovano_od, '') <> '' then
    raise exception 'Migrace odmítnuta: eet_aktivovano_od má nečekanou hodnotu "%" (čekáno prázdné) — EET může být již aktivované, zastavuji se a hlásím problém.', v_aktivovano_od;
  end if;
  if coalesce(v_pozastaveno, '') <> 'true' then
    raise exception 'Migrace odmítnuta: eet_odesilani_pozastaveno má nečekanou hodnotu "%" (čekáno "true") — odesílání EET nemusí být pozastavené, zastavuji se a hlásím problém.', v_pozastaveno;
  end if;
  -- v_evidence je NULL při prvním spuštění (klíč ještě neexistuje) — to je v
  -- pořádku. Pokud klíč UŽ existuje, musí mít hodnotu 'false' (ať jde o
  -- bezpečné opakované spuštění téže migrace) — JAKÁKOLI jiná hodnota
  -- (především 'true') znamená nečekaný stav a migrace se zastaví.
  if v_evidence is not null and v_evidence <> 'false' then
    raise exception 'Migrace odmítnuta: eet_evidence_zapnuta už existuje s nečekanou hodnotou "%" (čekáno NULL při prvním spuštění, nebo "false" při opakování) — zkontrolujte ruční stav databáze, než budete pokračovat.', v_evidence;
  end if;
end $$;

begin;

-- 1) Prodej dárkového poukazu dnes nemá vlastní řádek v deníku "platby" (ten
--    je svázán jen s rezervacemi) — potřebuje nový typ zdroje.
alter table evidovana_trzba_zdroje drop constraint if exists evidovana_trzba_zdroje_zdroj_typ_check;
alter table evidovana_trzba_zdroje add constraint evidovana_trzba_zdroje_zdroj_typ_check
  check (zdroj_typ in ('platba','poukaz','poukaz_historie','prodej','prodej_produktu'));

-- 2) Idempotenční klíče (ochrana proti dvojkliku/opakování/souběhu) — stejný
--    ověřený vzor jako už existuje u "platby" (unikátní index, NULL povolen
--    pro případné budoucí volání bez klíče).
alter table prodeje add column if not exists idempotency_klic text;
create unique index if not exists prodeje_idempotency_klic_idx on prodeje (idempotency_klic) where idempotency_klic is not null;

alter table prodeje_produktu add column if not exists idempotency_klic text;
create unique index if not exists prodeje_produktu_idempotency_klic_idx on prodeje_produktu (idempotency_klic) where idempotency_klic is not null;

alter table poukazy add column if not exists idempotency_klic text;
create unique index if not exists poukazy_idempotency_klic_idx on poukazy (idempotency_klic) where idempotency_klic is not null;

-- 3) Explicitní kontaktní platba u prodejny a produktů (dosud jen u rezervací
--    a poukazů, viz Krok 2). Nullable — zpětně kompatibilní se stávajícími
--    záznamy, které sloupec nemají vyplněný.
alter table prodeje add column if not exists kontaktni_platba boolean;
alter table prodeje_produktu add column if not exists kontaktni_platba boolean;

-- 4) Dvoustupňové zapnutí EET: vytváření evidence (toto) je NEZÁVISLÉ na
--    odesílání (Krok 3a, "eet_odesilani_pozastaveno"). Výchozí 'false' —
--    žádné nové EET záznamy nevznikají, dokud se příznak výslovně nezapne.
insert into nastaveni (klic, hodnota) values ('eet_evidence_zapnuta', 'false') on conflict (klic) do nothing;

-- 5) Identifikátory pokladny pro EET zprávy — povinné údaje z vaší EET
--    registrace u finanční správy. Prázdné hodnoty jsou jen místo pro TEST;
--    v produkci je nutné doplnit skutečné hodnoty PŘED zapnutím evidence.
insert into nastaveni (klic, hodnota) values ('eet_id_jednotky', '') on conflict (klic) do nothing;
insert into nastaveni (klic, hodnota) values ('eet_id_pokl', '') on conflict (klic) do nothing;

commit;

\echo '--- PO: nové sloupce existují ---'
select table_name, column_name from information_schema.columns
  where table_schema = 'public' and column_name in ('idempotency_klic','kontaktni_platba')
    and table_name in ('prodeje','prodeje_produktu','poukazy')
  order by table_name, column_name;

\echo '--- PO: počty řádků existujících tabulek (musí být IDENTICKÉ s PŘED) ---'
select
  (select count(*) from prodeje) as po_prodeje,
  (select count(*) from prodeje_produktu) as po_prodeje_produktu,
  (select count(*) from poukazy) as po_poukazy,
  (select count(*) from nastaveni) as po_nastaveni;

\echo '--- PO: nové klíče v nastaveni (evidence musí být "false") ---'
select klic, hodnota from nastaveni where klic in ('eet_evidence_zapnuta','eet_id_jednotky','eet_id_pokl') order by klic;
