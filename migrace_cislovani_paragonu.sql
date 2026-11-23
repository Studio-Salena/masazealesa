-- Jednotné číslování paragonů a faktur — jedna sdílená řada RRRRNNN napříč
-- platbami za rezervace, poukazy, prodejnou a prodejem produktů (včetně
-- vratek). Faktura (doklady_uhrady) k dané platbě od teď přebírá STEJNÉ
-- číslo jako paragon vystavený k téže platbě, místo vlastní nezávislé řady.
-- Obsahuje i zpětné přečíslování VŠECH dosavadních historických záznamů,
-- chronologicky podle data skutečné úhrady. Bezpečné spustit opakovaně
-- (zpětné číslování se týká jen řádků, co ještě číslo nemají).
-- Spusť v Supabase: SQL Editor → New query → vložit celý soubor → Run.

begin;

alter table platby add column if not exists cislo_paragonu text;
alter table poukazy add column if not exists cislo_paragonu text;
alter table prodeje add column if not exists cislo_paragonu text;
alter table prodeje_produktu add column if not exists cislo_paragonu text;

-- Sdílený čítač poslední přidělené pořadové hodnoty za daný rok — atomický
-- UPSERT (řádkový zámek) při přidělování dalšího čísla řeší souběh bez
-- potřeby opakování, na rozdíl od "MAX(poradi)+1" vzoru použitého dřív jen
-- u doklady_uhrady.
create table if not exists cislovani_paragonu (
  rok integer primary key,
  posledni_poradi integer not null default 0
);

-- Zpětné přečíslování: sjednotit všechny kvalifikující historické řádky
-- napříč čtyřmi tabulkami do dočasné tabulky, seřadit chronologicky a
-- přidělit pořadí v rámci roku. Vynechané (stejná pravidla jako u živého
-- přidělování v server.js): čerpání poukazu (zpusob_platby='poukaz' v
-- platby — peníze už byly přijaté při prodeji poukazu), refundační poukaz
-- (ucel='vratka' v poukazy — číslo nese vratka samotné platby) a nezaplacené
-- poukazy (zatím nejde o přijaté peníze).
create temporary table tmp_cislovani on commit drop as
with zdroje as (
  select 'platby'::text as zdroj, id, vytvoreno as datum
  from platby
  where zpusob_platby <> 'poukaz' and cislo_paragonu is null
  union all
  select 'poukazy', id, coalesce(zaplaceno_kdy, vytvoreno)
  from poukazy
  where stav_uhrady = 'zaplaceno' and ucel <> 'vratka' and cislo_paragonu is null
  union all
  select 'prodeje', id, vytvoreno
  from prodeje
  where cislo_paragonu is null
  union all
  select 'prodeje_produktu', id, vytvoreno
  from prodeje_produktu
  where cislo_paragonu is null
)
select zdroj, id, datum,
  extract(year from datum)::int as rok,
  row_number() over (partition by extract(year from datum) order by datum, zdroj, id) as poradi_v_roce
from zdroje;

-- "lpad" v Postgresu na rozdíl od JS "padStart" ČÍSLO OŘEZÁVÁ, pokud je
-- vstup už delší než cílová šířka (lpad('1000',3,'0') => '100', ne '1000'!)
-- — u roku s 1000+ transakcemi by se tak čísla tiše SRAZILA (viz
-- "greatest(3, length(...))" níž, co šířku rozšíří místo oříznutí).
update platby set cislo_paragonu = t.rok::text || lpad(t.poradi_v_roce::text, greatest(3, length(t.poradi_v_roce::text)), '0')
from tmp_cislovani t where t.zdroj = 'platby' and t.id = platby.id;

update poukazy set cislo_paragonu = t.rok::text || lpad(t.poradi_v_roce::text, greatest(3, length(t.poradi_v_roce::text)), '0')
from tmp_cislovani t where t.zdroj = 'poukazy' and t.id = poukazy.id;

update prodeje set cislo_paragonu = t.rok::text || lpad(t.poradi_v_roce::text, greatest(3, length(t.poradi_v_roce::text)), '0')
from tmp_cislovani t where t.zdroj = 'prodeje' and t.id = prodeje.id;

update prodeje_produktu set cislo_paragonu = t.rok::text || lpad(t.poradi_v_roce::text, greatest(3, length(t.poradi_v_roce::text)), '0')
from tmp_cislovani t where t.zdroj = 'prodeje_produktu' and t.id = prodeje_produktu.id;

-- Posune (nikdy nesníží) sdílený čítač na nejvyšší přidělené číslo za rok,
-- ať na něj živé transakce po migraci navazují správně.
insert into cislovani_paragonu (rok, posledni_poradi)
select rok, max(poradi_v_roce) from tmp_cislovani group by rok
on conflict (rok) do update set posledni_poradi = greatest(cislovani_paragonu.posledni_poradi, excluded.posledni_poradi);

commit;

-- Kontrola po spuštění: kolik řádků se za který rok očíslovalo a kde teď
-- stojí čítač (na dalším běhu by se tahle čísla už neměla měnit).
select rok, posledni_poradi from cislovani_paragonu order by rok;
