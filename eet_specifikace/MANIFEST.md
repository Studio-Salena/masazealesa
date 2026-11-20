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
| `EET_pristupove_provozni_informace_produkce_v1_2.pdf` | v1.2 | 11.11.2026 | https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_pristupove_provozni_informace_Produk-4.pdf | `41c0b5e27770acdc355d5454d6ba9348cc4a3e32646f689d94d57d7a6e1aae99` |
| `ca_eet-root_cert-playground.crt` | — | — (kořenový certifikát CA EET 2 Playground, veřejný) | https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/ca_eet-root_cert-playground.crt | `c0257db7f2d9dde3f9413e904814a330cbd2efa41f2ab4ecd8f91f7c5f73f3b6` |
| `ca_eet-sub_cert-playground.crt` | — | — (certifikát vydavatele pokladních certifikátů Playground, veřejný) | https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/ca_eet-sub_cert-playground.crt | `28182077cb77338070e209fe9e950481d01ecbc181dfc76ecd7985bd2e0f9046` |
| `CZ00000019.eet.v4.req.xml` | — | — (oficiální vzorová PODEPSANÁ zpráva, veřejný sdílený testovací certifikát) | https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/CZ00000019.eet.v4.req.xml | `4392b4ca0e6eb586c10b6f80d8946f5269f500a5b2b0d94fa7a092ace867ade5` |
| `CZ683555118.eet.v4.req.xml` | — | — (totéž, EIČ CZ683555118) | https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/CZ683555118.eet.v4.req.xml | `a77d28641603ffd85a3bd9eff580f554e5e822741cd0594d84b48b52e7874b75` |
| `CZ8551015704.eet.v4.req.xml` | — | — (totéž, EIČ CZ8551015704) | https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/CZ8551015704.eet.v4.req.xml | `a61b6ac6cc50b908d68550aa4981b91df0f5d3cbfe564b5d60b545ef70a06bd6` |

**Krok 3d, příprava nasazení (doplněno 20.11.2026)** — DVĚ ROZDÍLNÉ, NIKDY
NEZAMĚŇOVANÉ certifikační hierarchie pro produkční prostředí:

1) CA, která vydává **NÁŠ** produkční pokladní certifikát (čím bychom
   podepisovali VLASTNÍ odchozí zprávy) — produkční protějšek
   `ca_eet-root/sub_cert-playground.crt` výše:

| Soubor | Subjekt (CN) | Zdroj (URL) | SHA-256 |
|---|---|---|---|
| `ca_eet-root_prod.pem` | EETv2 NCA Root CA RSA 09/2026 | https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/ca_eet-root_prod.pem | `462afa5e88c894ec414690baef1440419478b31c8524d5de5237a20ce305ec8b` |
| `ca_eet-sub_prod.pem` | EETv2 NCA SubCA RSA 10/2026 | https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/ca_eet-sub_prod.pem | `fd0ae27da503f70c99b85affe3c85640cfbc8569b39aef15252c415c30215800` |

2) CA, kterou **Finanční správa** podepisuje SVOJI odpověď (potvrzení/chybu)
   — čím ověřujeme PŘÍCHOZÍ zprávu (`eet/overeni-odpovedi-fs.js`). Zdroj:
   `EET_pristupove_provozni_informace_produkce_v1_2.pdf`, kap. 3.3 "Podpisový
   certifikát" — ten PDF výslovně uvádí, že potvrzovací datové zprávy podepisuje
   certifikát vydaný `CN=I.CA Public CA/RSA 06/2022` (vydavatel: Generální
   finanční ředitelství / "Společné technické zařízení správce daně EET"), a
   odkazuje na **https://www.ica.cz/korenove-certifikaty** — JINOU, samostatnou
   certifikační autoritu (První certifikační autorita, a.s.), ne eet.gov.cz:

| Soubor | Subjekt (CN) | Zdroj (URL) | SHA-256 |
|---|---|---|---|
| `ca_ica-root-ca-rsa-05-2022.pem` | I.CA Root CA/RSA 05/2022 (sebepodepsaný, platnost do 2047) | https://www.ica.cz/sites/default/files/download/2025/rca22_rsa.pem | `f72dc3232df2c9598f60c1bbc82f4bcc5acc80af73a60ed6eb3f6bd67ab473e2` |
| `ca_ica-public-ca-rsa-06-2022.pem` | I.CA Public CA/RSA 06/2022 (vydán rootem výš, platnost do 2032) | https://www.ica.cz/sites/default/files/download/2025/pca22_rsa.pem | `db03fb10906d8cc357ef2d68f2f130d6a5381de3ca9a8cbf45216350ca695116` |

Celý řetězec `ca_ica-root-ca-rsa-05-2022.pem → ca_ica-public-ca-rsa-06-2022.pem`
kryptograficky ověřen (`openssl verify -CAfile root sub` → `OK`) 20.11.2026.
Pro ověřování odpovědí FS se jako `duveryhodneKotvyPem` (viz
`eet/overeni-odpovedi-fs.js`) používá `ca_ica-public-ca-rsa-06-2022.pem` (přímý
vydavatel podpisového certifikátu FS) — root slouží jen k jednorázovému
ověření důvěryhodnosti TÉTO sub CA, ne k běžnému ověřování za provozu.

Ověření integrity: `sha256sum *.xsd *.wsdl *.pdf *.crt *.xml` v tomto
adresáři musí dát přesně hodnoty výše. Při jakékoli budoucí aktualizaci
těchto souborů (nová verze rozhraní) je nutné tuto tabulku i
`eet/specifikace.js` (strojově čitelná kopie týchž údajů) aktualizovat společně.

Tyto soubory se NIKDY neodesílají nikam po síti — používá se z nich jen
textový/XSD obsah pro lokální generování a ofline validaci, resp. (u
`CZ*.eet.v4.req.xml` a `ca_eet-*.crt`) pro ofline interoperabilní ověření
proti SKUTEČNÉ zprávě a certifikační autoritě Finanční správy (viz
`tests/eet-krok3c-interoperabilita-fs.test.js`).

**Záměrně NEstaženo do tohoto adresáře:** `CAEET_Playground_2026_v1.zip`
(obsahuje sdílené testovací PKCS#12 soubory SE SOUKROMÝMI KLÍČI a heslo k
nim). I když jde o veřejně sdílené, nijak citlivé testovací materiály (ne o
skutečné tajemství), bylo ověřeno zvlášť v dočasném adresáři mimo
repozitář a do Gitu se záměrně neukládá — `.gitignore` v kořeni projektu
navíc i tak blokuje `*.p12`/`*.pfx`/`*.pem`/`*.key`.
