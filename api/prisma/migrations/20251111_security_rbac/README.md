## Migration `20251111_security_rbac`

- Adds RBAC tables (`roles`, `permissions`, `role_permissions`, `user_roles`).
- Introduces `security_audit_logs` for compliance auditing.
- Removes legacy `role` column from `users`.

