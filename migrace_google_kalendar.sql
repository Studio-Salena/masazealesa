-- Jednosměrná synchronizace rezervací do osobního Google kalendáře.
-- Čistě aditivní (nový nullable sloupec), bezpečné spustit opakovaně.

alter table rezervace add column if not exists google_event_id text;
