-- Migrace: idempotentní klíč plateb (ochrana proti duplicitnímu zápisu při
-- opakování stejného požadavku na PATCH /api/admin/rezervace/:id/platba —
-- ztracené potvrzení spojení nebo dvojklik v dialogu "Dokončit masáž" /
-- tlačítku "Zaznamenat platbu").
--
-- PŘIPRAVENO PRO POZDĚJŠÍ PRODUKČNÍ NASAZENÍ — ZATÍM NESPOUŠTĚT NA PRODUKCI.
-- Aplikováno a ověřeno zatím jen na TEST databázi (viz tests/idempotence-plateb.test.js).
--
-- Bezpečnostní vlastnosti:
--   - Nepovinný sloupec (žádné NOT NULL, žádný default jiný než NULL) —
--     žádný dopad na stávající zápisy, které idempotency_klic neposílají.
--   - Historické řádky (idempotency_klic IS NULL) se vůbec neúčastní
--     unikátního indexu (partial index "WHERE idempotency_klic IS NOT
--     NULL") — žádná kolize mezi nimi, žádný backfill, žádná změna
--     existujících hodnot. "ADD COLUMN" bez výchozí hodnoty navíc v
--     Postgresu nepřepisuje existující řádky (jen metadata), takže u
--     tabulky "platby" neprobíhá žádný rewrite dat.
--   - IF NOT EXISTS na obou příkazech — bezpečné spustit i opakovaně,
--     nespadne (a nic nezmění), pokud už migrace jednou proběhla.
--   - lock_timeout — pokud by byla tabulka "platby" právě zamčená jinou
--     operací, příkaz se po 3 vteřinách vzdá a selže (nic se nezmění), ne
--     že by visel a blokoval běžný provoz.
--   - ALTER + CREATE INDEX v jedné transakci (BEGIN/COMMIT) — buď proběhne
--     obojí, nebo nic. Záměrně BEZ "CONCURRENTLY" u indexu: CONCURRENTLY
--     nejde spustit uvnitř transakce a při chybě by mohl zůstat "invalid"
--     index vyžadující ruční úklid; tabulka "platby" je malá (jednosalonový
--     provoz), takže krátké zamčení zápisů po dobu vytvoření indexu
--     (zlomek vteřiny) je přijatelnější než riziko napolo hotové migrace.
--
-- Kontrola konfliktů PŘED touto migrací (provedena čtecím dotazem na
-- produkční schéma, žádná data nebyla čtena ani měněna):
--   - Sloupec "platby.idempotency_klic" na produkci NEEXISTUJE.
--   - Index "platby_idempotency_klic_idx" na produkci NEEXISTUJE.
--   - Tabulka "platby" má dnes na produkci jen: id, rezervace_id, castka,
--     typ, zpusob_platby, poukaz_id, vytvoreno — přesně odpovídá TEST
--     databázi před touto migrací, žádný neočekávaný sloupec/index navíc.
--   - Žádný jiný index na "platby" kromě primárního klíče (platby_pkey).
--   Tahle kontrola je ale jen momentka — před SKUTEČNÝM spuštěním migrace
--   ji zopakovat (schéma produkce se mezitím teoreticky mohlo změnit jiným
--   zásahem), ne spoléhat na starý výsledek.
--
-- Ověření zálohy (provedeno): existující záloha "masazealesa_zaloha_*.dump"
-- byla ověřena jako ČITELNÁ (pg_restore --list, 825 TOC entries) i
-- OBNOVITELNÁ (plná zkušební obnova do zahozené databáze na TEST projektu —
-- aplikační tabulky rezervace/platby/poukazy/klientky/prodeje obsahovaly po
-- obnově správná data; zahozená databáze byla po ověření smazána). Tahle
-- konkrétní záloha ale v okamžiku skutečného nasazení bude už stará —
-- VŽDY udělat NOVOU zálohu bezprostředně před migrací (krok 1 níž), ne
-- spoléhat na starší.
--
-- Postup nasazení (až bude schváleno):
--   1. NOVÁ záloha produkční databáze (stejný postup jako u Etapy 2) —
--      bezprostředně před migrací, ne starší záloha.
--   2. Zopakovat kontrolu konfliktů výš na AKTUÁLNÍM produkčním schématu.
--   3. Spustit tento skript: psql "$DATABASE_URL" -f migrace_idempotency_klic.sql
--      — výstup obsahuje kontroly PŘED i PO, projít je ručně.
--      Pokud SET lock_timeout způsobí chybu (tabulka je zamčená jinou
--      operací) nebo "PO" kontrola neukáže sloupec i index jako existující,
--      nebo se počet řádků v "platby" / počet řádků s klíčem změnil
--      neočekávaně → ZASTAVIT SE, nic dalšího nenasazovat, popsat stav.
--   4. Teprve POTOM nasadit nový server.js + admin.html společně (stejné
--      pořadí jako u Etapy 2 — databáze první, kód až po ověřené migraci;
--      nový server.js bez migrace by spadl, protože INSERT do "platby" už
--      počítá se sloupcem idempotency_klic).
--   5. Po nasazení jen ČTECÍ a vizuální kontroly (žádné zkušební platby,
--      dokončování rezervací ani vytváření prodejů) — viz hlášení k etapě
--      idempotentního klíče.

-- Bezpečné ukončení při JAKÉKOLIV SQL chybě — bez tohoto by psql ve
-- výchozím nastavení chybu jen vypsal a POKRAČOVAL dalším příkazem ve
-- skriptu (i přes BEGIN/COMMIT níž, který sám o sobě chrání DATABÁZI před
-- napolo hotovou změnou, by bez tohoto mohl operátor přehlédnout, že něco
-- selhalo, v dlouhém výstupu). S "ON_ERROR_STOP on" psql při první chybě
-- okamžitě skončí s nenulovým návratovým kódem.
\set ON_ERROR_STOP on

set lock_timeout = '3s';

-- Kontrola PŘED migrací — BEZ JAKÉKOLIV reference na sloupec
-- "idempotency_klic" samotný, protože ještě nemusí existovat. Důležité:
-- v obyčejném SQL (na rozdíl od dynamického SQL v PL/pgSQL s EXECUTE) se
-- sloupce v dotazu překládají UŽ PŘI PŘÍPRAVĚ dotazu, ne až při běhu — i
-- "CASE WHEN EXISTS(...) THEN (select ... where idempotency_klic ...)
-- ELSE 0 END" by Postgres odmítl referencí na neexistující sloupec, i
-- kdyby se ta větev za běhu nikdy nevykonala. Proto se tu sloupec
-- NEZMIŇUJE VŮBEC — jen se zjišťuje jeho EXISTENCE (přes
-- information_schema, což je metadata dotaz, bezpečný i když sloupec
-- neexistuje) a počet řádků se počítá přes COUNT(*), bez odkazu na
-- konkrétní sloupce.
select exists(
  select 1 from information_schema.columns where table_name='platby' and column_name='idempotency_klic'
) as pred_sloupec_existuje;
select exists(
  select 1 from pg_indexes where tablename='platby' and indexname='platby_idempotency_klic_idx'
) as pred_index_existuje;
select count(*) as pred_celkem_radku from platby;
-- Počet řádků s vyplněným klíčem PŘED migrací je logickou jistotou 0 (ten
-- sloupec ještě neexistuje) — skutečná kontrola "po_radku_s_klicem" je až
-- PO migraci níž, kde sloupec už evidentně existuje (viz požadavek: počet
-- plateb s vyplněným klíčem se kontroluje až PO vytvoření sloupce).

begin;
alter table platby add column if not exists idempotency_klic text;
create unique index if not exists platby_idempotency_klic_idx on platby (idempotency_klic) where idempotency_klic is not null;
commit;

-- Kontrola PO migraci — SKUTEČNÁ DEFINICE sloupce (musí být: data_type=text,
-- is_nullable=YES, column_default=NULL) a indexu (musí obsahovat přesně
-- "WHERE (idempotency_klic IS NOT NULL)"), ne jen holá existence. Obě
-- SELECT níž musí vrátit přesně JEDEN řádek — pokud vrátí 0 řádků, migrace
-- se nepovedla; pokud by se definice lišila od výš popsané, ZASTAVIT SE a
-- nic dalšího nenasazovat. "po_celkem_radku" se MUSÍ přesně shodovat s
-- "pred_celkem_radku" (migrace nesmí přidat ani smazat žádný řádek);
-- "po_radku_s_klicem" u ČISTÉ migrace na dřív nemigrované databázi má
-- vyjít 0 (žádný historický řádek klíč nedostal).
select column_name, data_type, is_nullable, column_default
  from information_schema.columns where table_name='platby' and column_name='idempotency_klic';
select indexname, indexdef
  from pg_indexes where tablename='platby' and indexname='platby_idempotency_klic_idx';
select
  (select count(*) from platby) as po_celkem_radku,
  (select count(*) from platby where idempotency_klic is not null) as po_radku_s_klicem;
