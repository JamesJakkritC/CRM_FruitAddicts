-- P1: structured member profile fields the owner asked to collect.
-- Privacy-conscious birth info: month + century (era) instead of exact DOB.
ALTER TABLE members ADD COLUMN nickname       TEXT;
ALTER TABLE members ADD COLUMN birth_month    INTEGER;  -- 1..12
ALTER TABLE members ADD COLUMN birth_century  INTEGER;  -- 1900 (1900s) | 2000 (2000s), Gregorian (ค.ศ.)
