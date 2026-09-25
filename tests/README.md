# Testy

Bez nových závislostí (jen vestavěný Node `assert` a `fetch`).

- `xss.test.js` — statický test + unit test escapování. Neběží proti síti, spustit stačí:
  ```
  node tests/xss.test.js
  ```

- `poukazy.test.js`, `ucetnictvi.test.js` — integrační testy proti nasazenému API (produkce).
  Vytváří si vlastní testovací data a na konci je vždy smaže. Potřebují admin heslo v proměnné prostředí:
  ```
  ADMIN_HESLO=... node tests/poukazy.test.js
  ADMIN_HESLO=... node tests/ucetnictvi.test.js
  ```
  Heslo se nikam neukládá, jen se přečte při spuštění.
