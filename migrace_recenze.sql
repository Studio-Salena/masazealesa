-- Recenze na web — nová tabulka, spravovaná v adminu (koncept → zveřejnění),
-- zobrazená na veřejném webu přes GET /api/recenze. Součástí migrace je i
-- jednorázové převedení 4 recenzí, co dnes visí napevno v index.html, do
-- téhle tabulky (rovnou zveřejněné, ať se na webu opticky nic nezmění kromě
-- přidání "Paní" před jméno) — bezpečné spustit opakovaně.

\set ON_ERROR_STOP on
set lock_timeout = '3s';

\echo '--- PŘED: tabulka recenze zatím nemá existovat ---'
select table_name from information_schema.tables where table_schema = 'public' and table_name = 'recenze';

begin;

create table if not exists recenze (
  id serial primary key,
  jmeno text not null,
  text text not null,
  hvezdicky integer not null default 5 check (hvezdicky between 1 and 5),
  stav text not null default 'koncept' check (stav in ('koncept','zverejneno')),
  poradi integer not null default 0,
  vytvoreno timestamptz not null default now(),
  zverejneno_kdy timestamptz
);
create index if not exists recenze_verejne_idx on recenze (stav, poradi, vytvoreno desc);

insert into recenze (jmeno, text, hvezdicky, stav, poradi, zverejneno_kdy)
select 'Monika', 'U paní Hasalové jsem začínala jako těhotná. Chodila jsem k ní na těhotenské cvičení a masáže pro těhotné — a díky tomu byla rekonvalescence těla po císaři okamžitá a bez problémů. Nyní jsem stále věrnou zákaznicí, protože má zlaté ručičky. Málokdy píši recenze, ale opravdu vřele doporučuji všem.', 5, 'zverejneno', 1, now()
where not exists (select 1 from recenze where jmeno = 'Monika' and text like 'U paní Hasalové jsem začínala jako těhotná%');
insert into recenze (jmeno, text, hvezdicky, stav, poradi, zverejneno_kdy)
select 'Pavlína', 'Na masáž se vždy moc těším. Velmi mne udržuje v kondici. I dnes tomu nebylo jinak. Už se těším na příští návštěvu.', 5, 'zverejneno', 2, now()
where not exists (select 1 from recenze where jmeno = 'Pavlína' and text like 'Na masáž se vždy moc těším%');
insert into recenze (jmeno, text, hvezdicky, stav, poradi, zverejneno_kdy)
select 'Helena', 'Výborné, příjemné prostředí. Doporučuji!', 5, 'zverejneno', 3, now()
where not exists (select 1 from recenze where jmeno = 'Helena' and text = 'Výborné, příjemné prostředí. Doporučuji!');
insert into recenze (jmeno, text, hvezdicky, stav, poradi, zverejneno_kdy)
select 'Adéla', 'Skvělý přístup, milá paní masérka. Absolvovala jsem těhotenskou masáž, která byla velice příjemná — odcházela jsem moc spokojená. Doporučuji!', 5, 'zverejneno', 4, now()
where not exists (select 1 from recenze where jmeno = 'Adéla' and text like 'Skvělý přístup, milá paní masérka%');

commit;

\echo '--- PO: tabulka recenze existuje, se 4 zveřejněnými řádky ---'
select stav, count(*) from recenze group by stav order by stav;
