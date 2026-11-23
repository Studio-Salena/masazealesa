-- Doklad o úhradě masáže (pro proplacení zaměstnavatelem/pojišťovnou) —
-- nová tabulka pro evidenci vystavených dokladů a jejich číselné řady podle
-- roku (2026001, 2026002, ...). Spravováno přes sekci Platba v adminu
-- (POST /api/admin/platby/:platbaId/doklad), posíláno e-mailem jako PDF
-- příloha. Bezpečné spustit opakovaně.
-- Spusť v Supabase: SQL Editor → New query → vložit celý soubor → Run.

begin;

-- platba_id/rezervace_id: "on delete set null" (ne "cascade") — na rozdíl od
-- tabulky "platby" (ta kaskádově mizí se smazáním rezervace, viz komentář u
-- DELETE /api/admin/rezervace/:id) je doklad_uhrady VYSTAVENÝ DOKLAD s
-- vlastním přiděleným číslem v řadě (jmeno_zakaznice/nazev_sluzby/castka/...
-- jsou proto uložené jako snapshot, ne dotahované joinem) — smazáním
-- testovací/chybné rezervace nesmí zmizet číslo dokladu, co třeba klientka
-- už poslala pojišťovně.
create table if not exists doklady_uhrady (
  id serial primary key,
  cislo text not null,
  rok integer not null,
  poradi integer not null,
  platba_id integer references platby(id) on delete set null,
  rezervace_id integer references rezervace(id) on delete set null,
  klientka_id integer references klientky(id) on delete set null,
  jmeno_zakaznice text not null,
  nazev_sluzby text not null,
  delka_min integer,
  castka numeric not null,
  zpusob_platby text not null,
  datum_poskytnuti date,
  datum_uhrady date not null,
  email_adresat text not null,
  vytvoreno timestamptz not null default now(),
  aktualizovano timestamptz not null default now(),
  unique (rok, poradi),
  unique (cislo),
  unique (platba_id)
);
create index if not exists doklady_uhrady_rezervace_idx on doklady_uhrady (rezervace_id);

commit;

-- Kontrola po spuštění — měla by se vypsat existující (prázdná) tabulka:
select count(*) from doklady_uhrady;
