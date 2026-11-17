-- Krok 2 přípravy na EET 2.0: rozlišení způsobu a charakteru platby.
--
-- Dvě nezávislé věci, obě aditivní (nic nemaže, nic historického nepřepisuje):
--
-- 1) Rozšíření CHECK na platby.zpusob_platby a poukazy.zpusob_platby o
--    'prevodem' (bankovní převod NA DÁLKU). 'qr' tam byl v unii CHECK už od
--    Kroku 1 (platby i poukazy), teď ho navíc smí použít i aplikační
--    validace rezervací (ZPUSOBY_PLATBY_REZERVACE v server.js) — platba QR
--    kódem OSOBNĚ v salonu. Prodejna a produkty se v Kroku 2 nemění.
--
-- 2) Nový sloupec kontaktni_platba (boolean, nullable) na platby a poukazy —
--    NEZÁVISLÝ na zpusob_platby, protože metoda sama o sobě spolehlivě
--    neurčuje, jestli šlo o kontaktní platbu ve smyslu §6 ZEET (osobně v
--    salonu) nebo platbu na dálku. Historické řádky (vzniklé před touto
--    migrací) zůstávají NULL NAVŽDY — ŽÁDNÝ automatický dopočet podle
--    metody, na výslovné přání Aleny (žádný backfill). U nových skutečně
--    přijatých plateb je hodnota vynucená v server.js (ne CHECKem v DB).
--
-- Před spuštěním ověřeno, že VŠECHNY existující hodnoty zpusob_platby už
-- vyhovují rozšířenému CHECKu (je to jen rozšíření unie, ne zúžení) — proto
-- je migrace bezpečná i na provozní data. Nový sloupec je čistě přídavný.

\set ON_ERROR_STOP on
set lock_timeout = '3s';

\echo '--- PŘED: existující hodnoty zpusob_platby (musí všechny vyhovět i rozšířenému CHECKu) ---'
select 'platby' as tabulka, zpusob_platby, count(*) from platby group by 1, 2
union all
select 'poukazy', zpusob_platby, count(*) from poukazy group by 1, 2
order by 1, 2;

\echo '--- PŘED: počty řádků (pro ověření, že se nic nesmazalo/nepřidalo) ---'
select
  (select count(*) from platby) as pred_platby,
  (select count(*) from poukazy) as pred_poukazy;

\echo '--- PŘED: kontaktni_platba sloupec zatím nemá existovat ---'
select column_name from information_schema.columns
  where table_schema = 'public' and table_name in ('platby', 'poukazy') and column_name = 'kontaktni_platba';

begin;

alter table platby drop constraint if exists platby_zpusob_platby_check;
alter table platby add constraint platby_zpusob_platby_check
  check (zpusob_platby in ('hotove','kartou','online','qr','poukaz','prevodem'));

alter table poukazy drop constraint if exists poukazy_zpusob_platby_check;
alter table poukazy add constraint poukazy_zpusob_platby_check
  check (zpusob_platby is null or zpusob_platby in ('hotove','kartou','online','qr','poukaz','prevodem'));

alter table platby  add column if not exists kontaktni_platba boolean;
alter table poukazy add column if not exists kontaktni_platba boolean;

commit;

\echo '--- PO: constraints ---'
select conname, pg_get_constraintdef(oid) from pg_constraint
  where conname in ('platby_zpusob_platby_check','poukazy_zpusob_platby_check')
  order by conname;

\echo '--- PO: nový sloupec existuje a je u VŠECH řádků NULL (žádný backfill) ---'
select 'platby' as tabulka, count(*) filter (where kontaktni_platba is not null) as nenull, count(*) as celkem from platby
union all
select 'poukazy', count(*) filter (where kontaktni_platba is not null), count(*) from poukazy;

\echo '--- PO: počty řádků (musí být IDENTICKÉ s PŘED) ---'
select
  (select count(*) from platby) as po_platby,
  (select count(*) from poukazy) as po_poukazy;
