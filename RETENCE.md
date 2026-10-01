# Retenční mechanismus — provozní postup

Krátký provozní dokument k retenčnímu/GDPR anonymizačnímu mechanismu
(Fáze 7G.3–7G.5D). Není to technická dokumentace kódu — ta je v `server.js`
u jednotlivých funkcí. Toto je návod "co dělat", pro běžný provoz.

## Co retence dělá

Podle potřeby se v administraci ručně spustí kontrola (dry-run),
která najde staré, uzavřené záznamy (dokončené/zrušené rezervace, uzavřené
nebo expirované poukazy, vyřízené/zamítnuté žádosti o poukaz, odhlášené
odběratele newsletteru, a klientky bez budoucí rezervace a bez platného
poukazu) a u nich **anonymizuje osobní údaje** (jméno, telefon, e-mail,
poznámky). Historie (datum, stav, zůstatek, částky) zůstává zachována —
nic se nemaže.

Retenční lhůty (kolik dní od uzavření záznamu se čeká, než je kandidátem)
jsou nastavené v administraci jako provozní hodnoty, ne jako tvrzená
zákonná povinnost.

## Jak často kontrolovat

Žádný automatický časový plán. Kontrola (dry-run) se spouští podle potřeby
— typicky občasně, když chce obsluha vědět, zda se nahromadili kandidáti.
Žádná anonymizace neproběhne sama od sebe.

## Přesný postup PŘED APPLY

1. Přihlásit se do administrace.
2. V sekci "Retence" spustit **Dry-run**.
3. Zkontrolovat, že všech 7 kategorií má stav `OK` (pokud je `NENASTAVENO`,
   daná kategorie se nezpracuje — to není chyba).
4. Podívat se na počet kandidátů v každé kategorii a orientačně na jejich ID.
5. Zkontrolovat, koho a proč blokuje (`budouci_rezervace` / `platny_poukaz`)
   — blokace klientek dávají smysl.
6. Posoudit, jestli počet kandidátů odpovídá očekávání (viz "Kdy STOP" níže).
7. Teprve pak ručně potvrdit a spustit **APPLY**.

APPLY vždy vyžaduje ruční potvrzení v administraci. Nic se neděje samo.

## Co kontrolovat PO APPLY

Odpověď po APPLY obsahuje:

- **zpracovano** — kolik kandidátů bylo v tomto běhu vyhodnoceno.
- **uspesnych** — kolik z nich bylo skutečně anonymizováno.
- **preskoceno** — seznam přeskočených a proč (typicky proto, že se mezitím
  něco změnilo — např. poukaz byl vrácen do platného stavu). Není to chyba
  systému, je to doklad, že se vždy znovu ověřuje aktuální stav.
- **limit_dosazen** — viz níže.

Po APPLY je dobré zkontrolovat i `retence_udalosti` (auditní log) —
dnes bez UI, kontroluje se přímo v databázi.

## Co znamená limit 25

Jeden běh APPLY zpracuje nejvýš 25 kandidátů celkem (napříč všemi
kategoriemi). Pokud `limit_dosazen = true`:

- Není to chyba.
- Zbylí kandidáti nejsou v tomto běhu zpracováni, zůstávají beze změny.
- Objeví se znovu v dalším dry-run.
- Před dalším APPLY udělat znovu dry-run (ne spouštět APPLY naslepo podruhé).
- Limit se nikdy neobchází ručním zásahem do databáze.

## Kdy STOP (neprovádět APPLY)

- Dry-run vrátí chybu nebo neočekávaný formát odpovědi.
- Počet kandidátů je nápadně vyšší, než se čekalo.
- V kandidátech je něco, co tam nedává smysl (např. kategorie, kde se
  žádní kandidáti nečekali).
- Není jisté, jestli se pracuje s produkcí, nebo testovacím prostředím.
- Cokoli jiného je nejasné.

V takovém případě: nejdřív zjistit proč, žádný APPLY, dokud to není jasné.

## Co kontrolovat v retence_udalosti

Auditní log obsahuje pro každou skutečnou anonymizaci: typ objektu, jeho
ID, klientku (pokud relevantní), spouštěč (`rucne`), že nejde o dry-run,
důvod (která retenční lhůta) a čas. Kontroluje se hlavně po APPLY (že počet
nových záznamů odpovídá `uspesnych`) a kdykoli při podezření, že se stalo
něco neočekávaného.

## Co dělat při chybě

Každý záznam se anonymizuje ve vlastní krátké transakci. Pokud se u jednoho
záznamu nepodaří změnu dokončit, jeho transakce se vrátí zpět (ROLLBACK)
a ostatní záznamy mohou pokračovat. Položka `preskoceno` slouží zejména
pro případy, kdy čerstvá kontrola zjistí, že kandidát už aktuálně podmínky
nesplňuje.

Při chybě celého APPLY (HTTP chyba, výpadek apod.) nespouštět APPLY znovu
automaticky. Nejdřív provést nový dry-run a zjistit aktuální stav.

## Co nikdy nedělat

- Nespouštět APPLY opakovaně "pro jistotu".
- Neobcházet limit 25 ručním zásahem do databáze.
- Neanonymizovat nic přímo SQL příkazem mimo APPLY endpoint.
- Nezavádět `retence_klientka_dny` — klientka nemá vlastní retenční lhůtu.
  Její způsobilost k anonymizaci se posuzuje podle toho, zda nemá blokující
  budoucí rezervaci ani platný poukaz.
- Nenastavovat automatický APPLY (cron smí jen reportovat, nikdy mazat/
  anonymizovat).

## Při změně retenčních hodnot

Změna retenční lhůty (např. `retence_newsletter_dny`) mění, kdo se příště
objeví jako kandidát. Po každé změně hodnoty je potřeba udělat nový
dry-run a posoudit výsledek, než se spustí další APPLY.
