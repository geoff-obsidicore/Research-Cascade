#!/bin/bash
# PreCompact hook — flush important knowledge before context compaction
# Ensures findings/entities survive compaction

DB_PATH="${HOME}/.cascade-engine/knowledge.db"

if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# Check for active cascade with unfinished work
ACTIVE_ID=$(sqlite3 "$DB_PATH" "SELECT id FROM cascades WHERE status NOT IN ('complete') ORDER BY updated_at DESC LIMIT 1;" 2>/dev/null)

if [ -n "$ACTIVE_ID" ]; then
  echo "Pre-compaction flush for cascade $ACTIVE_ID"

  # Count unflushed items
  FINDINGS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM findings WHERE cascade_id='$ACTIVE_ID' AND quarantined=0;" 2>/dev/null)
  ENTITIES=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM kg_entities;" 2>/dev/null)

  echo "  Findings preserved: $FINDINGS"
  echo "  Entities preserved: $ENTITIES"
  echo "  Knowledge graph is safe in SQLite — survives compaction."
  echo "  Use get_status('$ACTIVE_ID') to resume after compaction."
fi
