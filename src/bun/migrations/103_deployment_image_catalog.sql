-- FO-DEPLOY03: optional Owner-configured published-images catalog path for LF staging.

ALTER TABLE deployment_staging_integrations ADD COLUMN images_catalog_ref TEXT;
