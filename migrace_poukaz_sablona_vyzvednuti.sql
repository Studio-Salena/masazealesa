-- Výběr vzhledu poukazu (klasický/vánoční) a nepovinný termín vyzvednutí u
-- žádosti o poukaz z webu. Čistě aditivní, bezpečné spustit opakovaně
-- ("if not exists" všude).

alter table poukazy_zadosti add column if not exists sablona text not null default 'klasicky';
alter table poukazy_zadosti add column if not exists vyzvednuti_termin date;

alter table poukazy add column if not exists sablona text not null default 'klasicky';
alter table poukazy add column if not exists vyzvednuti_termin date;

\echo '--- PO: nové sloupce existují ---'
select table_name, column_name from information_schema.columns
  where table_schema = 'public'
    and table_name in ('poukazy_zadosti', 'poukazy')
    and column_name in ('sablona', 'vyzvednuti_termin')
  order by table_name, column_name;
