-- FO-011D infrastructure and deployment inventory.
--
-- Metadata only. These tables do not open a shell, a container runtime, or
-- a network check, and they do not store credentials. 079 is reserved for
-- FO-010A and is intentionally not created here.
--
-- A resource is independent of any one cluster. Links are many-to-many.
-- Deleting a registered project removes that project's links only.
-- environment_profiles is the Environment Manager and is not referenced.

CREATE TABLE IF NOT EXISTS infrastructure_resources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  provider TEXT,
  description TEXT NOT NULL DEFAULT '',
  hostname TEXT,
  ip_address TEXT,
  environment TEXT,
  environment_custom TEXT,
  region TEXT,
  cost_amount TEXT,
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'not-verified',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (length(trim(name)) BETWEEN 1 AND 160),
  CHECK (resource_type IN (
    'local-development',
    'vps',
    'cloud',
    'docker-host',
    'database',
    'domain',
    'deployment-environment',
    'cicd',
    'other'
  )),
  CHECK (provider IS NULL OR length(trim(provider)) BETWEEN 1 AND 120),
  CHECK (length(description) <= 4000),
  CHECK (hostname IS NULL OR (
    length(hostname) BETWEEN 1 AND 253
    AND instr(hostname, ' ') = 0
    AND instr(hostname, '/') = 0
    AND instr(hostname, '@') = 0
  )),
  CHECK (ip_address IS NULL OR length(ip_address) BETWEEN 2 AND 45),
  CHECK (environment IS NULL OR environment IN ('local', 'development', 'staging', 'production', 'custom')),
  CHECK (
    (environment IS NULL AND environment_custom IS NULL)
    OR (environment = 'custom' AND environment_custom IS NOT NULL AND length(trim(environment_custom)) BETWEEN 1 AND 80)
    OR (environment IS NOT NULL AND environment != 'custom' AND environment_custom IS NULL)
  ),
  CHECK (region IS NULL OR length(trim(region)) BETWEEN 1 AND 80),
  CHECK (cost_amount IS NULL OR length(cost_amount) BETWEEN 1 AND 16),
  CHECK (currency IS NULL OR (length(currency) = 3 AND currency = upper(currency))),
  CHECK (status IN ('unknown', 'not-verified')),
  CHECK (length(notes) <= 8000)
);

CREATE INDEX IF NOT EXISTS infrastructure_resources_type
  ON infrastructure_resources(resource_type, archived_at);

CREATE TABLE IF NOT EXISTS infrastructure_cluster_links (
  resource_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (resource_id, cluster_id),
  FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE CASCADE,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS infrastructure_cluster_links_cluster
  ON infrastructure_cluster_links(cluster_id);

CREATE TABLE IF NOT EXISTS infrastructure_project_links (
  resource_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (resource_id, project_path),
  FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE CASCADE,
  FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS infrastructure_project_links_project
  ON infrastructure_project_links(project_path);

-- Where the owner expects a registered project to run. This is a declaration.
-- It is not an Environment Manager profile and it is not a deployment.
CREATE TABLE IF NOT EXISTS infrastructure_project_environments (
  project_path TEXT NOT NULL,
  environment TEXT NOT NULL,
  custom_label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_path, environment, custom_label),
  FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE,
  CHECK (environment IN ('local', 'development', 'staging', 'production', 'custom')),
  CHECK (
    (environment = 'custom' AND length(trim(custom_label)) BETWEEN 1 AND 80)
    OR (environment != 'custom' AND custom_label = '')
  )
);

-- Binds one inventory resource to one declared project environment.
CREATE TABLE IF NOT EXISTS infrastructure_environment_links (
  resource_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  environment TEXT NOT NULL,
  custom_label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (resource_id, project_path, environment, custom_label),
  FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE CASCADE,
  FOREIGN KEY (project_path, environment, custom_label)
    REFERENCES infrastructure_project_environments(project_path, environment, custom_label)
    ON DELETE CASCADE
);
