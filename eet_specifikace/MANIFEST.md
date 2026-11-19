# Oficiální podklady EET 2.0 — Krok 3c (Fáze A)

Tyto soubory jsou staženy přímo z **https://eet.gov.cz** (sekce "Pro vývojáře" →
"Dokumenty ke stažení"), bez přihlášení, 19.11.2026. Slouží jako jediný zdroj
pravdy pro generování a lokální validaci XML zpráv v `eet/` — žádná hodnota
v `eet/xml-zprava.js` ani `eet/xsd-validace.js` není "odhadnutá", vychází buď
přímo z `EETXMLSchema.xsd`, nebo z textu `EET_popis_rozhrani_v1.2.pdf` /
`EET_popis_polozek_datove_zpravy.pdf` níže.

| Soubor | Verze | Datum poslední verze | Zdroj (URL) | SHA-256 |
|---|---|---|---|---|
| `EETXMLSchema.xsd` | rozhraní 4.1 | — (příloha technické specifikace v1.2) | https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EETXMLSchema.xsd | `83597d08520cbfab7e51145df9a765d5ca22e2f9a38644a468d695657c7a032a` |
| `EETServiceSOAP.wsdl` | rozhraní 4.1 | — (příloha technické specifikace v1.2) | https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EETServiceSOAP.wsdl | `df149c0bef4ac18c2a6e82116b6eb9bb17d29c055cb0821ac6d3885ec90faeb4` |
| `EET_popis_rozhrani_v1.2.pdf` | v1.2 | 25.08.2026 | https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_popis_rozhrani_v1.2.pdf | `c986e85686927e1e153aee0f33090fd6fda80d09b44e564d8b344dde729b1a1e` |
| `EET_popis_polozek_datove_zpravy.pdf` | v1.0 | 05.10.2026 | https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_popis_polozek_datove_zpravy.pdf | `de09d084688e871c639b2813ed30ba77e838667f16ec94604b6a3f4df2c3576f` |
| `EET_pristupove_provozni_informace_playground_1_2.pdf` | v1.2 | 11.11.2026 | https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_pristupove_provozni_informace_playgr-4.pdf | `2a5deacd6440a6550f0719c595f3638b3a8f7044c741578b84da2e9a42708f3e` |

Ověření integrity: `sha256sum *.xsd *.wsdl *.pdf` v tomto adresáři musí dát
přesně hodnoty výše. Při jakékoli budoucí aktualizaci těchto souborů (nová
verze rozhraní) je nutné tuto tabulku i `eet/specifikace.js` (strojově čitelná
kopie týchž údajů) aktualizovat společně.

Tyto soubory se NIKDY neodesílají nikam po síti — používá se z nich jen
textový/XSD obsah pro lokální generování a ofline validaci.
