-- FO-OWNER-LOCAL01. Public fingerprint of the certificate that signed the
-- application at enrollment. This is not a private key. A restored or edited
-- row cannot change which certificate is allowed to use an existing enrollment.
ALTER TABLE owner_trust_enrollments ADD COLUMN signing_cert_sha256 TEXT;
