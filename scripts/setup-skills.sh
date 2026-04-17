#!/usr/bin/env bash
# Setup script: registers aweek skills in .claude/commands/ for Claude Code discovery
# Run: bash scripts/setup-skills.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COMMANDS_DIR="$PROJECT_ROOT/.claude/commands"

echo "Setting up aweek skills..."

mkdir -p "$COMMANDS_DIR"

# Register hire skill (replaces the former create-agent skill 1:1)
cp "$PROJECT_ROOT/skills/aweek-hire.md" "$COMMANDS_DIR/hire.md"
echo "  ✓ Registered /aweek:hire"

# Clean up old create-agent registration from pre-refactor installs so stale
# skill metadata doesn't shadow /aweek:hire in Claude Code's command picker.
rm -f "$COMMANDS_DIR/create-agent.md"

# Register approve-plan skill
cp "$PROJECT_ROOT/skills/aweek-approve-plan.md" "$COMMANDS_DIR/approve-plan.md"
echo "  ✓ Registered /aweek:approve-plan"

# Register manage skill (consolidated replacement for resume-agent covering
# resume, top-up, pause/stop, edit-identity, and delete/archive lifecycle ops)
cp "$PROJECT_ROOT/skills/aweek-manage.md" "$COMMANDS_DIR/manage.md"
echo "  ✓ Registered /aweek:manage"

# Clean up old resume-agent registration from pre-refactor installs so stale
# skill metadata doesn't shadow /aweek:manage in Claude Code's command picker.
rm -f "$COMMANDS_DIR/resume-agent.md"

echo ""
echo "Done! Skills are now discoverable via Claude Code slash commands."
