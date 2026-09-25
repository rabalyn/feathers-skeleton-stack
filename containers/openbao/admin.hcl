# Policy for administrators' personal accounts (ADR 0023): edit secret
# values, issue agent credentials, manage the administrators' own userpass
# accounts, and start root generation, which still needs the unseal key
# shares to complete. Nothing else; anything more is done with a root token
# that is revoked afterwards.
path "kv/data/*" {
  capabilities = ["create", "read", "update", "patch"]
}
path "kv/metadata/*" {
  capabilities = ["read", "list"]
}
path "auth/approle/role/+/secret-id" {
  capabilities = ["update", "list"]
}
path "auth/approle/role/+/secret-id-accessor/destroy" {
  capabilities = ["update"]
}
path "sys/generate-root*" {
  capabilities = ["create", "read", "update", "delete", "sudo"]
}
path "auth/userpass/users/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
