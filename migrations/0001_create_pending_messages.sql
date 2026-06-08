CREATE TABLE IF NOT EXISTS pending_messages (
  jid TEXT PRIMARY KEY,
  senderName TEXT,
  chatName TEXT,
  chatType TEXT,
  receivedAtISO TEXT,
  deadlineISO TEXT,
  notified INTEGER
);
