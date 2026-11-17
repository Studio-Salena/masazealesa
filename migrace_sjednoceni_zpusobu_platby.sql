-- Krok 1 přípravy na EET 2.0: sjednocení způsobů plateb.
--
-- Doplňuje DB-úrovňovou pojistku (CHECK) k aplikační validaci, která už
-- byla sjednocena v server.js (jedno místo definice místo 4 nezávislých
-- literálů). CHECK constraint je úmyslně nejširší UNIE všech historicky
-- platných hodnot napříč tabulkami (hotove, kartou, online, qr, poukaz) —
-- NE zúžená podmnožina konkrétního endpointu. Přesné, užší business
-- pravidlo (např. "prodejna umí jen hotove/qr") zůstává v aplikační
-- vrstvě; DB constraint jen chrání proti nesmyslné/překlepnuté hodnotě
-- přes jakoukoli cestu (i přímé SQL), ne proti legitimním, byznysově
-- odlišným podmnožinám mezi endpointy.
--
-- Zároveň se odstraňuje DB-úrovňový DEFAULT 'hotove' na prodeje a
-- prodeje_produktu — appka dnes už vždy explicitně vkládá zpusob_platby
-- (ověřeno), takže DEFAULT nikdy neměl reálný efekt, ale jako tichá
-- možnost "platba bez výslovného potvrzení" by při budoucí chybě v kódu
-- mohl znovu vzniknout stejný problém, co tenhle krok odstraňuje v appce.
--
-- Žádná historická data se nepřepisují, jen se přidává kontrola PRO
-- BUDOUCÍ zápisy. Před spuštěním ověřeno, že VŠECHNA existující data už
-- vyhovují (viz PŘED kontroly níž) — proto je migrace bezpečná i na
-- provozní data.

\set ON_ERROR_STOP on
set lock_timeout = '3s';

\echo '--- PŘED: existující hodnoty zpusob_platby (musí všechny vyhovět) ---'
select 'platby' as tabulka, zpusob_platby, count(*) from platby group by 1, 2
union all
select 'poukazy', zpusob_platby, count(*) from poukazy group by 1, 2
union all
select 'prodeje', zpusob_platby, count(*) from prodeje group by 1, 2
union all
select 'prodeje_produktu', zpusob_platby, count(*) from prodeje_produktu group by 1, 2
order by 1, 2;

\echo '--- PŘED: počty řádků (pro ověření, že se nic nesmazalo/nepřidalo) ---'
select
  (select count(*) from platby) as pred_platby,
  (select count(*) from poukazy) as pred_poukazy,
  (select count(*) from prodeje) as pred_prodeje,
  (select count(*) from prodeje_produktu) as pred_prodeje_produktu;

begin;

alter table platby drop constraint if exists platby_zpusob_platby_check;
alter table platby add constraint platby_zpusob_platby_check
  check (zpusob_platby in ('hotove','kartou','online','qr','poukaz'));

alter table poukazy drop constraint if exists poukazy_zpusob_platby_check;
alter table poukazy add constraint poukazy_zpusob_platby_check
  check (zpusob_platby is null or zpusob_platby in ('hotove','kartou','online','qr','poukaz'));

alter table prodeje alter column zpusob_platby drop default;
alter table prodeje drop constraint if exists prodeje_zpusob_platby_check;
alter table prodeje add constraint prodeje_zpusob_platby_check
  check (zpusob_platby in ('hotove','kartou','online','qr','poukaz'));

alter table prodeje_produktu alter column zpusob_platby drop default;
alter table prodeje_produktu drop constraint if exists prodeje_produktu_zpusob_platby_check;
alter table prodeje_produktu add constraint prodeje_produktu_zpusob_platby_check
  check (zpusob_platby in ('hotove','kartou','online','qr','poukaz'));

commit;

\echo '--- PO: constraints a defaulty ---'
select conname, pg_get_constraintdef(oid) from pg_constraint
  where conname in ('platby_zpusob_platby_check','poukazy_zpusob_platby_check','prodeje_zpusob_platby_check','prodeje_produktu_zpusob_platby_check')
  order by conname;

select table_name, column_name, column_default from information_schema.columns
  where table_schema='public' and column_name='zpusob_platby' and table_name in ('prodeje','prodeje_produktu')
  order by table_name;

\echo '--- PO: počty řádků (musí být IDENTICKÉ s PŘED) ---'
select
  (select count(*) from platby) as po_platby,
  (select count(*) from poukazy) as po_poukazy,
  (select count(*) from prodeje) as po_prodeje,
  (select count(*) from prodeje_produktu) as po_prodeje_produktu;
