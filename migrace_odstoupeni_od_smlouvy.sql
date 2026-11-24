-- Online formulář pro odstoupení od smlouvy uzavřené na dálku (povinnost od
-- 1. 1. 2027 u smluv, kde má spotřebitel právo odstoupit — viz
-- obchodni-podminky.html, čl. 4). Čistě aditivní, bezpečné spustit opakovaně.

create table if not exists odstoupeni_zadosti (
  id serial primary key,
  popis_sluzby text not null, -- čeho se odstoupení týká (např. "Rezervace masáže 5. 12. 2026")
  datum_uzavreni_smlouvy date, -- nepovinné, spotřebitel nemusí znát přesně
  jmeno text not null,
  email text,
  telefon text,
  adresa text, -- nepovinné, hodí se pro případné vrácení platby poštou
  poznamka text,
  rezervace_id integer references rezervace(id) on delete set null, -- nepovinné: pokud se podařilo spárovat s konkrétní rezervací
  stav text not null default 'nova', -- nova | vyrizena
  vytvoreno timestamptz not null default now()
);

\echo '--- PO: tabulka existuje ---'
select count(*) from odstoupeni_zadosti;
