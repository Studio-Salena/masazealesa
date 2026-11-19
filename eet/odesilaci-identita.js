// Pravidla pro OPAKOVANÉ odesílání (Krok 3c, bod 5): co se mezi pokusy smí a
// nesmí měnit. Dvě různé věci se často pletou dohromady — tenhle modul je
// úmyslně odděluje:
//
//   IDENTITA TRŽBY (nemění se NIKDY mezi pokusy o tutéž evidovanou tržbu):
//     eic_popl, id_jednotky, id_pokl, porad_cis, dat_trzby, celk_trzba,
//     urceno_cerp_zuct, cerp_zuct — to je oficiální deduplikační klíč
//     finanční správy (rozhraní v1.2, §3.3.3.10: (eic_popl, id_jednotky,
//     id_pokl, porad_cis, dat_trzby)) a už je to vynucené na DB úrovni
//     (schema.sql: UNIQUE(id_jednotky, id_pokl, porad_cis, dat_trzby) +
//     trigger evidovana_trzba_chranit_po_odeslani).
//
//   UUID ZPRÁVY (MUSÍ se změnit při KAŽDÉM pokusu, i opakovaném):
//     "Nové UUID datové zprávy musí být vytvořeno a použito i v případech,
//     kdy dochází k opakovanému zaslání datové zprávy" (popis položek
//     datové zprávy, bod 1) — nikdy nejde použít uuid_zpravy předchozího
//     pokusu znovu, ani při stornu/opravě.
//
// Toto je čistě lokální rozhodovací logika (žádné DB/síťové volání) — volá
// se s už načtenými daty (počet předchozích řádků eet_odeslani pro danou
// evidovanou tržbu), ne s připojením na databázi.

const POLE_IDENTITY_TRZBY = [
  'id_jednotky', 'id_pokl', 'porad_cis', 'dat_trzby',
  'celk_trzba', 'smer', 'urceno_cerp_zuct', 'cerp_zuct'
];

// Je tohle první pokus o odeslání dané evidované tržby? (true jen pokud
// ještě neexistuje ŽÁDNÝ řádek eet_odeslani pro ni — ne podle toho, jestli
// předchozí pokus byl úspěšný, neúspěšný, nebo nejistý.)
function jeToPrvniZaslani(pocetPredchozichPokusu) {
  if (!Number.isInteger(pocetPredchozichPokusu) || pocetPredchozichPokusu < 0) {
    throw new Error(`pocetPredchozichPokusu musí být nezáporné celé číslo, dostal jsem: ${pocetPredchozichPokusu}`);
  }
  return pocetPredchozichPokusu === 0;
}

// Vrátí parametry hlaviček pro DALŠÍ pokus o odeslání téže evidované tržby.
// "trzba" se nijak nemění — jen se z ní (ne)odvozuje prvni_zaslani.
function dalsiPokusOdeslani(trzba, pocetPredchozichPokusu) {
  return {
    prvniZaslani: jeToPrvniZaslani(pocetPredchozichPokusu),
    // dat_trzby (okamžik USKUTEČNĚNÍ tržby) se při opakování NEMĚNÍ — jen
    // dat_odesl (okamžik ODESLÁNÍ zprávy) je pokaždé nový, to řeší
    // xml-zprava.js automaticky (datOdeslani default = teď).
    datTrzby: trzba.dat_trzby
  };
}

// Porovná identitu tržby mezi dvěma "snapshoty" (např. při pokusu o
// vytvoření druhého pokusu s jinými parametry) — aplikační zrcadlo DB
// triggeru evidovana_trzba_chranit_po_odeslani, pro časnou a jasnou chybovou
// zprávu ještě PŘED tím, než by to odmítla databáze.
function overitNezmenenouIdentitu(puvodni, novy) {
  const zmeny = POLE_IDENTITY_TRZBY.filter((pole) => {
    const a = puvodni[pole] ?? null;
    const b = novy[pole] ?? null;
    return String(a) !== String(b);
  });
  if (zmeny.length > 0) {
    throw new Error(
      `Identita evidované tržby se mezi pokusy o odeslání nesmí měnit. Změněná pole: ${zmeny.join(', ')}.`
    );
  }
  return true;
}

module.exports = { POLE_IDENTITY_TRZBY, jeToPrvniZaslani, dalsiPokusOdeslani, overitNezmenenouIdentitu };
