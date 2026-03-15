#!/bin/bash
# SessionStart hook — inject cascade state into new sessions
# Checks for active cascades and prints status context

DB_PATH="${HOME}/.cascade-engine/knowledge.db"

if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# Check for active cascades
ACTIVE=$(sqlite3 "$DB_PATH" "SELECT id, question, status, current_round, max_rounds FROM cascades WHERE status NOT IN ('complete') ORDER BY updated_at DESC LIMIT 1;" 2>/dev/null)

if [ -n "$ACTIVE" ]; then
  echo "Active research cascade detected:"
  echo "$ACTIVE" | while IFS='|' read -r id question status round max_rounds; do
    echo "  ID: $id"
    echo "  Question: $question"
    echo "  Status: $status (round $round/$max_rounds)"
    echo "  Use cascade_status to check progress, or cascade_steer to redirect."
  done
fi
