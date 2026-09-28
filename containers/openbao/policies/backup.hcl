path "kv/data/backup" {
  capabilities = ["read"]
}

# OpenBao's own backup (ADR 0017, 0023): a raft snapshot, nothing else of
# the system backend.
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
