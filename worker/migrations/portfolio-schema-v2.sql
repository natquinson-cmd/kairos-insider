-- Migration : portfolio v2 (25 avril 2026)
-- Ajoute 2 colonnes pour stocker le nom lisible de l'instrument et sa
-- classification (action / indice / forex / commodity / etc.).
-- Permet d'afficher dans l'UI un libellé clair même quand ticker_kairos = null
-- (cas des CFD indices, forex, commodities qui ne sont pas dans la base Kairos
-- mais qu'on veut quand même montrer à l'utilisateur).

ALTER TABLE portfolio_positions ADD COLUMN instrument_name TEXT;
ALTER TABLE portfolio_positions ADD COLUMN instrument_class TEXT;
